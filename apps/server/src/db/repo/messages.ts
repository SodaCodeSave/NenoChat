import type { Message, MessageMeta, MessageType, SenderType } from '@nenochat/shared'
import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { stmt } from '../index'

export interface MessageRow {
  id: string
  conversation_id: string
  sender_id: string | null
  sender_type: string
  type: string
  content: string
  meta: string | null
  reply_to_id: string | null
  seq: number
  client_nonce: string | null
  ai_generation_id: string | null
  ai_index: number | null
  pinned_at: number | null
  edited_at: number | null
  deleted_at: number | null
  deleted_by: string | null
  created_at: number
  updated_at: number
  updated_by_device: string | null
}

export function mapMessage(row: MessageRow): Message {
  let meta: MessageMeta | null = null
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as MessageMeta
    } catch {
      meta = null
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderType: row.sender_type as SenderType,
    type: row.type as MessageType,
    content: row.content,
    meta,
    replyToId: row.reply_to_id,
    seq: row.seq,
    clientNonce: row.client_nonce,
    aiGenerationId: row.ai_generation_id,
    aiIndex: row.ai_index,
    pinnedAt: row.pinned_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByDevice: row.updated_by_device,
  }
}

export function findById(db: DB, id: string): MessageRow | undefined {
  return stmt(db, 'SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
}

/** 引用回复时展示的摘要：非文本消息收敛成占位词，撤回后统一提示 */
export function previewOf(row: MessageRow, max = 80): string {
  if (row.deleted_at) return '消息已撤回'
  switch (row.type) {
    case 'image':
      return '[图片]'
    case 'file':
      return '[文件]'
    case 'sticker':
      return '[表情]'
    default:
      return row.content.trim().slice(0, max)
  }
}

/** 幂等发送：同一发送者的同一 nonce 只落一条 */
export function findByNonce(db: DB, senderId: string, clientNonce: string): MessageRow | undefined {
  return stmt(db, 'SELECT * FROM messages WHERE sender_id = ? AND client_nonce = ?').get(
    senderId,
    clientNonce,
  ) as MessageRow | undefined
}

/** 会话维度查 nonce：AI 消息（sender_id 为 NULL）与系统消息用它做幂等 */
export function findByNonceInConversation(
  db: DB,
  conversationId: string,
  clientNonce: string,
): MessageRow | undefined {
  return stmt(db, 'SELECT * FROM messages WHERE conversation_id = ? AND client_nonce = ? LIMIT 1').get(
    conversationId,
    clientNonce,
  ) as MessageRow | undefined
}

export interface InsertMessageInput {
  conversationId: string
  senderId?: string | null
  senderType?: SenderType
  type: MessageType
  content: string
  meta?: MessageMeta | null
  replyToId?: string | null
  seq: number
  clientNonce?: string | null
  aiGenerationId?: string | null
  aiIndex?: number | null
  createdAt: number
  updatedByDevice?: string | null
}

export function insert(db: DB, input: InsertMessageInput): MessageRow {
  const id = ulid()
  // RETURNING 一次拿到落库后的完整行，省去额外的回读查询
  const row = stmt(db, `INSERT INTO messages
       (id, conversation_id, sender_id, sender_type, type, content, meta, reply_to_id,
        seq, client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at, deleted_by,
        created_at, updated_at, updated_by_device)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
     RETURNING *`).get(
    id,
    input.conversationId,
    input.senderId ?? null,
    input.senderType ?? 'user',
    input.type,
    input.content,
    input.meta ? JSON.stringify(input.meta) : null,
    input.replyToId ?? null,
    input.seq,
    input.clientNonce ?? null,
    input.aiGenerationId ?? null,
    input.aiIndex ?? null,
    input.createdAt,
    input.createdAt,
    input.updatedByDevice ?? null,
  ) as MessageRow | undefined
  if (!row) throw new Error('插入消息后回读失败')
  indexFts(db, row)
  return row
}

/** 提及写穿：@ 到谁就写一行，会话列表的 mention_count 从 message_mentions 计数 */
export function insertMentions(db: DB, row: MessageRow, mentionUserIds: string[]): void {
  const insert = stmt(
    db,
    'INSERT OR IGNORE INTO message_mentions (conversation_id, message_id, user_id, seq) VALUES (?, ?, ?, ?)',
  )
  for (const userId of mentionUserIds) {
    insert.run(row.conversation_id, row.id, userId, row.seq)
  }
}

/* --------------------------- 全文索引维护 --------------------------- */

/**
 * FTS5 没有唯一约束，更新前先删后插。
 * 索引与消息行必须同事务写入，否则搜索会与消息状态不一致。
 */
export function indexFts(db: DB, row: MessageRow): void {
  removeFts(db, row.id)
  if (row.deleted_at || row.content.trim().length === 0) return
  stmt(db, 'INSERT INTO message_fts (message_id, conversation_id, content) VALUES (?, ?, ?)').run(
    row.id,
    row.conversation_id,
    row.content,
  )
}

export function removeFts(db: DB, messageId: string): void {
  stmt(db, 'DELETE FROM message_fts WHERE message_id = ?').run(messageId)
}

export interface PageQuery {
  conversationId: string
  before?: number | null
  after?: number | null
  limit: number
}

/** 双向分页：before 向前翻历史，after 用于补洞 */
export function page(db: DB, query: PageQuery): MessageRow[] {
  const params: unknown[] = [query.conversationId]
  let where = 'conversation_id = ?'

  if (query.before != null) {
    where += ' AND seq < ?'
    params.push(query.before)
  }
  if (query.after != null) {
    where += ' AND seq > ?'
    params.push(query.after)
  }

  const order = query.after != null && query.before == null ? 'ASC' : 'DESC'
  params.push(query.limit)

  return stmt(db, `SELECT * FROM messages WHERE ${where} ORDER BY seq ${order} LIMIT ?`).all(
    ...params,
  ) as MessageRow[]
}

export function updateContent(
  db: DB,
  id: string,
  content: string,
  editedAt: number,
  deviceId?: string | null,
): MessageRow {
  const row = stmt(
    db,
    'UPDATE messages SET content = ?, edited_at = ?, updated_at = ?, updated_by_device = ? WHERE id = ? RETURNING *',
  ).get(content, editedAt, editedAt, deviceId ?? null, id) as MessageRow | undefined
  if (!row) throw new Error('更新消息后回读失败')
  indexFts(db, row)
  return row
}

/** 撤回是写墓碑，不是物理删除，客户端才能同步到「已撤回」状态 */
export function softDelete(db: DB, id: string, deletedBy: string, at: number): MessageRow {
  const row = stmt(
    db,
    'UPDATE messages SET deleted_at = ?, deleted_by = ?, content = ?, updated_at = ? WHERE id = ? RETURNING *',
  ).get(at, deletedBy, '', at, id) as MessageRow | undefined
  if (!row) throw new Error('撤回消息后回读失败')
  removeFts(db, id)
  return row
}

export function setPinned(db: DB, id: string, pinnedAt: number | null): MessageRow {
  const row = stmt(
    db,
    'UPDATE messages SET pinned_at = ?, updated_at = ? WHERE id = ? RETURNING *',
  ).get(pinnedAt, Date.now(), id) as MessageRow | undefined
  if (!row) throw new Error('置顶消息后回读失败')
  return row
}

export function listPinned(db: DB, conversationId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL
       ORDER BY pinned_at DESC`,
    )
    .all(conversationId) as MessageRow[]
}

export function lastSeq(db: DB, conversationId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ?')
    .get(conversationId) as { s: number }
  return row.s
}
