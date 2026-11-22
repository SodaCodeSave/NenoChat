import type { FastifyRequest } from 'fastify'
import type { AccessTokenPayload } from '../../services/auth-service'
import { err } from '../../util/errors'

/**
 * 进程内滑动窗口限流：不引依赖，自建服务器场景够用。
 * 键优先取已认证用户 id，未认证（注册/登录/刷新）回退到 IP 维度；
 * 每个 rateLimit() 实例有独立前缀，各路由计数互不影响。
 */

interface Counter {
  /** 窗口内每次请求的时间戳 */
  hits: number[]
  /** 最近一次访问的窗口截止时刻，兜底清理据此回收整桶 */
  expireAt: number
}

const counters = new Map<string, Counter>()
let scopeSeq = 0

/** 兜底清理：窗口内没有再被访问的桶直接移除，防止长期运行下 Map 无界增长 */
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [key, counter] of counters) {
    if (counter.expireAt <= now) counters.delete(key)
  }
}, 60_000)
sweeper.unref()

/**
 * preHandler 先于路由内的 requireUserId 执行，这里主动验一次 JWT 取用户 id；
 * 失败（未带 token / token 无效）时回退 IP 维度，认证错误交由路由自身的校验抛出。
 */
async function resolveKey(request: FastifyRequest): Promise<string> {
  const authed = request as { auth?: AccessTokenPayload }
  if (authed.auth?.sub) return `u:${authed.auth.sub}`
  try {
    const payload = await request.jwtVerify<AccessTokenPayload>()
    return `u:${payload.sub}`
  } catch {
    return `ip:${request.ip}`
  }
}

export interface RateLimitOptions {
  /** 窗口内允许的最大请求数 */
  max: number
  /** 窗口长度（毫秒） */
  windowMs: number
}

/** 滑动窗口限流 preHandler 工厂：窗口内超过 max 次则抛 429（RATE_LIMITED） */
export function rateLimit(opts: RateLimitOptions) {
  const scope = `rl${(scopeSeq += 1)}:`
  return async function rateLimitPreHandler(request: FastifyRequest): Promise<void> {
    const now = Date.now()
    const key = scope + (await resolveKey(request))
    const counter = counters.get(key) ?? { hits: [], expireAt: 0 }
    counter.hits = counter.hits.filter((t) => t > now - opts.windowMs)

    if (counter.hits.length >= opts.max) {
      throw err.rateLimited(`操作过于频繁，请 ${Math.ceil(opts.windowMs / 1000)} 秒后再试`)
    }

    counter.hits.push(now)
    counter.expireAt = now + opts.windowMs
    counters.set(key, counter)
  }
}

/** 清空全部计数，仅供测试隔离使用（如单测里要在一分钟内连发超过限流的请求） */
export function resetForTests(): void {
  counters.clear()
}
