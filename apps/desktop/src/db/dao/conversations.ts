import type { Channel, Conversation, Member } from '@nenochat/shared'
import { dbExecute, dbSelect } from '../../platform/db'
import type { ConversationSummary } from '../../api/endpoints'

export interface ConversationRow {
  server_id: string
  id: string
  type: string
  name: string | null
  avatar_url: string | null
  owner_id: string | null
  announcement: string | null
  ai_persona_id: string | null
  last_message_id: string | null
  last_message_at: number | null
  message_count: number
  dm_key: string | null
  pinned_at: number | null
  notification_level: string | null
  unread_count: number
  mention_count: number
  my_last_read_seq: number
  member_count: number
  partner_id: string | null
  partner_name: string | null
  partner_avatar_url: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export function mapConversation(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    type: row.type as Conversation['type'],
    name: row.name,
    avatarUrl: row.avatar_url,
    ownerId: row.owner_id,
    announcement: row.announcement,
    aiPersonaId: row.ai_persona_id,
    lastMessageId: row.last_message_id,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    dmKey: row.dm_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    pinnedAt: row.pinned_at,
    notificationLevel: row.notification_level,
    unreadCount: row.unread_count,
    mentionCount: row.mention_count,
    myLastReadSeq: row.my_last_read_seq,
    memberCount: row.member_count,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    partnerAvatarUrl: row.partner_avatar_url,
  }
}

export async function listConversations(serverId: string): Promise<ConversationSummary[]> {
  const rows = await dbSelect<ConversationRow>(
    `SELECT * FROM conversations
     WHERE server_id = $1 AND deleted_at IS NULL
     ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, updated_at DESC`,
    [serverId],
  )
  return rows.map(mapConversation)
}

