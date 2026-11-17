import { ulid, type AppNotification } from '@nenochat/shared'
import type { DB } from '../db'
import { now } from '../util/clock'
import { writeChange } from './change-log'
import { hub } from '../ws/hub'

interface NotificationRow {
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

function mapNotification(row: NotificationRow): AppNotification {
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

export interface CreateNotificationInput {
  userId: string
  type: AppNotification['type']
  title: string
  body?: string | null
  conversationId?: string | null
  messageId?: string | null
  postId?: string | null
}

/**
 * 写一条通知并实时推给该用户的所有在线端。
 * 通知是个人域实体（user_id 可见性），所以只推给本人，不会串到别人那里。
 */
export function createNotification(db: DB, input: CreateNotificationInput): AppNotification {
  const id = ulid()
  const ts = now()

  db.prepare(
    `INSERT INTO notifications
       (id, user_id, type, title, body, conversation_id, message_id, post_id, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    input.userId,
    input.type,
    input.title,
    input.body ?? null,
    input.conversationId ?? null,
    input.messageId ?? null,
    input.postId ?? null,
    ts,
  )

  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow
  const notification = mapNotification(row)

  writeChange(db, {
    entity: 'notification',
    entityId: id,
    op: 'upsert',
    userId: input.userId,
    payload: notification,
    actorId: null,
  })

  hub().sendToUser(input.userId, 'notification.created', { notification })
  return notification
}
