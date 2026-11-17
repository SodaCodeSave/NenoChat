import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface StickerPackRow {
  id: string
  owner_id: string | null
  name: string
  kind: string
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

export function countInPack(db: DB, packId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM stickers WHERE pack_id = ?').get(packId) as { n: number }
  return row.n
}
