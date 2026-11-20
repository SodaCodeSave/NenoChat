import { ulid } from '@nenochat/shared'
import { all, one, run, type DB } from '../index'
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
export async function recordAction(db: DB, input: RecordActionInput): Promise<boolean> {
  const result = await run(
    db,
    `INSERT INTO ai_moment_actions
       (id, persona_id, user_id, post_id, kind, day_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      ulid(),
      input.personaId,
      input.userId,
      input.postId ?? '',
      input.kind,
      input.dayKey,
      input.status,
      now(),
    ],
  )
  return result.changes > 0
}

/**
 * 把预留的那条动作改成最终状态。
 * 客户端代跑生成时只认领了 pending，落库成功后由动态服务回填 done。
 */
export async function markStatus(
  db: DB,
  input: {
    personaId: string
    kind: MomentActionKind
    postId?: string
    dayKey: string
    status: MomentActionStatus
  },
): Promise<void> {
  await run(
    db,
    `UPDATE ai_moment_actions SET status = ?
     WHERE persona_id = ? AND kind = ? AND post_id = ? AND day_key = ? AND status = 'pending'`,
    [input.status, input.personaId, input.kind, input.postId ?? '', input.dayKey],
  )
}

/** 当日已用配额：pending 也算，避免并发扫描把同一天的额度超发 */
export async function countToday(db: DB, personaId: string, kind: MomentActionKind, dayKey: string): Promise<number> {
  const row = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM ai_moment_actions
       WHERE persona_id = ? AND kind = ? AND day_key = ? AND status IN ('pending', 'done')`,
    [personaId, kind, dayKey],
  )
  return row?.c ?? 0
}

/** 一次问出「这些动态里哪些已经评论过」，避免逐条查 */
export async function commentedPostIds(db: DB, personaId: string, postIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0) return new Set()
  const placeholders = postIds.map(() => '?').join(',')
  const rows = await all<{ post_id: string }>(
    db,
    `SELECT post_id FROM ai_moment_actions
       WHERE persona_id = ? AND kind = 'comment' AND post_id IN (${placeholders})`,
    [personaId, ...postIds],
  )
  return new Set(rows.map((row) => row.post_id))
}

/** 进程重启后遗留的 pending 会一直占着配额，扫描开始时先释放 */
export async function releaseStalePending(db: DB, olderThan: number): Promise<void> {
  await run(
    db,
    `UPDATE ai_moment_actions SET status = 'failed'
       WHERE status = 'pending' AND created_at < ?`,
    [olderThan],
  )
}
