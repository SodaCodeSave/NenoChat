import type { ChangeRecord } from '@nenochat/shared'
import type { Executor } from '../db'
import { all, one, run } from '../db'

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
export async function listChanges(db: Executor, userId: string, since: number, limit: number): Promise<ChangesResult> {
  const rows = await all<ChangeRow>(
    db,
    `SELECT c.seq, c.entity, c.entity_id, c.op, c.conversation_id, c.user_id, c.payload, c.created_at
       FROM sync_change_log c
       WHERE c.seq > ?
         AND (c.conversation_id IS NULL OR EXISTS (
               SELECT 1 FROM conversation_members m
               WHERE m.conversation_id = c.conversation_id
                 AND m.user_id = ?
                 AND (m.left_at IS NULL OR c.created_at <= m.left_at)))
         AND (c.user_id IS NULL OR c.user_id = ?)
       ORDER BY c.seq ASC
       LIMIT ?`,
    [since, userId, userId, limit + 1],
  )

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
export async function minCursor(db: Executor): Promise<number> {
  const row = await one<{ s: number }>(db, 'SELECT COALESCE(MIN(seq), 0) AS s FROM sync_change_log')
  return row?.s ?? 0
}

export async function maxCursor(db: Executor): Promise<number> {
  const row = await one<{ s: number }>(db, 'SELECT COALESCE(MAX(seq), 0) AS s FROM sync_change_log')
  return row?.s ?? 0
}

/** 裁剪过期变更，防止 change_log 无限增长 */
export function prune(db: Executor, before: number): Promise<number> {
  return run(db, 'DELETE FROM sync_change_log WHERE created_at < ?', [before]).then((r) => r.changes)
}
