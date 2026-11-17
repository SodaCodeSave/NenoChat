import { ulid, type Attachment } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface AttachmentRow {
  id: string
  owner_id: string
  conversation_id: string | null
  message_id: string | null
  kind: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  sha256: string
  storage_key: string
  thumb_key: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/**
 * 数据库里只存相对路径。
 * 绝对 URL 会把 localhost 烧进库，另一台设备用 http://ip:8787 打开时图片全部 404。
 */
export function attachmentUrl(storageKey: string): string {
  return `/files/${storageKey}`
}

export function mapAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: row.kind as Attachment['kind'],
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    url: attachmentUrl(row.storage_key),
    thumbUrl: row.thumb_key ? attachmentUrl(row.thumb_key) : null,
    createdAt: row.created_at,
  }
}

/** 同一用户重复上传同一张图时直接复用，既省磁盘也省一次写 */
export function findById(db: DB, id: string): AttachmentRow | undefined {
  return db
    .prepare('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL')
    .get(id) as AttachmentRow | undefined
}

export function findBySha(db: DB, ownerId: string, sha256: string): AttachmentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM attachments
       WHERE owner_id = ? AND sha256 = ? AND deleted_at IS NULL
       ORDER BY created_at LIMIT 1`,
    )
    .get(ownerId, sha256) as AttachmentRow | undefined
}

export function create(
  db: DB,
  input: {
    ownerId: string
    kind: string
    filename: string
    mime: string
    size: number
    sha256: string
    storageKey: string
    createdAt?: number
  },
): AttachmentRow {
  const id = ulid()
  const ts = input.createdAt ?? now()
  db.prepare(
    `INSERT INTO attachments
       (id, owner_id, conversation_id, message_id, kind, filename, mime, size, width, height,
        sha256, storage_key, thumb_key, created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, NULL)`,
  ).run(
    id,
    input.ownerId,
    input.kind,
    input.filename,
    input.mime,
    input.size,
    input.sha256,
    input.storageKey,
    ts,
    ts,
  )
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow
}
