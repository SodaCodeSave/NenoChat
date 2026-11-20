import { ulid } from '@nenochat/shared'
import { all, one, run, type DB } from '../index'
import { now } from '../../util/clock'

export interface StickerPackRow {
  id: string
  owner_id: string | null
  name: string
  kind: string
  allow_ai: number
  position: number
  created_at: number
  updated_at: number
}

export interface StickerRow {
  id: string
  pack_id: string
  kind: string
  value: string | null
  attachment_id: string | null
  keywords: string | null
  position: number
  created_at: number
  updated_at: number
}

export interface StickerListRow extends StickerRow {
  storage_key: string | null
  mime: string | null
  filename: string | null
  size: number | null
}

export const DEFAULT_PACK_NAME = '我的表情'

export function listPacks(db: DB, userId: string): Promise<StickerPackRow[]> {
  return all<StickerPackRow>(
    db,
    `SELECT * FROM sticker_packs
       WHERE owner_id = ? OR owner_id IS NULL
       ORDER BY position ASC, created_at ASC`,
    [userId],
  )
}

export function findPack(db: DB, id: string): Promise<StickerPackRow | undefined> {
  return one<StickerPackRow>(db, 'SELECT * FROM sticker_packs WHERE id = ?', [id])
}

export async function createPack(
  db: DB,
  input: { ownerId: string; name: string; kind?: string; position?: number },
): Promise<StickerPackRow> {
  const id = ulid()
  const ts = now()
  const row = await one<StickerPackRow>(
    db,
    `INSERT INTO sticker_packs (id, owner_id, name, kind, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [id, input.ownerId, input.name, input.kind ?? 'image', input.position ?? 0, ts, ts],
  )
  if (!row) throw new Error('创建表情分组后回读失败')
  return row
}

export async function renamePack(db: DB, id: string, name: string): Promise<void> {
  await run(db, 'UPDATE sticker_packs SET name = ?, updated_at = ? WHERE id = ?', [name, now(), id])
}

/** 分组改名与 AI 授权开关共用一个更新入口；传 undefined 的字段不动 */
export async function updatePack(
  db: DB,
  id: string,
  patch: { name?: string; allowAi?: boolean },
): Promise<void> {
  const sets: string[] = []
  const args: Array<string | number> = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    args.push(patch.name)
  }
  if (patch.allowAi !== undefined) {
    sets.push('allow_ai = ?')
    args.push(patch.allowAi ? 1 : 0)
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  args.push(now(), id)
  await run(db, `UPDATE sticker_packs SET ${sets.join(', ')} WHERE id = ?`, args)
}

export async function deletePack(db: DB, id: string): Promise<void> {
  await run(db, 'DELETE FROM sticker_packs WHERE id = ?', [id])
}

/** 表情连同附件信息一次查出，避免逐条回查 */
export async function listStickers(db: DB, packIds: string[]): Promise<StickerListRow[]> {
  if (packIds.length === 0) return []
  const placeholders = packIds.map(() => '?').join(',')
  return all<StickerListRow>(
    db,
    `SELECT s.*, a.storage_key, a.mime, a.filename, a.size
     FROM stickers s
     LEFT JOIN attachments a ON a.id = s.attachment_id AND a.deleted_at IS NULL
     WHERE s.pack_id IN (${placeholders})
     ORDER BY s.position ASC, s.created_at ASC`,
    packIds,
  )
}

export function findSticker(db: DB, id: string): Promise<StickerRow | undefined> {
  return one<StickerRow>(db, 'SELECT * FROM stickers WHERE id = ?', [id])
}

export async function createSticker(
  db: DB,
  input: { packId: string; kind: string; attachmentId: string; keywords: string[]; position: number },
): Promise<StickerRow> {
  const id = ulid()
  const ts = now()
  const row = await one<StickerRow>(
    db,
    `INSERT INTO stickers (id, pack_id, kind, value, attachment_id, keywords, position, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      id,
      input.packId,
      input.kind,
      input.attachmentId,
      input.keywords.length > 0 ? JSON.stringify(input.keywords) : null,
      input.position,
      ts,
      ts,
    ],
  )
  if (!row) throw new Error('创建表情后回读失败')
  return row
}

export async function deleteSticker(db: DB, id: string): Promise<void> {
  await run(db, 'DELETE FROM stickers WHERE id = ?', [id])
}

/** 覆写一个表情的关键词（AI 情绪分析结果写回用） */
export async function updateStickerKeywords(db: DB, id: string, keywords: string[]): Promise<void> {
  await run(db, 'UPDATE stickers SET keywords = ?, updated_at = ? WHERE id = ?', [
    keywords.length > 0 ? JSON.stringify(keywords) : null,
    now(),
    id,
  ])
}

/**
 * 某个用户名下所有「允许 AI 使用」的图片表情及其情绪标签。
 * 提示词清单与落库时校验标记合法性都从这里取数据。
 * @param packFilter 角色级白名单：非空时只返回这些分组里的表情；null / 空 = 全部授权分组
 */
export async function listAiStickers(
  db: DB,
  ownerId: string,
  packFilter?: ReadonlyArray<string> | null,
): Promise<Array<{ id: string; packId: string; keywords: string[] }>> {
  const filter = packFilter && packFilter.length > 0 ? [...new Set(packFilter)] : null
  const placeholders = filter ? filter.map(() => '?').join(',') : ''
  const rows = await all<{ id: string; pack_id: string; keywords: string | null }>(
    db,
    `SELECT s.id, s.pack_id, s.keywords FROM stickers s
     JOIN sticker_packs p ON p.id = s.pack_id
     WHERE p.allow_ai = 1 AND p.owner_id = ?
       AND s.kind IN ('image', 'gif') AND s.keywords IS NOT NULL
       ${filter ? `AND s.pack_id IN (${placeholders})` : ''}`,
    filter ? [ownerId, ...filter] : [ownerId],
  )

  const out: Array<{ id: string; packId: string; keywords: string[] }> = []
  for (const row of rows) {
    if (!row.keywords) continue
    try {
      const parsed = JSON.parse(row.keywords)
      if (Array.isArray(parsed)) {
        const tags = parsed.filter((k): k is string => typeof k === 'string' && k.length > 0)
        if (tags.length > 0) out.push({ id: row.id, packId: row.pack_id, keywords: tags })
      }
    } catch {
      /* 坏数据跳过 */
    }
  }
  return out
}

/** 某个用户名下还没有任何情绪标签的图片表情，供一键补扫遍历 */
export function listStickersMissingTags(db: DB, ownerId: string): Promise<Array<{ id: string; attachment_id: string }>> {
  return all<{ id: string; attachment_id: string }>(
    db,
    `SELECT s.id, s.attachment_id FROM stickers s
     JOIN sticker_packs p ON p.id = s.pack_id
     WHERE p.owner_id = ? AND p.kind = 'image'
       AND s.kind IN ('image', 'gif') AND s.attachment_id IS NOT NULL
       AND (s.keywords IS NULL OR s.keywords = '[]' OR s.keywords = '')`,
    [ownerId],
  )
}

export async function countInPack(db: DB, packId: string): Promise<number> {
  const row = await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM stickers WHERE pack_id = ?', [packId])
  return row?.n ?? 0
}
