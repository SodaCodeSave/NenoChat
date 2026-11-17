import { ulid, type AppNotification } from '@nenochat/shared'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import { now } from '../util/clock'
import { writeChange } from './change-log'
import { hub } from '../ws/hub'
import * as notificationsRepo from '../db/repo/notifications'
import type { NotificationRow } from '../db/repo/notifications'

const mapNotification = notificationsRepo.mapNotification

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
 * 带 messageId 时按 (user_id, message_id) 去重，避免多条 AI 路径重复提醒同一条消息。
 */
export function createNotification(db: DB, input: CreateNotificationInput): AppNotification {
  if (input.messageId) {
    const existing = notificationsRepo.findLatestByMessage(db, input.userId, input.messageId)
    if (existing) return mapNotification(existing)
  }

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

  const row = notificationsRepo.findById(db, id) as NotificationRow
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

export interface ListNotificationsInput {
  limit: number
  before?: number | null
}

/** 通知中心列表：多取一条判断是否还有更多 */
export function listNotifications(
  db: DB,
  userId: string,
  input: ListNotificationsInput,
): { notifications: AppNotification[]; unreadCount: number; hasMore: boolean } {
  const rows = notificationsRepo.list(db, userId, input)
  const hasMore = rows.length > input.limit
  const page = hasMore ? rows.slice(0, input.limit) : rows
  return {
    notifications: page.map(mapNotification),
    unreadCount: notificationsRepo.countUnread(db, userId),
    hasMore,
  }
}

export interface MarkNotificationsReadInput {
  ids?: string[]
  all?: boolean
}

/** 标记已读并同步给该用户的其他在线端 */
export function markNotificationsRead(
  db: DB,
  userId: string,
  input: MarkNotificationsReadInput,
): { updated: number; notifications: AppNotification[] } {
  const rows = withTx(db, () => {
    const changed = input.all ? notificationsRepo.markAllRead(db, userId) : notificationsRepo.markRead(db, userId, input.ids ?? [])
    for (const row of changed) {
      const notification = mapNotification(row)
      writeChange(db, {
        entity: 'notification',
        entityId: row.id,
        op: 'upsert',
        userId,
        payload: notification,
        actorId: null,
      })
    }
    return changed
  })

  const notifications = rows.map(mapNotification)
  for (const notification of notifications) {
    hub().sendToUser(userId, 'notification.updated', { notification })
  }
  return { updated: notifications.length, notifications }
}
