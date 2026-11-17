import type { AppNotification } from '@nenochat/shared'
import { dbExecute, dbSelect } from '../../platform/db'

export interface NotificationRow {
  server_id: string
  id: string
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
    // 本地镜像按服务器隔离，userId 由当前登录态隐含
    userId: '',
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

export async function listNotifications(serverId: string, limit = 50): Promise<AppNotification[]> {
  const rows = await dbSelect<NotificationRow>(
    `SELECT * FROM notifications
     WHERE server_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [serverId, limit],
  )
  return rows.map(mapNotification)
}

export async function countUnreadNotifications(serverId: string): Promise<number> {
  const rows = await dbSelect<{ c: number }>(
    'SELECT COUNT(*) AS c FROM notifications WHERE server_id = $1 AND is_read = 0',
    [serverId],
  )
  return rows[0]?.c ?? 0
}

export async function upsertNotification(serverId: string, notification: AppNotification): Promise<void> {
  await dbExecute(
    `INSERT INTO notifications
       (server_id, id, type, title, body, conversation_id, message_id, post_id, is_read, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(server_id, id) DO UPDATE SET
       type = excluded.type,
       title = excluded.title,
       body = excluded.body,
       conversation_id = excluded.conversation_id,
       message_id = excluded.message_id,
       post_id = excluded.post_id,
       is_read = excluded.is_read,
       created_at = excluded.created_at`,
    [
      serverId,
      notification.id,
      notification.type,
      notification.title,
      notification.body ?? null,
      notification.conversationId ?? null,
      notification.messageId ?? null,
      notification.postId ?? null,
      notification.isRead ? 1 : 0,
      notification.createdAt,
    ],
  )
}

export async function markNotificationsRead(serverId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const placeholders = ids.map((_, index) => `$${index + 2}`).join(',')
  await dbExecute(
    `UPDATE notifications SET is_read = 1
     WHERE server_id = $1 AND id IN (${placeholders})`,
    [serverId, ...ids],
  )
}

export async function markAllNotificationsRead(serverId: string): Promise<void> {
  await dbExecute('UPDATE notifications SET is_read = 1 WHERE server_id = $1 AND is_read = 0', [serverId])
}
