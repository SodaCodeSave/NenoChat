import { PROACTIVE_DEFAULTS, formatLocalTime as formatLocalTimeShared, type ProactiveConfig } from '@nenochat/shared'

/**
 * 主动消息的「要不要发」判定。
 * 这里刻意做成纯函数：定时任务里最难测的就是时间与配额逻辑，
 * 抽出来之后可以脱离数据库直接跑单测。
 */

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/** 服务端时区偏移（分钟），东八区为 480；可用 AI_TZ_OFFSET_MIN 覆盖 */
export function serverTzOffsetMinutes(): number {
  return Number(process.env.AI_TZ_OFFSET_MIN ?? -new Date().getTimezoneOffset())
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 按固定时区偏移（分钟，东八区 = 480）算「本地日」。
 * 用 UTC 视角平移而不是 toLocaleString，跨零点不会算错。
 */
export function localDayKey(ts: number, tzOffsetMinutes: number): string {
  const shifted = new Date(ts + tzOffsetMinutes * MINUTE_MS)
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
}

export function minutesOfDay(ts: number, tzOffsetMinutes: number): number {
  const shifted = new Date(ts + tzOffsetMinutes * MINUTE_MS)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** 委托 shared 的实现，保证提示词里的时间字节格式与服务端/桌面端完全一致 */
export function formatLocalTime(ts: number, tzOffsetMinutes: number): string {
  return formatLocalTimeShared(ts, tzOffsetMinutes)
}

function parseHm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 免打扰窗口。start > end 视为跨零点（例如 23:00-08:00）。 */
export function inQuietWindow(
  now: number,
  start: string | undefined,
  end: string | undefined,
  tzOffsetMinutes: number,
): boolean {
  if (!start || !end) return false
  const from = parseHm(start)
  const to = parseHm(end)
  if (from === null || to === null || from === to) return false

  const current = minutesOfDay(now, tzOffsetMinutes)
  return from < to ? current >= from && current < to : current >= from || current < to
}

export interface ProactiveDecisionInput {
  now: number
  conversationCreatedAt: number
  /** 最后一条「用户」消息时间，没有则 null */
  lastUserMessageAt: number | null
  lastProactiveAt: number | null
  /** 最近一条主动消息日志（含失败/占位）的时间，chance 模式用它控制掷骰间隔 */
  lastRollAt?: number | null
  sentToday: number
  config: ProactiveConfig
  tzOffsetMinutes: number
  /** 服务商密钥是否托管在服务端（否则服务端无法离线生成） */
  serverCanRun: boolean
  ownerOnline: boolean
  /** 随机源，测试可注入；chance 模式用它掷概率 */
  random?: () => number
}

export interface ProactiveDecision {
  fire: boolean
  idleHours: number
  reason: string
}

/**
 * 判定顺序很重要：配额与免打扰优先，避免「已经很累了还在算空闲」。
 * idle 模式的空闲时长以「最后一条用户消息」为基准 —— 以最后一条消息为基准的话，
 * AI 自己发的主动消息会把计时清零，从此再也不会主动找你。
 */
export function decideProactiveFire(input: ProactiveDecisionInput): ProactiveDecision {
  const config = input.config
  const idleBase = input.lastUserMessageAt ?? input.conversationCreatedAt
  const idleHours = Math.max(0, Math.floor((input.now - idleBase) / HOUR_MS))
  const random = input.random ?? Math.random

  if (!config.enabled) return { fire: false, idleHours, reason: 'disabled' }
  // maxPerDay：0 = 不发，-1 = 无上限
  if (config.maxPerDay === 0) return { fire: false, idleHours, reason: 'quota_zero' }
  if (config.maxPerDay > 0 && input.sentToday >= config.maxPerDay) {
    return { fire: false, idleHours, reason: 'quota_exhausted' }
  }
  if (inQuietWindow(input.now, config.windowStart, config.windowEnd, input.tzOffsetMinutes)) {
    return { fire: false, idleHours, reason: 'quiet_window' }
  }
  if (!input.serverCanRun && !input.ownerOnline) {
    return { fire: false, idleHours, reason: 'local_key_offline' }
  }

  if ((config.triggerMode ?? 'idle') === 'chance') {
    const cooldownMs = (config.chanceCooldownMinutes ?? 0) * MINUTE_MS
    if (input.lastProactiveAt !== null && input.now - input.lastProactiveAt < cooldownMs) {
      return { fire: false, idleHours, reason: 'cooldown' }
    }
    const intervalMs = config.chanceUnit === 'minute' ? MINUTE_MS : HOUR_MS
    const rollBase = input.lastRollAt ?? input.lastProactiveAt
    if (rollBase !== null && rollBase !== undefined && input.now - rollBase < intervalMs) {
      return { fire: false, idleHours, reason: 'chance_interval' }
    }
    const probability = config.chanceProbability ?? PROACTIVE_DEFAULTS.chanceProbability
    const fire = random() < probability
    return { fire, idleHours, reason: fire ? 'ok' : 'chance_miss' }
  }

  if (input.lastUserMessageAt === null) return { fire: false, idleHours, reason: 'no_user_message' }
  if (idleHours < config.minIdleHours) return { fire: false, idleHours, reason: 'not_idle_enough' }
  if (input.lastProactiveAt !== null && input.now - input.lastProactiveAt < config.minIdleHours * HOUR_MS) {
    return { fire: false, idleHours, reason: 'cooldown' }
  }
  return { fire: true, idleHours, reason: 'ok' }
}
