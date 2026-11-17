import type { Conversation, ConversationType } from '@nenochat/shared'
import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface ConversationRow {
  id: string
  type: string
  name: string | null
  avatar_url: string | null
  owner_id: string | null
  announcement: string | null
  announcement_updated_at: number | null
  announcement_updated_by: string | null
  ai_persona_id: string | null
  ai_owner_user_id: string | null
  last_message_id: string | null
  last_message_at: number | null
  message_count: number
  seq_counter: number
  dm_key: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    type: row.type as ConversationType,
    name: row.name,
    avatarUrl: row.avatar_url,
    ownerId: row.owner_id,
    announcement: row.announcement,
    announcementUpdatedAt: row.announcement_updated_at,
    announcementUpdatedBy: row.announcement_updated_by,
    aiPersonaId: row.ai_persona_id,
    aiOwnerUserId: row.ai_owner_user_id,
    lastMessageId: row.last_message_id,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    dmKey: row.dm_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export function findById(db: DB, id: string): ConversationRow | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
}

export function findByDmKey(db: DB, dmKey: string): ConversationRow | undefined {
  return db.prepare('SELECT * FROM conversations WHERE dm_key = ?').get(dmKey) as
    | ConversationRow
    | undefined
}

/** 角色对应的 AI 会话，用于取记忆摘要给动态生成做上下文 */
export function findByPersonaId(db: DB, personaId: string): ConversationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM conversations
       WHERE ai_persona_id = ? AND deleted_at IS NULL
       ORDER BY created_at LIMIT 1`,
    )
    .get(personaId) as ConversationRow | undefined
}

export interface CreateConversationInput {
  type: ConversationType
  name?: string | null
  avatarUrl?: string | null
  ownerId?: string | null
  dmKey?: string | null
  aiPersonaId?: string | null
  aiOwnerUserId?: string | null
}

export function create(db: DB, input: CreateConversationInput): ConversationRow {
  const id = ulid()
  const ts = now()
  db.prepare(
    `INSERT INTO conversations
       (id, type, name, avatar_url, owner_id, announcement, announcement_updated_at,
        announcement_updated_by, ai_persona_id, ai_owner_user_id, last_message_id,
        last_message_at, message_count, seq_counter, dm_key, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, 0, 0, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.type,
    input.name ?? null,
    input.avatarUrl ?? null,
    input.ownerId ?? null,
    input.aiPersonaId ?? null,
    input.aiOwnerUserId ?? null,
    input.dmKey ?? null,
    ts,
    ts,
  )
  const row = findById(db, id)
  if (!row) throw new Error('创建会话后回读失败')
  return row
}

/** 分配会话内下一个 seq，必须与消息插入在同一事务内 */
export function nextSeq(db: DB, id: string): number {
  const row = db
    .prepare('UPDATE conversations SET seq_counter = seq_counter + 1 WHERE id = ? RETURNING seq_counter')
    .get(id) as { seq_counter: number } | undefined
  if (!row) throw new Error('会话不存在，无法分配 seq')
  return row.seq_counter
}

export function touchLastMessage(db: DB, id: string, messageId: string, at: number): void {
  db.prepare(
    `UPDATE conversations
     SET last_message_id = ?, last_message_at = ?, message_count = message_count + 1, updated_at = ?
     WHERE id = ?`,
  ).run(messageId, at, at, id)
}

export interface UpdateConversationInput {
  name?: string | null
  avatarUrl?: string | null
  announcement?: string | null
  announcementUpdatedBy?: string | null
}

export function update(db: DB, id: string, patch: UpdateConversationInput): ConversationRow {
  const current = findById(db, id)
  if (!current) throw new Error('会话不存在')
  const ts = now()
  const announcementChanged = patch.announcement !== undefined

  db.prepare(
    `UPDATE conversations
     SET name = ?, avatar_url = ?, announcement = ?, announcement_updated_at = ?,
         announcement_updated_by = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name === undefined ? current.name : patch.name,
    patch.avatarUrl === undefined ? current.avatar_url : patch.avatarUrl,
    announcementChanged ? (patch.announcement ?? null) : current.announcement,
    announcementChanged ? ts : current.announcement_updated_at,
    announcementChanged ? (patch.announcementUpdatedBy ?? null) : current.announcement_updated_by,
    ts,
    id,
  )
  const row = findById(db, id)
  if (!row) throw new Error('更新会话后回读失败')
  return row
}

export function softDelete(db: DB, id: string): void {
  const ts = now()
  db.prepare('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id)
}

export interface ConversationListRow extends ConversationRow {
  pinned_at: number | null
  notification_level: string | null
  member_count: number
  unread_count: number
  mention_count: number
  my_last_read_seq: number
  partner_id: string | null
  partner_name: string | null
  partner_avatar_url: string | null
}

/**
 * 我参与的会话列表，带上未读数、成员数与私聊对方资料。
 * 私聊没有会话名，直接用对方的昵称与头像渲染，避免客户端再发一轮请求。
 */
export function listForUser(db: DB, userId: string): ConversationListRow[] {
  return db
    .prepare(
      `SELECT c.*,
              cm.pinned_at,
              cm.notification_level,
              (SELECT COUNT(*) FROM conversation_members m2
                WHERE m2.conversation_id = c.id AND m2.left_at IS NULL) AS member_count,
              COALESCE(rc.last_read_seq, 0) AS my_last_read_seq,
              (SELECT COUNT(*) FROM messages msg
                WHERE msg.conversation_id = c.id
                  AND msg.seq > COALESCE(rc.last_read_seq, 0)
                  AND msg.deleted_at IS NULL
                  AND COALESCE(msg.sender_id, '') <> ?) AS unread_count,
              (SELECT COUNT(*) FROM messages msg
                WHERE msg.conversation_id = c.id
                  AND msg.seq > COALESCE(rc.last_read_seq, 0)
                  AND msg.deleted_at IS NULL
                  AND msg.meta LIKE '%"mentions":%'
                  AND msg.meta LIKE ?) AS mention_count,
              (SELECT p.id FROM conversation_members m3 JOIN users p ON p.id = m3.user_id
                WHERE m3.conversation_id = c.id AND m3.left_at IS NULL AND m3.user_id <> ?
                LIMIT 1) AS partner_id,
              (SELECT p.display_name FROM conversation_members m3 JOIN users p ON p.id = m3.user_id
                WHERE m3.conversation_id = c.id AND m3.left_at IS NULL AND m3.user_id <> ?
                LIMIT 1) AS partner_name,
              (SELECT p.avatar_url FROM conversation_members m3 JOIN users p ON p.id = m3.user_id
                WHERE m3.conversation_id = c.id AND m3.left_at IS NULL AND m3.user_id <> ?
                LIMIT 1) AS partner_avatar_url
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
       LEFT JOIN read_cursors rc ON rc.conversation_id = c.id AND rc.user_id = ?
       WHERE c.deleted_at IS NULL
       ORDER BY (cm.pinned_at IS NOT NULL) DESC, cm.pinned_at DESC, c.updated_at DESC`,
    )
    .all(userId, `%${userId}%`, userId, userId, userId, userId, userId) as ConversationListRow[]
}
