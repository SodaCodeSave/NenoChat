import { Cron } from 'croner'
import type { Executor } from '../db'
import { run } from '../db'
import { prune } from './sync-service'

/**
 * 服务端例行清理，统一挂在 6 小时周期的 cron 上：
 * - sync_change_log：增量同步变更日志，只保留 14 天（此前从未裁剪，无限增长）；
 * - refresh_tokens：已撤销超过 30 天与已过期的令牌；
 * - ai_group_decision：每条群消息 × 每个角色都会写一行决策记录，只留 7 天；
 * - ai_generations：崩溃后永远停在生成中的记录标记为失败，客户端才能收到终态。
 */

const HOUSEKEEPING_DEFAULTS = {
  /** 变更日志保留时长 */
  changeLogRetentionMs: 14 * 24 * 60 * 60 * 1000,
  /** 已撤销令牌保留时长 */
  revokedTokenRetentionMs: 30 * 24 * 60 * 60 * 1000,
  /** 群聊决策记录保留时长 */
  groupDecisionRetentionMs: 7 * 24 * 60 * 60 * 1000,
  /** 生成卡死判定阈值：超过即视为崩溃残留 */
  staleGenerationMs: 30 * 60 * 1000,
  intervalCron: '0 */6 * * *',
  /** 启动后先跑一轮的延迟 */
  kickoffDelayMs: 30_000,
} as const

export interface HousekeepingResult {
  prunedChanges: number
  deletedTokens: number
  deletedDecisions: number
  sweptGenerations: number
}

/** 跑一轮全部清理任务，返回各项删除的行数 */
export async function runHousekeeping(db: Executor): Promise<HousekeepingResult> {
  const ts = Date.now()

  // 变更日志复用同步服务里的裁剪逻辑，created_at 为毫秒时间戳
  const prunedChanges = await prune(db, ts - HOUSEKEEPING_DEFAULTS.changeLogRetentionMs)

  // expires_at = 0 是「永不过期」的哨兵值，见 db/repo/refresh-tokens.ts
  const deletedTokens = (
    await run(
      db,
      `DELETE FROM refresh_tokens
       WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
          OR (expires_at > 0 AND expires_at < ?)`,
      [ts - HOUSEKEEPING_DEFAULTS.revokedTokenRetentionMs, ts],
    )
  ).changes

  const deletedDecisions = (
    await run(db, 'DELETE FROM ai_group_decision WHERE created_at < ?', [
      ts - HOUSEKEEPING_DEFAULTS.groupDecisionRetentionMs,
    ])
  ).changes

  // 只标记生成中/排队中的残留；started_at 是毫秒时间戳，error 与 finished_at 列见 0004_ai.sql
  const sweptGenerations = (
    await run(
      db,
      `UPDATE ai_generations
       SET status = 'error', error = ?, finished_at = ?
       WHERE status IN ('streaming', 'pending') AND started_at < ?`,
      ['生成中断：服务重启或超时', ts, ts - HOUSEKEEPING_DEFAULTS.staleGenerationMs],
    )
  ).changes

  return { prunedChanges, deletedTokens, deletedDecisions, sweptGenerations }
}

/** 启动例行清理，返回停止函数，随 Fastify 关闭一起清理。测试环境不启动。 */
export function startHousekeepingCron(db: Executor): () => void {
  if (process.env.NODE_ENV === 'test') return () => {}

  const runOnce = (): void => {
    void runHousekeeping(db)
      .then((result) => {
        if (
          result.prunedChanges + result.deletedTokens + result.deletedDecisions + result.sweptGenerations >
          0
        ) {
          console.log(
            `[housekeeping] 清理变更日志 ${result.prunedChanges} 条、令牌 ${result.deletedTokens} 个、` +
              `群决策 ${result.deletedDecisions} 条、卡死生成 ${result.sweptGenerations} 条`,
          )
        }
      })
      .catch((e) => {
        console.error('[housekeeping] 清理失败', e)
      })
  }

  // protect: 上一轮没跑完就跳过这一轮，避免长耗时清理叠加
  const job = new Cron(HOUSEKEEPING_DEFAULTS.intervalCron, { protect: true }, runOnce)

  // 刚启动时不必等满 6 小时，先跑一轮兜底
  const kickoff = setTimeout(runOnce, HOUSEKEEPING_DEFAULTS.kickoffDelayMs)

  return () => {
    job.stop()
    clearTimeout(kickoff)
  }
}
