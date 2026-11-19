import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
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

export function listPacks(db: DB, userId: string): StickerPackRow[] {
  return db
    .prepare(
      `SELECT * FROM sticker_packs
       WHERE owner_id = ? OR owner_id IS NULL
       ORDER BY position ASC, created_at ASC`,
    )
    .all(userId) as StickerPackRow[]
}

export function findPack(db: DB, id: string): StickerPackRow | undefined {
  return db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(id) as StickerPackRow | undefined
}

export function createPack(
  db: DB,
  input: { ownerId: string; name: string; kind?: string; position?: number },
): StickerPackRow {
  const id = ulid()
  const ts = now()
  db.prepare(
    `INSERT INTO sticker_packs (id, owner_id, name, kind, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.ownerId, input.name, input.kind ?? 'image', input.position ?? 0, ts, ts)
  return findPack(db, id) as StickerPackRow
}

export function renamePack(db: DB, id: string, name: string): void {
  db.prepare('UPDATE sticker_packs SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
}

/** 分组改名与 AI 授权开关共用一个更新入口；传 undefined 的字段不动 */
export function updatePack(
  db: DB,
  id: string,
  patch: { name?: string; allowAi?: boolean },
): void {
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
  db.prepare(`UPDATE sticker_packs SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

export function deletePack(db: DB, id: string): void {
  db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(id)
}

/** 表情连同附件信息一次查出，避免逐条回查 */
export function listStickers(db: DB, packIds: string[]): StickerListRow[] {
  if (packIds.length === 0) return []
  const placeholders = packIds.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT s.*, a.storage_key, a.mime, a.filename, a.size
       FROM stickers s
       LEFT JOIN attachments a ON a.id = s.attachment_id AND a.deleted_at IS NULL
       WHERE s.pack_id IN (${placeholders})
       ORDER BY s.position ASC, s.created_at ASC`,
    )
    .all(...packIds) as StickerListRow[]
}

export function findSticker(db: DB, id: string): StickerRow | undefined {
  return db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined
}

export function createSticker(
  db: DB,
  input: { packId: string; kind: string; attachmentId: string; keywords: string[]; position: number },
): StickerRow {
  const id = ulid()
  const ts = now()
  db.prepare(
    `INSERT INTO stickers (id, pack_id, kind, value, attachment_id, keywords, position, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.packId,
    input.kind,
    input.attachmentId,
    input.keywords.length > 0 ? JSON.stringify(input.keywords) : null,
    input.position,
    ts,
    ts,
  )
  return findSticker(db, id) as StickerRow
}

export function deleteSticker(db: DB, id: string): void {
  db.prepare('DELETE FROM stickers WHERE id = ?').run(id)
}

/** 覆写一个表情的关键词（AI 情绪分析结果写回用） */
export function updateStickerKeywords(db: DB, id: string, keywords: string[]): void {
  db.prepare('UPDATE stickers SET keywords = ?, updated_at = ? WHERE id = ?').run(
    keywords.length > 0 ? JSON.stringify(keywords) : null,
    now(),
    id,
  )
}

/**
 * 某个用户名下所有「允许 AI 使用」的图片表情及其情绪标签。
 * 提示词清单与落库时校验标记合法性都从这里取数据。
 * @param packFilter 角色级白名单：非空时只返回这些分组里的表情；null / 空 = 全部授权分组
 */
export function listAiStickers(
  db: DB,
  ownerId: string,
  packFilter?: ReadonlyArray<string> | null,
): Array<{ id: string; packId: string; keywords: string[] }> {
  const filter = packFilter && packFilter.length > 0 ? [...new Set(packFilter)] : null
  const placeholders = filter ? filter.map(() => '?').join(',') : ''
  const rows = db
    .prepare(
      `SELECT s.id, s.pack_id, s.keywords FROM stickers s
       JOIN sticker_packs p ON p.id = s.pack_id
       WHERE p.allow_ai = 1 AND p.owner_id = ?
         AND s.kind IN ('image', 'gif') AND s.keywords IS NOT NULL
         ${filter ? `AND s.pack_id IN (${placeholders})` : ''}`,
    )
    .all(...(filter ? [ownerId, ...filter] : [ownerId])) as Array<{
    id: string
    pack_id: string
    keywords: string | null
  }>

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
export function listStickersMissingTags(db: DB, ownerId: string): Array<{ id: string; attachment_id: string }> {
  return db
    .prepare(
      `SELECT s.id, s.attachment_id FROM stickers s
       JOIN sticker_packs p ON p.id = s.pack_id
       WHERE p.owner_id = ? AND p.kind = 'image'
         AND s.kind IN ('image', 'gif') AND s.attachment_id IS NOT NULL
         AND (s.keywords IS NULL OR s.keywords = '[]' OR s.keywords = '')`,
    )
    .all(ownerId) as Array<{ id: string; attachment_id: string }>
}

export function countInPack(db: DB, packId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM stickers WHERE pack_id = ?').get(packId) as { n: number }
  return row.n
}
