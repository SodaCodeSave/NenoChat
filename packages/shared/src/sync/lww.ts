/**
 * 字段级 LWW 与时钟钳制工具，供需要多端无中心写入的场景预留。
 *
 * 当前同步模型由服务端单点写入：所有时间戳取自服务端权威时钟，
 * 变更按 seq 单调下发，客户端按 id + nonce 去重后用完整快照覆盖。
 * 因此写路径不使用本模块的决胜逻辑——若用客户端本地时间参与比较，
 * 设备时钟偏移会让权威消息被误判为旧版本而丢弃。
 */

/** 参与 LWW 比较的最小字段集 */
export interface LwwFields {
  updatedAt: number
  updatedByDevice?: string | null
}

export type LwwDecision = 'apply' | 'skip'

/**
 * 决定一条远端记录是否覆盖本地记录。
 * updatedAt 大者胜；相等时用 deviceId 字典序决胜，保证多端收敛到同一结果。
 */
export function resolveLww<T extends LwwFields>(local: T | undefined | null, incoming: T): LwwDecision {
  if (!local) return 'apply'
  if (incoming.updatedAt > local.updatedAt) return 'apply'
  if (incoming.updatedAt < local.updatedAt) return 'skip'
  const a = incoming.updatedByDevice ?? ''
  const b = local.updatedByDevice ?? ''
  return a >= b ? 'apply' : 'skip'
}

/**
 * 字段级合并：只覆盖 incoming 中显式出现的字段，undefined 不参与覆盖。
 * 用于「编辑消息内容」这类只改少数字段的场景，避免把 deletedAt 之类的状态抹掉。
 */
export function fieldMerge<T extends object>(local: T, incoming: Partial<T>): T {
  const out = { ...local } as Record<string, unknown>
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

/** 允许的客户端时钟偏移容差，超出则该端时间被钳制到容差边界 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000

/** 把客户端上报的时间钳制到服务端时间附近，防止改系统时间造成 LWW 永远获胜 */
export function clampClientTime(clientTime: number, serverTime: number): number {
  const min = serverTime - CLOCK_SKEW_TOLERANCE_MS
  const max = serverTime + CLOCK_SKEW_TOLERANCE_MS
  if (!Number.isFinite(clientTime)) return serverTime
  return Math.min(max, Math.max(min, clientTime))
}

/** 墓碑保留时长，客户端在此之后可清理本地已删除记录 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
