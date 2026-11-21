import type { Message, MessageMeta, MessageType, SenderType } from '@nenochat/shared'
import { ulid } from '@nenochat/shared'
import { all, one, run, type Executor } from '../index'

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

export function findById(db: Executor, id: string): Promise<MessageRow | undefined> {
  return one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', [id])
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
    case 'voice':
      return '[语音]'
    default:
      return row.content.trim().slice(0, max)
  }
}

/** 幂等发送：同一发送者的同一 nonce 只落一条 */
export function findByNonce(db: Executor, senderId: string, clientNonce: string): Promise<MessageRow | undefined> {
  return one<MessageRow>(db, 'SELECT * FROM messages WHERE sender_id = ? AND client_nonce = ?', [
    senderId,
    clientNonce,
  ])
}

/** 会话维度查 nonce：AI 消息（sender_id 为 NULL）与系统消息用它做幂等 */
export function findByNonceInConversation(
  db: Executor,
  conversationId: string,
  clientNonce: string,
): Promise<MessageRow | undefined> {
  return one<MessageRow>(
    db,
    'SELECT * FROM messages WHERE conversation_id = ? AND client_nonce = ? LIMIT 1',
    [conversationId, clientNonce],
  )
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

export async function insert(db: Executor, input: InsertMessageInput): Promise<MessageRow> {
  const id = ulid()
  // RETURNING 一次拿到落库后的完整行，省去额外的回读查询
  const row = await one<MessageRow>(
    db,
    `INSERT INTO messages
       (id, conversation_id, sender_id, sender_type, type, content, meta, reply_to_id,
        seq, client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at, deleted_by,
        created_at, updated_at, updated_by_device)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
     RETURNING *`,
    [
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
    ],
  )
  if (!row) throw new Error('插入消息后回读失败')
  return row
}

/** 提及写穿：@ 到谁就写一行，会话列表的 mention_count 从 message_mentions 计数 */
export async function insertMentions(db: Executor, row: MessageRow, mentionUserIds: string[]): Promise<void> {
  for (const userId of mentionUserIds) {
    await run(
      db,
      'INSERT INTO message_mentions (conversation_id, message_id, user_id, seq) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [row.conversation_id, row.id, userId, row.seq],
    )
  }
}

export interface PageQuery {
  conversationId: string
  before?: number | null
  after?: number | null
  limit: number
}

/** 双向分页：before 向前翻历史，after 用于补洞 */
export async function page(db: Executor, query: PageQuery): Promise<MessageRow[]> {
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

  return all<MessageRow>(db, `SELECT * FROM messages WHERE ${where} ORDER BY seq ${order} LIMIT ?`, params)
}

export async function updateContent(
  db: Executor,
  id: string,
  content: string,
  editedAt: number,
  deviceId?: string | null,
): Promise<MessageRow> {
  const row = await one<MessageRow>(
    db,
    'UPDATE messages SET content = ?, edited_at = ?, updated_at = ?, updated_by_device = ? WHERE id = ? RETURNING *',
    [content, editedAt, editedAt, deviceId ?? null, id],
  )
  if (!row) throw new Error('更新消息后回读失败')
  return row
}

/** 撤回是写墓碑，不是物理删除，客户端才能同步到「已撤回」状态 */
export async function softDelete(db: Executor, id: string, deletedBy: string, at: number): Promise<MessageRow> {
  const row = await one<MessageRow>(
    db,
    'UPDATE messages SET deleted_at = ?, deleted_by = ?, content = ?, updated_at = ? WHERE id = ? RETURNING *',
    [at, deletedBy, '', at, id],
  )
  if (!row) throw new Error('撤回消息后回读失败')
  return row
}

export async function setPinned(db: Executor, id: string, pinnedAt: number | null): Promise<MessageRow> {
  const row = await one<MessageRow>(
    db,
    'UPDATE messages SET pinned_at = ?, updated_at = ? WHERE id = ? RETURNING *',
    [pinnedAt, Date.now(), id],
  )
  if (!row) throw new Error('置顶消息后回读失败')
  return row
}

export function listPinned(db: Executor, conversationId: string): Promise<MessageRow[]> {
  return all<MessageRow>(
    db,
    `SELECT * FROM messages
       WHERE conversation_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL
       ORDER BY pinned_at DESC`,
    [conversationId],
  )
}

export async function lastSeq(db: Executor, conversationId: string): Promise<number> {
  const row = await one<{ s: number }>(
    db,
    'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ?',
    [conversationId],
  )
  return row?.s ?? 0
}
