import type { Sticker, StickerPackWithStickers } from '@nenochat/shared'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as stickersRepo from '../db/repo/stickers'
import * as attachmentsRepo from '../db/repo/attachments'
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
