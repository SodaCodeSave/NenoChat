import type { Message } from '@nenochat/shared'
import { dbExecute, dbSelect } from '../../platform/db'

export interface MessageRow {
  server_id: string
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
  created_at: number
  updated_at: number
  local_status: string
  local_error: string | null
}

export function mapMessage(row: MessageRow): Message {
  let meta: Message['meta'] = null
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta)
    } catch {
      meta = null
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderType: row.sender_type as Message['senderType'],
    type: row.type as Message['type'],
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    localStatus: row.local_status as Message['localStatus'],
    localError: row.local_error,
  }
}

const COLUMNS = 20

function params(serverId: string, message: Message): unknown[] {
  return [
    serverId,
    message.id,
    message.conversationId,
    message.senderId ?? null,
    message.senderType,
    message.type,
    message.content,
    message.meta ? JSON.stringify(message.meta) : null,
    message.replyToId ?? null,
    message.seq,
    message.clientNonce ?? null,
    message.aiGenerationId ?? null,
    message.aiIndex ?? null,
    message.pinnedAt ?? null,
    message.editedAt ?? null,
    message.deletedAt ?? null,
    message.createdAt,
    message.updatedAt,
    message.localStatus ?? 'synced',
    message.localError ?? null,
  ]
}

/** 写入或更新一条消息（含墓碑） */
export async function upsertMessage(serverId: string, message: Message): Promise<void> {
  await dbExecute(
    `INSERT INTO messages
       (server_id, id, conversation_id, sender_id, sender_type, type, content, meta,
        reply_to_id, seq, client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at,
        created_at, updated_at, local_status, local_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT(server_id, id) DO UPDATE SET
       content = excluded.content,
       meta = excluded.meta,
       reply_to_id = excluded.reply_to_id,
       seq = excluded.seq,
       pinned_at = excluded.pinned_at,
       edited_at = excluded.edited_at,
       deleted_at = excluded.deleted_at,
       updated_at = excluded.updated_at,
       local_status = excluded.local_status,
       local_error = excluded.local_error`,
    params(serverId, message),
  )
  await indexMessage(serverId, message)
}

/** 乐观插入：此时还没有服务端 seq，用本地序号占位保证排在最后 */
export async function insertPending(serverId: string, message: Message): Promise<void> {
  await dbExecute(
    `INSERT INTO messages
       (server_id, id, conversation_id, sender_id, sender_type, type, content, meta,
        reply_to_id, seq, client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at,
        created_at, updated_at, local_status, local_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',NULL)`,
    // 前 18 个参数对应实体列，local_status 与 local_error 由 SQL 字面量写入
    params(serverId, message).slice(0, 18),
  )
}

/** 服务端确认后：删掉同 nonce 的临时行，再写入权威行 */
export async function confirmPending(serverId: string, nonce: string, message: Message): Promise<void> {
  // 同 nonce 的临时行必须清干净：ux_msg_nonce 唯一索引会让「临时行 + 权威行」插入冲突
  await deleteByNonce(serverId, nonce)
  await upsertMessage(serverId, { ...message, localStatus: 'synced' })
}

/** 同一 nonce 只允许一条本地记录（临时行与权威行互斥） */
export async function deleteByNonce(serverId: string, nonce: string): Promise<void> {
  await dbExecute('DELETE FROM messages WHERE server_id = $1 AND client_nonce = $2', [serverId, nonce])
}

export async function markFailed(serverId: string, localId: string, reason: string): Promise<void> {
  await dbExecute(
    'UPDATE messages SET local_status = $3, local_error = $4 WHERE server_id = $1 AND id = $2',
    [serverId, localId, 'failed', reason],
  )
}

export async function deleteLocal(serverId: string, messageId: string): Promise<void> {
  await dbExecute('DELETE FROM messages WHERE server_id = $1 AND id = $2', [serverId, messageId])
}

export interface PageOptions {
  conversationId: string
  before?: number | null
  limit?: number
}

