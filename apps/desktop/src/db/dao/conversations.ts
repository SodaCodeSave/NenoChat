import type { Conversation, Member } from '@nenochat/shared'
import { dbExecute, dbExecuteMany, dbSelect, rowPlaceholders } from '../../platform/db'
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

/* 会话 upsert 语句的公共部件。实体列与聚合列分开拼：
   同步增量只带实体字段，列表刷新才带未读数/置顶等聚合信息。 */
const ENTITY_COLUMNS = [
  'server_id',
  'id',
  'type',
  'name',
  'avatar_url',
  'owner_id',
  'announcement',
  'ai_persona_id',
  'last_message_id',
  'last_message_at',
  'message_count',
  'dm_key',
  'partner_id',
  'partner_name',
  'partner_avatar_url',
  'created_at',
  'updated_at',
  'deleted_at',
]

const SUMMARY_COLUMNS = [
  'pinned_at',
  'notification_level',
  'unread_count',
  'mention_count',
  'my_last_read_seq',
  'member_count',
]

const ENTITY_ON_CONFLICT = `ON CONFLICT(server_id, id) DO UPDATE SET
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
   deleted_at = excluded.deleted_at`

const SUMMARY_ON_CONFLICT = `,
   pinned_at = excluded.pinned_at,
   notification_level = excluded.notification_level,
   unread_count = excluded.unread_count,
   mention_count = excluded.mention_count,
   my_last_read_seq = excluded.my_last_read_seq,
   member_count = excluded.member_count`

function conversationParams(serverId: string, conversation: Conversation, withSummary: boolean): unknown[] {
  const summary = conversation as ConversationSummary
  const entity = [
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
  ]
  if (!withSummary) return entity
  return [
    ...entity,
    summary.pinnedAt ?? null,
    summary.notificationLevel ?? null,
    summary.unreadCount ?? 0,
    summary.mentionCount ?? 0,
    summary.myLastReadSeq ?? 0,
    summary.memberCount ?? 0,
  ]
}

/** 一组会话拼成单条多行 upsert；带聚合列时实体列 + 聚合列一次写完 */
function conversationUpsertStatement(
  serverId: string,
  rows: Conversation[],
  withSummary: boolean,
): { sql: string; params: unknown[] } {
  const columns = withSummary ? [...ENTITY_COLUMNS, ...SUMMARY_COLUMNS] : ENTITY_COLUMNS
  return {
    sql: `INSERT INTO conversations (${columns.join(', ')})
     VALUES ${rowPlaceholders(rows.length, columns.length)}
     ${ENTITY_ON_CONFLICT}${withSummary ? SUMMARY_ON_CONFLICT : ''}`,
    params: rows.flatMap((row) => conversationParams(serverId, row, withSummary)),
  }
}

/** 每行最多 24 个参数，单语句 200 行（4800 参数），远低于 SQLite 默认变量数上限 */
const CONVERSATION_CHUNK_ROWS = 200

function chunkStatements(
  rows: Conversation[],
  build: (chunk: Conversation[]) => { sql: string; params: unknown[] },
): Array<{ sql: string; params: unknown[] }> {
  // 同 id 重复行进同一条多行 upsert 会让 SQLite 报错，先收敛成最后一条
  if (rows.length > 1) rows = [...new Map(rows.map((row) => [row.id, row])).values()]
  const statements: Array<{ sql: string; params: unknown[] }> = []
  for (let start = 0; start < rows.length; start += CONVERSATION_CHUNK_ROWS) {
    statements.push(build(rows.slice(start, start + CONVERSATION_CHUNK_ROWS)))
  }
  return statements
}

export async function upsertConversation(serverId: string, conversation: Conversation): Promise<void> {
  await dbExecuteMany(chunkStatements([conversation], (chunk) => conversationUpsertStatement(serverId, chunk, false)))
}

/** 同步追批用：把一批会话实体合并成少量多行语句，聚合列不动（增量记录里没有） */
export async function upsertConversationsBatched(serverId: string, conversations: Conversation[]): Promise<void> {
  if (conversations.length === 0) return
  await dbExecuteMany(chunkStatements(conversations, (chunk) => conversationUpsertStatement(serverId, chunk, false)))
}

/** 列表页拿到的是聚合结果（未读数、成员数），与实体列一起整行覆盖 */
export async function applyConversationSummary(serverId: string, summary: ConversationSummary): Promise<void> {
  await applyConversationSummaries(serverId, [summary])
}