export async function upsertConversation(serverId: string, conversation: Conversation): Promise<void> {
  const summary = conversation as ConversationSummary
  await dbExecute(
    `INSERT INTO conversations
       (server_id, id, type, name, avatar_url, owner_id, announcement, ai_persona_id, last_message_id,
        last_message_at, message_count, dm_key, partner_id, partner_name, partner_avatar_url,
        created_at, updated_at, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT(server_id, id) DO UPDATE SET
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       owner_id = excluded.owner_id,
       announcement = excluded.announcement,
       ai_persona_id = excluded.ai_persona_id,
       last_message_id = excluded.last_message_id,
       last_message_at = excluded.last_message_at,
       message_count = excluded.message_count,
       partner_id = COALESCE(excluded.partner_id, conversations.partner_id),
       partner_name = COALESCE(excluded.partner_name, conversations.partner_name),
       partner_avatar_url = COALESCE(excluded.partner_avatar_url, conversations.partner_avatar_url),
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
    [
      serverId,
      conversation.id,
      conversation.type,
      conversation.name ?? null,
      conversation.avatarUrl ?? null,
      conversation.ownerId ?? null,
      conversation.announcement ?? null,
      conversation.aiPersonaId ?? null,
      conversation.lastMessageId ?? null,
      conversation.lastMessageAt ?? null,
      conversation.messageCount ?? 0,
      conversation.dmKey ?? null,
      summary.partnerId ?? null,
      summary.partnerName ?? null,
      summary.partnerAvatarUrl ?? null,
      conversation.createdAt,
      conversation.updatedAt,
      conversation.deletedAt ?? null,
    ],
  )
}

/** 列表页拿到的是聚合结果（未读数、成员数），单独更新以免覆盖实体字段 */
export async function applyConversationSummary(serverId: string, summary: ConversationSummary): Promise<void> {
  await upsertConversation(serverId, summary)
  await dbExecute(
    `UPDATE conversations
     SET pinned_at = $3, notification_level = $4, unread_count = $5, mention_count = $6,
         my_last_read_seq = $7, member_count = $8, partner_id = $9, partner_name = $10,
         partner_avatar_url = $11
     WHERE server_id = $1 AND id = $2`,
    [
      serverId,
      summary.id,
      summary.pinnedAt ?? null,
      summary.notificationLevel ?? null,
      summary.unreadCount ?? 0,
      summary.mentionCount ?? 0,
      summary.myLastReadSeq ?? 0,
      summary.memberCount ?? 0,
      summary.partnerId ?? null,
      summary.partnerName ?? null,
      summary.partnerAvatarUrl ?? null,
    ],
  )
}

export async function patchConversationUnread(
  serverId: string,
  conversationId: string,
  patch: { unreadCount?: number; mentionCount?: number; myLastReadSeq?: number; pinnedAt?: number | null },
): Promise<void> {
  await dbExecute(
    `UPDATE conversations
     SET unread_count = COALESCE($3, unread_count),
         mention_count = COALESCE($4, mention_count),
         my_last_read_seq = COALESCE($5, my_last_read_seq),
         pinned_at = CASE WHEN $6 THEN $7 ELSE pinned_at END
     WHERE server_id = $1 AND id = $2`,
    [
      serverId,
      conversationId,
      patch.unreadCount ?? null,
      patch.mentionCount ?? null,
      patch.myLastReadSeq ?? null,
      Object.prototype.hasOwnProperty.call(patch, 'pinnedAt'),
      patch.pinnedAt ?? null,
    ],
  )
}

export async function deleteConversation(serverId: string, conversationId: string): Promise<void> {
  await dbExecute('UPDATE conversations SET deleted_at = $3 WHERE server_id = $1 AND id = $2', [
    serverId,
    conversationId,
    Date.now(),
  ])
}

/* ------------------------------- 成员与频道 ------------------------------- */

export interface MemberRow {
  server_id: string
  conversation_id: string
  user_id: string
  role: string
  nickname: string | null
  allow: number
  deny: number
  mute_until: number | null
  joined_at: number
  left_at: number | null
  updated_at: number
}

export async function listMembers(serverId: string, conversationId: string): Promise<Member[]> {
  const rows = await dbSelect<MemberRow>(
    `SELECT * FROM members
     WHERE server_id = $1 AND conversation_id = $2 AND left_at IS NULL
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at`,
    [serverId, conversationId],
  )
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role as Member['role'],
    nickname: row.nickname,
    allow: row.allow,
    deny: row.deny,
    muteUntil: row.mute_until,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    updatedAt: row.updated_at,
  }))
}

export async function upsertMember(serverId: string, member: Member): Promise<void> {
  await dbExecute(
    `INSERT INTO members
       (server_id, conversation_id, user_id, role, nickname, allow, deny, mute_until, joined_at, left_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(server_id, conversation_id, user_id) DO UPDATE SET
       role = excluded.role,
       nickname = excluded.nickname,
       allow = excluded.allow,
       deny = excluded.deny,
       mute_until = excluded.mute_until,
       left_at = excluded.left_at,
       updated_at = excluded.updated_at`,
    [
      serverId,
      member.conversationId,
      member.userId,
      member.role,
      member.nickname ?? null,
      member.allow,
      member.deny,
      member.muteUntil ?? null,
      member.joinedAt,
      member.leftAt ?? null,
      member.updatedAt,
    ],
  )
}

export async function markMemberLeft(serverId: string, conversationId: string, userId: string): Promise<void> {
  await dbExecute(
    'UPDATE members SET left_at = $4, updated_at = $4 WHERE server_id = $1 AND conversation_id = $2 AND user_id = $3',
    [serverId, conversationId, userId, Date.now()],
  )
}

export interface ChannelRow {
  server_id: string
  id: string
  conversation_id: string
  name: string
  topic: string | null
  kind: string
  category: string | null
  position: number
  archived_at: number | null
  created_at: number
  updated_at: number
}

export async function listChannels(serverId: string, conversationId: string): Promise<Channel[]> {
  const rows = await dbSelect<ChannelRow>(
    `SELECT * FROM channels
     WHERE server_id = $1 AND conversation_id = $2 AND archived_at IS NULL
     ORDER BY COALESCE(category, ''), position, created_at`,
    [serverId, conversationId],
  )
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    name: row.name,
    topic: row.topic,
    kind: row.kind as Channel['kind'],
    category: row.category,
    position: row.position,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export async function upsertChannel(serverId: string, channel: Channel): Promise<void> {
  await dbExecute(
    `INSERT INTO channels
       (server_id, id, conversation_id, name, topic, kind, category, position, archived_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(server_id, id) DO UPDATE SET
       name = excluded.name,
       topic = excluded.topic,
       kind = excluded.kind,
       category = excluded.category,
       position = excluded.position,
       archived_at = excluded.archived_at,
       updated_at = excluded.updated_at`,
    [
      serverId,
      channel.id,
      channel.conversationId,
      channel.name,
      channel.topic ?? null,
      channel.kind,
      channel.category ?? null,
      channel.position,
      channel.archivedAt ?? null,
      channel.createdAt,
      channel.updatedAt,
    ],
  )
}

export async function archiveChannel(serverId: string, channelId: string): Promise<void> {
  await dbExecute('UPDATE channels SET archived_at = $3 WHERE server_id = $1 AND id = $2', [
    serverId,
    channelId,
    Date.now(),
  ])
}

/** 会话软删：保留本地行便于回溯，列表层按 deleted_at 过滤 */
export async function markConversationDeleted(serverId: string, conversationId: string): Promise<void> {
  await dbExecute('UPDATE conversations SET deleted_at = $3 WHERE server_id = $1 AND id = $2', [
    serverId,
    conversationId,
    Date.now(),
  ])
}

export async function getReadCursor(serverId: string, conversationId: string): Promise<number> {
  const rows = await dbSelect<{ last_read_seq: number }>(
    'SELECT last_read_seq FROM read_cursors WHERE server_id = $1 AND conversation_id = $2',
    [serverId, conversationId],
  )
  return rows[0]?.last_read_seq ?? 0
}

export async function setReadCursor(serverId: string, conversationId: string, seq: number): Promise<void> {
  await dbExecute(
    `INSERT INTO read_cursors (server_id, conversation_id, last_read_seq, updated_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT(server_id, conversation_id) DO UPDATE SET
       last_read_seq = excluded.last_read_seq,
       updated_at = excluded.updated_at`,
    [serverId, conversationId, seq, Date.now()],
  )
}

export async function listPinnedConversationIds(serverId: string): Promise<string[]> {
  const rows = await dbSelect<{ id: string }>(
    'SELECT id FROM conversations WHERE server_id = $1 AND pinned_at IS NOT NULL',
    [serverId],
  )
  return rows.map((r) => r.id)
}