export async function listMessages(serverId: string, options: PageOptions): Promise<{ messages: Message[]; hasMore: boolean }> {
  const limit = options.limit ?? 50
  const sql = options.before
    ? `SELECT * FROM messages
       WHERE server_id = $1 AND conversation_id = $2 AND seq < $3
       ORDER BY seq DESC LIMIT $4`
    : `SELECT * FROM messages
       WHERE server_id = $1 AND conversation_id = $2
       ORDER BY seq DESC LIMIT $3`

  const rows = options.before
    ? await dbSelect<MessageRow>(sql, [serverId, options.conversationId, options.before, limit + 1])
    : await dbSelect<MessageRow>(sql, [serverId, options.conversationId, limit + 1])

  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  return { messages: sliced.reverse().map(mapMessage), hasMore }
}

export async function maxLocalSeq(serverId: string, conversationId: string): Promise<number> {
  const rows = await dbSelect<{ s: number }>(
    'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE server_id = $1 AND conversation_id = $2',
    [serverId, conversationId],
  )
  return rows[0]?.s ?? 0
}

export async function listPinnedMessages(serverId: string, conversationId: string): Promise<Message[]> {
  const rows = await dbSelect<MessageRow>(
    `SELECT * FROM messages
     WHERE server_id = $1 AND conversation_id = $2 AND pinned_at IS NOT NULL AND deleted_at IS NULL
     ORDER BY pinned_at DESC`,
    [serverId, conversationId],
  )
  return rows.map(mapMessage)
}

/* ------------------------------ 全文索引 ------------------------------ */

/**
 * 本地全文索引。trigram 分词要求关键词至少 3 个字符，
 * 更短的查询由调用方回退到 LIKE。
 */
async function indexMessage(serverId: string, message: Message): Promise<void> {
  await dbExecute('DELETE FROM message_fts WHERE message_id = $1 AND server_id = $2', [message.id, serverId])
  if (message.deletedAt) return
  const text = message.content.trim()
  if (text.length === 0) return
  await dbExecute(
    'INSERT INTO message_fts (message_id, server_id, conversation_id, content) VALUES ($1,$2,$3,$4)',
    [message.id, serverId, message.conversationId, text],
  )
}

export interface SearchHit {
  messageId: string
  conversationId: string
  content: string
}

/** 本地消息搜索：≥3 字符走 FTS5，短词走 LIKE 限定范围 */
export async function searchMessages(
  serverId: string,
  keyword: string,
  options: { conversationId?: string | null; limit?: number } = {},
): Promise<SearchHit[]> {
  const trimmed = keyword.trim()
  if (trimmed.length === 0) return []
  const limit = options.limit ?? 50

  if (trimmed.length >= 3) {
    const rows = await dbSelect<{ message_id: string; conversation_id: string; content: string }>(
      `SELECT message_id, conversation_id, content FROM message_fts
       WHERE message_fts MATCH $1 AND server_id = $2 AND ($3 IS NULL OR conversation_id = $3)
       ORDER BY rank LIMIT $4`,
      [`"${trimmed.replace(/"/g, '')}"`, serverId, options.conversationId ?? null, limit],
    )
    if (rows.length > 0) {
      return rows.map((r) => ({ messageId: r.message_id, conversationId: r.conversation_id, content: r.content }))
    }
  }

  const like = `%${trimmed.replace(/[%_]/g, '')}%`
  const rows = await dbSelect<{ id: string; conversation_id: string; content: string }>(
    `SELECT id, conversation_id, content FROM messages
     WHERE server_id = $1 AND deleted_at IS NULL
       AND ($2 IS NULL OR conversation_id = $2)
       AND content LIKE $3
     ORDER BY created_at DESC LIMIT $4`,
    [serverId, options.conversationId ?? null, like, limit],
  )
  return rows.map((r) => ({ messageId: r.id, conversationId: r.conversation_id, content: r.content }))
}
