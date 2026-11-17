import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

/**
 * 角色在动态广场做过的事。
 * 一张表兼两个用途：每日配额计数，以及「同一条动态不重复评论/点赞」的互斥依据。
 */
export type MomentActionKind = 'post' | 'comment' | 'like'
export type MomentActionStatus = 'pending' | 'done' | 'skipped' | 'failed'

export interface RecordActionInput {
  personaId: string
  userId: string
  kind: MomentActionKind
  /** 发动态没有具体对象，传空串 */
  postId?: string
  dayKey: string
  status: MomentActionStatus
}

/**
 * 占一条动作记录。返回 false 表示同一角色对同一动态已经做过同类动作，
 * 调用方应放弃这次生成，避免模型白跑一次。
 */
export function recordAction(db: DB, input: RecordActionInput): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO ai_moment_actions
         (id, persona_id, user_id, post_id, kind, day_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ulid(),
      input.personaId,
      input.userId,
      input.postId ?? '',
      input.kind,
      input.dayKey,
      input.status,
      now(),
    )
  return result.changes > 0
}

/**
 * 把预留的那条动作改成最终状态。
 * 客户端代跑生成时只认领了 pending，落库成功后由动态服务回填 done。
 */
export function markStatus(
  db: DB,
  input: {
    personaId: string
    kind: MomentActionKind
    postId?: string
    dayKey: string
    status: MomentActionStatus
  },
): void {
  db.prepare(
    `UPDATE ai_moment_actions SET status = ?
     WHERE persona_id = ? AND kind = ? AND post_id = ? AND day_key = ? AND status = 'pending'`,
  ).run(input.status, input.personaId, input.kind, input.postId ?? '', input.dayKey)
}

/** 当日已用配额：pending 也算，避免并发扫描把同一天的额度超发 */
export function countToday(db: DB, personaId: string, kind: MomentActionKind, dayKey: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ai_moment_actions
       WHERE persona_id = ? AND kind = ? AND day_key = ? AND status IN ('pending', 'done')`,
    )
    .get(personaId, kind, dayKey) as { c: number }
  return row.c
}

/** 一次问出「这些动态里哪些已经评论过」，避免逐条查 */
export function commentedPostIds(db: DB, personaId: string, postIds: string[]): Set<string> {
  if (postIds.length === 0) return new Set()
  const placeholders = postIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT post_id FROM ai_moment_actions
       WHERE persona_id = ? AND kind = 'comment' AND post_id IN (${placeholders})`,
    )
    .all(personaId, ...postIds) as Array<{ post_id: string }>
  return new Set(rows.map((row) => row.post_id))
}

/** 进程重启后遗留的 pending 会一直占着配额，扫描开始时先释放 */
export function releaseStalePending(db: DB, olderThan: number): void {
  db.prepare(
    `UPDATE ai_moment_actions SET status = 'failed'
     WHERE status = 'pending' AND created_at < ?`,
  ).run(olderThan)
}
