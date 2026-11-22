import type { AiProviderModel } from '@nenochat/shared'
import type { DB, Executor } from '../db'
import { all, one, run } from '../db'
import { now } from '../util/clock'
import { err } from '../util/errors'
import * as aiRepo from '../db/repo/ai'
import type * as aiService from './ai-service'

/**
 * 全服共享 AI 计费。
 *
 * 服务器供应商挂在迁移 0039 种下的影子账号（aiRepo.SYSTEM_AI_OWNER_ID）名下；
 * 共享模式开启时，没配自有供应商的成员回退到它并按模型单价扣个人余额。
 * 价格来自供应商 models_json 的 priceInput/priceOutput（元/百万 token），
 * 未配价格的模型不扣费。自有供应商的调用一律不计费（key 是用户自己的）。
 */

export { SYSTEM_AI_OWNER_ID } from '../db/repo/ai'

export function isBilledProvider(provider: { owner_id: string } | null | undefined): boolean {
  return provider?.owner_id === aiRepo.SYSTEM_AI_OWNER_ID
}

export interface AdminBalanceItem {
  userId: string
  username: string
  displayName: string
  balance: number
  updatedAt: number | null
}

export async function getBalance(db: Executor, userId: string): Promise<number> {
  const row = await one<{ balance: string }>(db, 'SELECT balance FROM ai_balances WHERE user_id = ?', [
    userId,
  ])
  return row ? Number(row.balance) : 0
}

/** 余额门槛：共享供应商调用前检查，耗尽即拒绝；自有供应商不经过这里 */
export async function assertSharedBalance(db: Executor, userId: string, provider: aiRepo.ProviderRow): Promise<void> {
  if (!isBilledProvider(provider)) return
  const balance = await getBalance(db, userId)
  if (balance <= 0) {
    throw err.validation('共享 AI 额度已用完，请联系管理员充值')
  }
}

/**
 * 按模型单价计算费用（元）；未配置价格的模型返回 0。
 * 缓存命中的 prompt 部分按缓存价计（未配缓存价则按输入价），
 * 剩余部分按输入价，completion 按输出价。
 */
function costOf(models: AiProviderModel[] | null, model: string, usage: aiService.UpstreamUsage): number {
  const entry = models?.find((m) => m.model === model)
  if (!entry) return 0
  const priceIn = entry.priceInput
  const priceOut = entry.priceOutput
  if (priceIn === null && priceOut === null) return 0
  const prompt = usage.promptTokens ?? 0
  const cached = Math.min(usage.cachedTokens ?? 0, prompt)
  const uncached = prompt - cached
  const cachedPrice = entry.priceCached ?? priceIn
  const cost =
    uncached / 1_000_000 * (priceIn ?? 0) +
    cached / 1_000_000 * (cachedPrice ?? 0) +
    (usage.completionTokens ?? 0) / 1_000_000 * (priceOut ?? 0)
  return cost
}

/**
 * 按真实 usage 扣减余额。扣费发生在用量落库之后（同一条上游调用链），
 * 原子 UPDATE 由数据库保序；并发极端情况下允许小幅负值，保持账实相符。
 */
export async function chargeUsage(
  db: Executor,
  userId: string,
  provider: aiRepo.ProviderRow,
  model: string,
  usage: aiService.UpstreamUsage,
): Promise<number> {
  const cost = costOf(aiRepo.parseProviderModels(provider.models_json), model, usage)
  if (cost <= 0) return await getBalance(db, userId)
  const ts = now()
  await run(
    db,
    `INSERT INTO ai_balances (user_id, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO NOTHING`,
    [userId, 0, ts],
  )
  const row = await one<{ balance: string }>(
    db,
    'UPDATE ai_balances SET balance = balance - ?, updated_at = ? WHERE user_id = ? RETURNING balance',
    [cost, ts, userId],
  )
  return row ? Number(row.balance) : 0
}

/** 管理员充值/扣减（delta 可正可负），返回新余额 */
export async function adjustBalance(db: DB, userId: string, delta: number): Promise<number> {
  const ts = now()
  await run(
    db,
    `INSERT INTO ai_balances (user_id, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO NOTHING`,
    [userId, 0, ts],
  )
  const row = await one<{ balance: string }>(
    db,
    'UPDATE ai_balances SET balance = balance + ?, updated_at = ? WHERE user_id = ? RETURNING balance',
    [delta, ts, userId],
  )
  return row ? Number(row.balance) : 0
}

export async function listBalances(
  db: DB,
  page: number,
  pageSize: number,
): Promise<{ items: AdminBalanceItem[]; total: number }> {
  const offset = (Math.max(1, page) - 1) * pageSize
  // 以活跃用户为基准 LEFT JOIN：没充过值的用户也出现在列表里（余额 0）
  const rows = await all<{
    user_id: string
    username: string
    display_name: string
    balance: string | null
    updated_at: number | null
  }>(
    db,
    `SELECT u.id AS user_id, u.username, u.display_name,
            COALESCE(b.balance, 0) AS balance, b.updated_at
       FROM users u LEFT JOIN ai_balances b ON b.user_id = u.id
      WHERE u.is_bot = 0 AND u.status = 'active'
      ORDER BY COALESCE(b.updated_at, 0) DESC, u.created_at DESC
      LIMIT ? OFFSET ?`,
    [pageSize, offset],
  )
  const totalRow = await one<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM users WHERE is_bot = 0 AND status = 'active'",
  )
  return {
    items: rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      balance: Number(row.balance ?? 0),
      updatedAt: row.updated_at,
    })),
    total: totalRow?.c ?? 0,
  }
}
