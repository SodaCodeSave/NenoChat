import type { CachePolicy, CachedFileMeta } from './types'

const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

/** 附件缓存默认策略：512MB 上限、闲置 30 天过期 */
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  maxBytes: 512 * MB,
  maxAgeMs: 30 * DAY,
}

export const CACHE_POLICY_LIMITS = {
  minBytes: 16 * MB,
  maxBytes: 8 * 1024 * MB,
  maxAgeMs: 365 * DAY,
} as const

/** 容量档位，供设置页下拉选择（字节） */
export const CACHE_SIZE_OPTIONS = [128 * MB, 256 * MB, 512 * MB, 1024 * MB, 2048 * MB] as const

/** 过期档位（毫秒），0 表示永不过期 */
export const CACHE_AGE_OPTIONS = [
  { label: '7 天', value: 7 * DAY },
  { label: '30 天', value: 30 * DAY },
  { label: '90 天', value: 90 * DAY },
  { label: '永不过期', value: 0 },
] as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 清洗外部传入的策略，避免脏值把缓存直接清空或无限增长 */
export function normalizeCachePolicy(input: Partial<CachePolicy> | null | undefined): CachePolicy {
  const maxBytes = Number(input?.maxBytes)
  const maxAgeMs = Number(input?.maxAgeMs)

  return {
    maxBytes: Number.isFinite(maxBytes)
      ? maxBytes <= 0
        ? 0
        : clamp(maxBytes, CACHE_POLICY_LIMITS.minBytes, CACHE_POLICY_LIMITS.maxBytes)
      : DEFAULT_CACHE_POLICY.maxBytes,
    maxAgeMs: Number.isFinite(maxAgeMs)
      ? maxAgeMs <= 0
        ? 0
        : clamp(maxAgeMs, 1, CACHE_POLICY_LIMITS.maxAgeMs)
      : DEFAULT_CACHE_POLICY.maxAgeMs,
  }
}

export interface CacheEvictionPlan {
  /** 需要删除的缓存键 */
  evict: string[]
  freedBytes: number
  keptBytes: number
  kept: number
  expired: number
}

/**
 * 计算需要淘汰的缓存条目：先清理闲置过期的，再按 LRU 压到容量上限以下。
 * 纯函数，不修改入参，方便直接单测。
 */
export function planCacheEviction(
  entries: CachedFileMeta[],
  policy: CachePolicy,
  now = Date.now(),
): CacheEvictionPlan {
  const evicted = new Set<string>()
  let freedBytes = 0
  let expired = 0
  const survivors: CachedFileMeta[] = []

  for (const entry of entries) {
    const size = Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0
    const accessedAt = Number.isFinite(entry.accessedAt) ? entry.accessedAt : entry.storedAt
    if (policy.maxAgeMs > 0 && now - accessedAt > policy.maxAgeMs) {
      evicted.add(entry.key)
      freedBytes += size
      expired += 1
      continue
    }
    survivors.push(entry)
  }

  let keptBytes = survivors.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0),
    0,
  )

  if (policy.maxBytes > 0 && keptBytes > policy.maxBytes) {
    const lru = [...survivors].sort(
      (a, b) => (a.accessedAt || a.storedAt) - (b.accessedAt || b.storedAt),
    )
    for (const entry of lru) {
      if (keptBytes <= policy.maxBytes) break
      const size = Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0
      evicted.add(entry.key)
      freedBytes += size
      keptBytes -= size
    }
  }

  return {
    evict: [...evicted],
    freedBytes,
    keptBytes,
    kept: entries.length - evicted.size,
    expired,
  }
}
