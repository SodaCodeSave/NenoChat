import type { Sticker, StickerPackImportResult, StickerPackWithStickers } from '@nenochat/shared'
import { MAX_STICKER_PACK_FILES } from '@nenochat/shared'
import { Unzip, UnzipInflate } from 'fflate'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as stickersRepo from '../db/repo/stickers'
import * as attachmentsRepo from '../db/repo/attachments'
import { saveUpload } from './file-service'
import { err } from '../util/errors'
import { hub } from '../ws/hub'

function mapSticker(row: stickersRepo.StickerListRow | stickersRepo.StickerRow): Sticker {
  const withAttachment = row as stickersRepo.StickerListRow
  let keywords: string[] = []
  if (row.keywords) {
    try {
      const parsed = JSON.parse(row.keywords)
      if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string')
    } catch {
      /* 关键词是可选字段，坏数据不该让整个表情包读不出来 */
    }
  }

  return {
    id: row.id,
    packId: row.pack_id,
    kind: row.kind as Sticker['kind'],
    value: row.value,
    attachmentId: row.attachment_id,
    url: withAttachment.storage_key ? `/files/${withAttachment.storage_key}` : null,
    keywords,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPack(row: stickersRepo.StickerPackRow): StickerPackWithStickers['pack'] {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    kind: row.kind as 'emoji' | 'image',
    allowAi: row.allow_ai === 1,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 列出当前用户的表情包。首次调用会自动建一个默认分组，
 * 否则「上传表情」在新账号上没有落点。
 */
export function listPacks(db: DB, userId: string): StickerPackWithStickers[] {
  let packs = stickersRepo.listPacks(db, userId)

  if (!packs.some((pack) => pack.owner_id === userId)) {
    stickersRepo.createPack(db, { ownerId: userId, name: stickersRepo.DEFAULT_PACK_NAME })
    packs = stickersRepo.listPacks(db, userId)
  }

  const stickers = stickersRepo.listStickers(db, packs.map((pack) => pack.id))
  const grouped = new Map<string, Sticker[]>()
  for (const row of stickers) {
    const list = grouped.get(row.pack_id) ?? []
    list.push(mapSticker(row))
    grouped.set(row.pack_id, list)
  }

  return packs.map((pack) => ({
    pack: mapPack(pack),
    stickers: grouped.get(pack.id) ?? [],
  }))
}

export function createPack(db: DB, userId: string, name: string): StickerPackWithStickers {
  const count = stickersRepo.listPacks(db, userId).filter((p) => p.owner_id === userId).length
  const row = stickersRepo.createPack(db, { ownerId: userId, name, position: count })

  hub().sendToUser(userId, 'stickerPack.upserted', { pack: mapPack(row) })

  return { pack: mapPack(row), stickers: [] }
}

export function renamePack(db: DB, userId: string, packId: string, name: string): StickerPackWithStickers['pack'] {
  const pack = stickersRepo.findPack(db, packId)
  if (!pack || pack.owner_id !== userId) throw err.notFound('表情包不存在')

  stickersRepo.renamePack(db, packId, name)
  const updated = stickersRepo.findPack(db, packId) as stickersRepo.StickerPackRow
  hub().sendToUser(userId, 'stickerPack.upserted', { pack: mapPack(updated) })
  return mapPack(updated)
}

/** 改名与 AI 授权开关共用；多端通过 WS 事件同步开关状态 */
export function updatePack(
  db: DB,
  userId: string,
  packId: string,
  patch: { name?: string; allowAi?: boolean },
): StickerPackWithStickers['pack'] {
  const pack = stickersRepo.findPack(db, packId)
  if (!pack || pack.owner_id !== userId) throw err.notFound('表情包不存在')

  stickersRepo.updatePack(db, packId, patch)
  const updated = stickersRepo.findPack(db, packId) as stickersRepo.StickerPackRow
  const mapped = mapPack(updated)
  hub().sendToUser(userId, 'stickerPack.upserted', { pack: mapped })
  return mapped
}

export function deletePack(db: DB, userId: string, packId: string): void {
  const pack = stickersRepo.findPack(db, packId)
  if (!pack || pack.owner_id !== userId) throw err.notFound('表情包不存在')
  if (stickersRepo.countInPack(db, packId) > 0) {
    throw err.validation('分组里还有表情，请先清空再删除')
  }

  stickersRepo.deletePack(db, packId)
  hub().sendToUser(userId, 'stickerPack.removed', { packId })
}

export function addSticker(
  db: DB,
  userId: string,
  input: { packId: string; attachmentId: string; keywords: string[] },
): Sticker {
  const pack = stickersRepo.findPack(db, input.packId)
  if (!pack || pack.owner_id !== userId) throw err.notFound('表情包不存在')

  const attachment = attachmentsRepo.findById(db, input.attachmentId)
  if (!attachment) throw err.validation('文件不存在或已删除')
  if (attachment.owner_id !== userId) throw err.forbidden('不能引用他人的文件')
  if (!attachment.mime.startsWith('image/')) throw err.validation('表情必须是图片')

  const row = withTx(db, () =>
    stickersRepo.createSticker(db, {
      packId: input.packId,
      kind: attachment.mime === 'image/gif' ? 'gif' : 'image',
      attachmentId: input.attachmentId,
      keywords: input.keywords,
      position: stickersRepo.countInPack(db, input.packId),
    }),
  )

  const sticker = mapSticker({ ...row, storage_key: attachment.storage_key, mime: attachment.mime, filename: attachment.filename, size: attachment.size } as stickersRepo.StickerListRow)
  hub().sendToUser(userId, 'sticker.upserted', { sticker })
  return sticker
}

export function deleteSticker(db: DB, userId: string, stickerId: string): void {
  const sticker = stickersRepo.findSticker(db, stickerId)
  if (!sticker) throw err.notFound('表情不存在')

  const pack = stickersRepo.findPack(db, sticker.pack_id)
  if (!pack || pack.owner_id !== userId) throw err.forbidden('不能删除他人的表情')

  stickersRepo.deleteSticker(db, stickerId)
  hub().sendToUser(userId, 'sticker.removed', { stickerId })
}

/** 覆写表情关键词：本机识图分析完成后回传，或服务端分析写回 */
export function updateStickerKeywords(
  db: DB,
  userId: string,
  stickerId: string,
  keywords: string[],
): Sticker {
  const sticker = stickersRepo.findSticker(db, stickerId)
  if (!sticker) throw err.notFound('表情不存在')
  const pack = stickersRepo.findPack(db, sticker.pack_id)
  if (!pack || pack.owner_id !== userId) throw err.forbidden('不能修改他人的表情')

  stickersRepo.updateStickerKeywords(db, stickerId, keywords)
  const updated = stickersRepo.findSticker(db, stickerId) as stickersRepo.StickerRow
  const attachment = sticker.attachment_id ? attachmentsRepo.findById(db, sticker.attachment_id) : null
  const mapped = mapSticker({
    ...updated,
    storage_key: attachment?.storage_key ?? null,
    mime: attachment?.mime ?? null,
    filename: attachment?.filename ?? null,
    size: attachment?.size ?? null,
  } as stickersRepo.StickerListRow)
  hub().sendToUser(userId, 'sticker.upserted', { sticker: mapped })
  return mapped
}

/* --------------------------- AstrBot 表情包导入 --------------------------- */

/** 表情包里允许出现的图片扩展名 */
const PACK_IMAGE_MIME = new Map<string, string>([
  ['gif', 'image/gif'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
])

/** manifest.json 里只用到包名与分类描述 */
interface AstrbotManifest {
  name?: unknown
  categories?: Record<string, { description?: unknown }>
}

function isPackImage(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext !== undefined && PACK_IMAGE_MIME.has(ext)
}

function normalizeEntryPath(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 流式遍历 zip：图片动辄几 MB，整包解压结果不能一次性留在内存里，
 * 所以只把 filter 命中的条目交给回调，其余条目的数据边读边丢。
 */
function walkZip(zip: Buffer, filter: (path: string) => boolean, onEntry: (path: string, data: Buffer) => void): void {
  const unzip = new Unzip((file) => {
    const path = normalizeEntryPath(file.name)
    const keep = filter(path)
    const chunks: Uint8Array[] = []
    file.ondata = (error, chunk, final) => {
      if (error) throw error
      if (!keep) return
      if (chunk.length > 0) chunks.push(chunk)
      if (final) onEntry(path, Buffer.concat(chunks))
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  unzip.push(new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength), true)
}

/**
 * 从分类描述里提取短标签，例如
 * 「塔菲生气、叉腰的场合，例如被惹到…」→ [塔菲生气, 叉腰, 被惹到]
 */
const TAG_SPLIT = /[、，,。；;：:（）()【】\[\]\s/]+/
const TAG_PREFIX = /^(?:例如|比如|用于|适合|如|像)/
const TAG_SUFFIX = /(?:的场合|的场景|的时候|时使用|场合|场景|时|等)$/

function extractTags(description: unknown): string[] {
  if (typeof description !== 'string') return []
  const out: string[] = []
  for (const raw of description.split(TAG_SPLIT)) {
    const tag = raw.trim().replace(TAG_PREFIX, '').replace(TAG_SUFFIX, '').trim()
    if (tag.length < 2 || tag.length > 24) continue
    if (!out.includes(tag)) out.push(tag)
    if (out.length >= 4) break
  }
  return out
}

/** 分类名（英文 slug）+ 描述里提取的中文标签，AI 挑表情时按这些匹配 */
function buildKeywords(category: string, description: unknown): string[] {
  const out: string[] = []
  if (category) out.push(category.toLowerCase())
  for (const tag of extractTags(description)) {
    if (!out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 10)
}

/** 同名分组自动加 (2)、(3) 后缀，重复导入不会覆盖已有表情 */
function uniquePackName(db: DB, userId: string, base: string): string {
  const names = new Set(
    stickersRepo
      .listPacks(db, userId)
      .filter((pack) => pack.owner_id === userId)
      .map((pack) => pack.name),
  )
  const trimmed = base.trim().slice(0, 40) || '导入的表情包'
  if (!names.has(trimmed)) return trimmed
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${trimmed.slice(0, 36)} (${i})`
    if (!names.has(candidate)) return candidate
  }
  return `${trimmed.slice(0, 30)} ${Date.now()}`
}

/**
 * 导入 AstrBot 格式的表情包 zip。
 *
 * 目录约定：manifest.json 与 memes/<分类>/<图片> 同级，
 * 整包可能再套一层文件夹（解压后的仓库目录），按 manifest 的位置推根前缀。
 * 分类名进关键词，manifest 里的中文描述提取成短标签一起写进去。
 */
export function importAstrbotPack(db: DB, userId: string, zip: Buffer): StickerPackImportResult {
  // 第一遍：找 manifest、按上限预检图片数量（数据随读随丢，不驻留内存）
  const manifests: Array<{ path: string; data: Buffer }> = []
  let imageCount = 0
  walkZip(
    zip,
    (path) => path.endsWith('manifest.json') || isPackImage(path),
    (path, data) => {
      if (path.endsWith('manifest.json')) manifests.push({ path, data })
      else imageCount += 1
    },
  )

  // 根目录下的 manifest 才是包描述，嵌套更深的可能是示例或子包
  const manifestEntry = manifests.sort((a, b) => a.path.length - b.path.length)[0]
  if (!manifestEntry) throw err.validation('压缩包里找不到 manifest.json，不是 AstrBot 表情包')
  if (imageCount === 0) throw err.validation('压缩包里没有表情图片')

  let manifest: AstrbotManifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as AstrbotManifest
  } catch {
    throw err.validation('manifest.json 解析失败，压缩包可能已损坏')
  }

  const rootPrefix = manifestEntry.path.slice(0, -'manifest.json'.length)
  const memesPrefix = `${rootPrefix}memes/`
  const packName = typeof manifest.name === 'string' ? manifest.name : '导入的表情包'

  const ownedCount = stickersRepo.listPacks(db, userId).filter((pack) => pack.owner_id === userId).length
  const pack = stickersRepo.createPack(db, {
    ownerId: userId,
    name: uniquePackName(db, userId, packName),
    position: ownedCount,
  })

  // 第二遍：逐张落盘并建表情记录
  let matched = 0
  let imported = 0
  let skipped = 0
  const failures: string[] = []

  walkZip(
    zip,
    (path) => path.startsWith(memesPrefix) && isPackImage(path),
    (path, data) => {
      matched += 1
      if (imported >= MAX_STICKER_PACK_FILES) {
        skipped += 1
        if (failures.length < 20) failures.push(path.slice(memesPrefix.length))
        return
      }

      const relative = path.slice(memesPrefix.length)
      const slash = relative.indexOf('/')
      const category = slash === -1 ? '' : relative.slice(0, slash)
      const filename = slash === -1 ? relative : relative.slice(slash + 1)
      const mime = PACK_IMAGE_MIME.get(filename.split('.').pop()!.toLowerCase())!

      try {
        // 复用上传同一套落盘/去重/魔数校验逻辑
        const attachment = saveUpload(db, { userId, buffer: data, filename, mime, kind: 'sticker' })
        stickersRepo.createSticker(db, {
          packId: pack.id,
          kind: mime === 'image/gif' ? 'gif' : 'image',
          attachmentId: attachment.id,
          keywords: buildKeywords(category, manifest.categories?.[category]?.description),
          position: imported,
        })
        imported += 1
      } catch {
        skipped += 1
        if (failures.length < 20) failures.push(relative)
      }
    },
  )

  if (matched === 0) {
    stickersRepo.deletePack(db, pack.id)
    throw err.validation('压缩包里没有找到 memes 目录下的表情图片')
  }

  if (imported === 0) {
    stickersRepo.deletePack(db, pack.id)
    throw err.validation('导入失败：压缩包里的图片都无法识别')
  }

  const row = stickersRepo.findPack(db, pack.id) as stickersRepo.StickerPackRow
  return { pack: mapPack(row), imported, skipped, failures }
}
