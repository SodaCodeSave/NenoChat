import type { AppNotification } from '@nenochat/shared'
import type { DB } from '../index'

export interface NotificationRow {
  id: string
  user_id: string
  type: string
  title: string
  body: string | null
  conversation_id: string | null
  message_id: string | null
  post_id: string | null
  is_read: number
  created_at: number
}

export function mapNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as AppNotification['type'],
    title: row.title,
    body: row.body,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    postId: row.post_id,
    isRead: row.is_read === 1,
    createdAt: row.created_at,
  }
}

export function findById(db: DB, id: string): NotificationRow | undefined {
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined
}

export function findLatestByMessage(db: DB, userId: string, messageId: string): NotificationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE user_id = ? AND message_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId, messageId) as NotificationRow | undefined
}

export function list(
  db: DB,
  userId: string,
  input: { limit: number; before?: number | null },
): NotificationRow[] {
  const before = input.before ?? null
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE user_id = ? AND (? IS NULL OR created_at < ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(userId, before, before, input.limit + 1) as NotificationRow[]
}

export function countUnread(db: DB, userId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(userId) as { c: number }
  return row.c
}

/** 只允许操作自己的通知，返回实际被更新的行 */
export function markRead(db: DB, userId: string, ids: string[]): NotificationRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE user_id = ? AND is_read = 0 AND id IN (${placeholders})`,
    )
    .all(userId, ...ids) as NotificationRow[]
  if (rows.length === 0) return []
  db.prepare(
    `UPDATE notifications SET is_read = 1
     WHERE user_id = ? AND id IN (${placeholders})`,
  ).run(userId, ...rows.map((row) => row.id))
  return rows.map((row) => ({ ...row, is_read: 1 }))
}

export function markAllRead(db: DB, userId: string): NotificationRow[] {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? AND is_read = 0')
    .all(userId) as NotificationRow[]
  if (rows.length === 0) return []
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId)
  return rows.map((row) => ({ ...row, is_read: 1 }))
}
