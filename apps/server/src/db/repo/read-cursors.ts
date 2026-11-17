import type { DB } from '../index'
import { now } from '../../util/clock'

export interface ReadCursorRow {
  conversation_id: string
  user_id: string
  last_read_seq: number
  last_read_message_id: string | null
  last_read_at: number | null
  updated_at: number
  device_id: string | null
}

export function find(db: DB, conversationId: string, userId: string): ReadCursorRow | undefined {
  return db
    .prepare('SELECT * FROM read_cursors WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId) as ReadCursorRow | undefined
}

/**
 * 已读游标只前进不后退：乱序到达的旧已读请求不会把进度拉回去。
 * 返回是否真的推进了，用于决定要不要广播。
 */
export function advance(
  db: DB,
  input: {
    conversationId: string
    userId: string
    seq: number
    messageId?: string | null
    deviceId?: string | null
  },
): { advanced: boolean; row: ReadCursorRow } {
  const current = find(db, input.conversationId, input.userId)
  const ts = now()

  if (current && current.last_read_seq >= input.seq) {
    return { advanced: false, row: current }
  }

  db.prepare(
    `INSERT INTO read_cursors
       (conversation_id, user_id, last_read_seq, last_read_message_id, last_read_at, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET
       last_read_seq = excluded.last_read_seq,
       last_read_message_id = excluded.last_read_message_id,
       last_read_at = excluded.last_read_at,
       updated_at = excluded.updated_at,
       device_id = excluded.device_id`,
  ).run(
    input.conversationId,
    input.userId,
    input.seq,
    input.messageId ?? null,
    ts,
    ts,
    input.deviceId ?? null,
  )

  const row = find(db, input.conversationId, input.userId)
  if (!row) throw new Error('更新已读游标后回读失败')
  return { advanced: true, row }
}

/** 群聊「已读 N 人」由游标聚合推导，不需要每条消息存一份回执 */
export function countReadUpTo(db: DB, conversationId: string, seq: number): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS c FROM read_cursors WHERE conversation_id = ? AND last_read_seq >= ?',
    )
    .get(conversationId, seq) as { c: number }
  return row.c
}
