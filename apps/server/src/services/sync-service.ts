import type { ChangeRecord } from '@nenochat/shared'
import type { DB } from '../db'

export interface ChangesResult {
  changes: ChangeRecord[]
  nextCursor: number
  hasMore: boolean
}

interface ChangeRow {
  seq: number
  entity: string
  entity_id: string
  op: string
  conversation_id: string | null
  user_id: string | null
  payload: string
  created_at: number
}

/**
 * 增量变更查询：WS 的 catchUp 与 REST 的兜底补拉共用这一条路径，
 * 保证两种途径产生的数据完全一致。
 */
export function listChanges(db: DB, userId: string, since: number, limit: number): ChangesResult {
  const rows = db
    .prepare(
      `SELECT seq, entity, entity_id, op, conversation_id, user_id, payload, created_at
       FROM sync_change_log
       WHERE seq > ?
         AND (conversation_id IS NULL OR conversation_id IN (
               SELECT conversation_id FROM conversation_members
               WHERE user_id = ? AND left_at IS NULL))
         AND (user_id IS NULL OR user_id = ?)
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(since, userId, userId, limit + 1) as ChangeRow[]

  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1]!.seq : since

  const changes: ChangeRecord[] = sliced.map((row) => ({
    seq: row.seq,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op === 'delete' ? 'delete' : 'upsert',
    conversationId: row.conversation_id,
    userId: row.user_id,
    payload: safeParse(row.payload),
    createdAt: row.created_at,
  }))

  return { changes, nextCursor, hasMore }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** change_log 中仍保留的最小 seq，用于判断客户端游标是否已过期 */
export function minCursor(db: DB): number {
  const row = db.prepare('SELECT COALESCE(MIN(seq), 0) AS s FROM sync_change_log').get() as { s: number }
  return row.s
}

export function maxCursor(db: DB): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_change_log').get() as { s: number }
  return row.s
}

/** 裁剪过期变更，防止 change_log 无限增长 */
export function prune(db: DB, before: number): number {
  const result = db.prepare('DELETE FROM sync_change_log WHERE created_at < ?').run(before)
  return result.changes
}
