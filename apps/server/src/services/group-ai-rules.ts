import { GROUP_AI_DEFAULTS } from '@nenochat/shared'

/**
 * 群聊里 AI 成员的「心情」与触发判定。
 * 和主动私聊一样抽成纯函数：时间、配额、概率这些最容易出错的部分
 * 可以脱离数据库直接跑单测。
 */

const HOUR_MS = 3_600_000

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

/** 体力越低越不想说话，语气也跟着变 */
export function deriveMood(energy: number): string {
  if (energy >= 82) return '兴致高涨'
  if (energy >= 58) return '心情不错'
  if (energy >= 34) return '平静'
  if (energy >= GROUP_AI_DEFAULTS.lowEnergyThreshold) return '有点累'
  return '不太想说话'
}

/** 休息会回体力；按上次更新时间线性恢复 */
export function recoverEnergy(energy: number, sinceMs: number): number {
  const hours = Math.max(0, sinceMs) / HOUR_MS
  return clamp(energy + hours * GROUP_AI_DEFAULTS.energyRecoveryPerHour)
}

/** 这条消息值不值得接：点名 > 提问 > 兴趣命中 > 长消息 */
export function relevanceOf(content: string, personaName: string, interests: string[]): number {
  const text = content.trim()
  if (text.length === 0) return 0
  if (personaName.length > 0 && text.includes(`@${personaName}`)) return 1

  let score = 0
  if (/[?？]/.test(text)) score += 0.35
  for (const interest of interests) {
    const keyword = interest.trim()
    if (keyword.length > 0 && text.includes(keyword)) score += 0.3
  }
  if (text.length >= 12) score += 0.1
  if (text.length <= 2) score -= 0.2
  return Math.min(0.9, Math.max(0, score))
}

export interface GroupReplyDecisionInput {
  now: number
  enabled: boolean
  repliesToday: number
  maxRepliesPerDay: number
  lastReplyAt: number | null
  energy: number
  /** 被点名或被直接提问 */
  mustReply: boolean
  /** relevanceOf 的结果 */
  relevance: number
  random: () => number
}

export interface GroupReplyDecision {
  fire: boolean
  reason: string
}

/**
 * 判定顺序：总开关 → 配额 → 冷却 → 体力/概率。
 * 被点名时跳过体力与概率，但仍受配额和较短的冷却约束。
 */
export function decideGroupReply(input: GroupReplyDecisionInput): GroupReplyDecision {
  if (!input.enabled) return { fire: false, reason: 'disabled' }
  if (input.maxRepliesPerDay <= 0) return { fire: false, reason: 'quota_zero' }
  if (input.repliesToday >= input.maxRepliesPerDay) {
    return { fire: false, reason: 'quota_exhausted' }
  }

  const cooldown = input.mustReply ? 8_000 : GROUP_AI_DEFAULTS.replyCooldownMs
  if (input.lastReplyAt !== null && input.now - input.lastReplyAt < cooldown) {
    return { fire: false, reason: 'cooldown' }
  }

  if (input.mustReply) return { fire: true, reason: 'mentioned' }

  if (input.energy < GROUP_AI_DEFAULTS.lowEnergyThreshold) {
    return { fire: false, reason: 'low_energy' }
  }

  // 体力越高、话题越相关，越可能接话；上限 0.9，避免每条都抢
  const chance = Math.min(0.9, 0.1 + input.energy / 400 + input.relevance * 0.55)
  if (input.random() > chance) return { fire: false, reason: 'not_in_mood' }

  return { fire: true, reason: 'in_mood' }
}

export interface GroupAutonomyDecisionInput {
  now: number
  enabled: boolean
  autonomyToday: number
  maxAutonomyPerDay: number
  lastAutonomyAt: number | null
  /** 群里最后一条消息距今 */
  idleMs: number
  energy: number
  inQuietWindow: boolean
  random: () => number
}

/** 主动开口：比插话更克制，安静够久、体力够、不在免打扰里才考虑 */
export function decideGroupAutonomy(input: GroupAutonomyDecisionInput): GroupReplyDecision {
  if (!input.enabled) return { fire: false, reason: 'disabled' }
  if (input.maxAutonomyPerDay <= 0) return { fire: false, reason: 'quota_zero' }
  if (input.autonomyToday >= input.maxAutonomyPerDay) {
    return { fire: false, reason: 'quota_exhausted' }
  }
  if (input.inQuietWindow) return { fire: false, reason: 'quiet_window' }
  if (input.idleMs < GROUP_AI_DEFAULTS.autonomyIdleMs) {
    return { fire: false, reason: 'group_not_idle' }
  }
  if (
    input.lastAutonomyAt !== null &&
    input.now - input.lastAutonomyAt < GROUP_AI_DEFAULTS.autonomyCooldownMs
  ) {
    return { fire: false, reason: 'cooldown' }
  }
  if (input.energy < 40) return { fire: false, reason: 'low_energy' }

  const chance = Math.min(0.5, 0.12 + input.energy / 300)
  if (input.random() > chance) return { fire: false, reason: 'not_in_mood' }

  return { fire: true, reason: 'in_mood' }
}
