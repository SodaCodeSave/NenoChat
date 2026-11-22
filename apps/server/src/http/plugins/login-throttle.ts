import { err } from '../../util/errors'

/**
 * 按账号维度的登录失败限流：路由上的 IP 限流挡得住单点爆破，
 * 但挡不住换 IP 继续猜同一个账号，这里以 username 为键补上第二道闸。
 * 只统计「密码没猜对」的失败（401），禁用账号（403）不计入；
 * 登录成功即清零。进程内滑动窗口，与 rate-limit.ts 同一套做法。
 */

interface Counter {
  /** 窗口内每次失败的时间戳 */
  hits: number[]
  /** 最近一次失败的窗口截止时刻，兜底清理据此回收整桶 */
  expireAt: number
}

/** 窗口内允许的最大失败次数：超过即暂时拒绝该账号的登录尝试 */
const MAX_FAILURES = 10
/** 失败窗口长度：10 分钟内错 10 次，就得等最早的失败滑出窗口 */
const WINDOW_MS = 10 * 60_000

const counters = new Map<string, Counter>()

const sweeper = setInterval(() => {
  const nowMs = Date.now()
  for (const [key, counter] of counters) {
    if (counter.expireAt <= nowMs) counters.delete(key)
  }
}, 60_000)
sweeper.unref()

/** 该账号当前是否被限流：超限抛 429，未超限放行 */
export function check(username: string): void {
  const counter = counters.get(username)
  if (!counter) return
  const nowMs = Date.now()
  const active = counter.hits.filter((t) => t > nowMs - WINDOW_MS)
  if (active.length >= MAX_FAILURES) {
    throw err.rateLimited(`登录失败次数过多，请 ${Math.ceil(WINDOW_MS / 60_000)} 分钟后再试`)
  }
}

export function recordFailure(username: string): void {
  const nowMs = Date.now()
  const counter = counters.get(username) ?? { hits: [], expireAt: 0 }
  counter.hits = counter.hits.filter((t) => t > nowMs - WINDOW_MS)
  counter.hits.push(nowMs)
  counter.expireAt = nowMs + WINDOW_MS
  counters.set(username, counter)
}

/** 登录成功后清零，正常用户的偶失误操作不会被历史失败累积惩罚 */
export function clear(username: string): void {
  counters.delete(username)
}

/** 清空全部计数，仅供测试隔离使用 */
export function resetForTests(): void {
  counters.clear()
}