/** 列表刷新用：整份列表一次落库（原逐条 upsert + UPDATE 合并成多行 upsert） */
export async function applyConversationSummaries(serverId: string, summaries: ConversationSummary[]): Promise<void> {
  if (summaries.length === 0) return
  await dbExecuteMany(chunkStatements(summaries, (chunk) => conversationUpsertStatement(serverId, chunk, true)))
}

/** 同步追批用：把一批会话软删合并成一条 IN 语句 */
export async function markConversationsDeleted(serverId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const slots = ids.map((_, i) => `$${i + 2}`)
  await dbExecute(
    `UPDATE conversations SET deleted_at = $${ids.length + 2} WHERE server_id = $1 AND id IN (${slots.join(',')})`,
    [serverId, ...ids, Date.now()],
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

/* -------------------------------- 成员 -------------------------------- */

export interface MemberRow {
  server_id: string
  conversation_id: string
  user_id: string
  role: string
  nickname: string | null
  allow: number
  deny: number
  mute_until: number | null
  notification_level: string | null
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
    notificationLevel: (row.notification_level as Member['notificationLevel']) ?? null,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    updatedAt: row.updated_at,
  }))
}

function memberParams(serverId: string, member: Member): unknown[] {
  return [
    serverId,
    member.conversationId,
    member.userId,
    member.role,
    member.nickname ?? null,
    member.allow,
    member.deny,
    member.muteUntil ?? null,
    member.notificationLevel ?? null,
    member.joinedAt,
    member.leftAt ?? null,
    member.updatedAt,
  ]
}

const MEMBER_COLUMNS = [
  'server_id',
  'conversation_id',
  'user_id',
  'role',
  'nickname',
  'allow',
  'deny',
  'mute_until',
  'notification_level',
  'joined_at',
  'left_at',
  'updated_at',
]

const MEMBER_ON_CONFLICT = `ON CONFLICT(server_id, conversation_id, user_id) DO UPDATE SET
   role = excluded.role,
   nickname = excluded.nickname,
   allow = excluded.allow,
   deny = excluded.deny,
   mute_until = excluded.mute_until,
   notification_level = excluded.notification_level,
   left_at = excluded.left_at,
   updated_at = excluded.updated_at`

/** 每行 12 个参数，单语句最多 500 行（6000 参数），远低于 SQLite 默认变量数上限 */
const MEMBER_CHUNK_ROWS = 500

export async function upsertMember(serverId: string, member: Member): Promise<void> {
  await upsertMembersBatched(serverId, [member])
}

/** 同步追批用：把一批成员合并成少量多行 upsert */
export async function upsertMembersBatched(serverId: string, members: Member[]): Promise<void> {
  if (members.length === 0) return
  // 同 (conversation_id, user_id) 重复行进同一条多行 upsert 会让 SQLite 报错，先收敛成最后一条
  if (members.length > 1) {
    members = [...new Map(members.map((member) => [`${member.conversationId}:${member.userId}`, member])).values()]
  }
  const statements: Array<{ sql: string; params: unknown[] }> = []
  for (let start = 0; start < members.length; start += MEMBER_CHUNK_ROWS) {
    const chunk = members.slice(start, start + MEMBER_CHUNK_ROWS)
    statements.push({
      sql: `INSERT INTO members (${MEMBER_COLUMNS.join(', ')})
     VALUES ${rowPlaceholders(chunk.length, MEMBER_COLUMNS.length)}
     ${MEMBER_ON_CONFLICT}`,
      params: chunk.flatMap((member) => memberParams(serverId, member)),
    })
  }
  await dbExecuteMany(statements)
}

export async function markMemberLeft(serverId: string, conversationId: string, userId: string): Promise<void> {
  await markMembersLeft(serverId, [{ conversationId, userId }])
}

/** 同步追批用：一批成员离场合并成一条行值 IN 的 UPDATE */
export async function markMembersLeft(
  serverId: string,
  keys: Array<{ conversationId: string; userId: string }>,
): Promise<void> {
  if (keys.length === 0) return
  const tuples = keys.map((_, i) => `($${i * 2 + 3},$${i * 2 + 4})`)
  await dbExecute(
    `UPDATE members SET left_at = $2, updated_at = $2
     WHERE server_id = $1 AND (conversation_id, user_id) IN (VALUES ${tuples.join(',')})`,
    [serverId, Date.now(), ...keys.flatMap((key) => [key.conversationId, key.userId])],
  )
}

/** 会话软删：保留本地行便于回溯，列表层按 deleted_at 过滤 */
export async function markConversationDeleted(serverId: string, conversationId: string): Promise<void> {
  await markConversationsDeleted(serverId, [conversationId])
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
