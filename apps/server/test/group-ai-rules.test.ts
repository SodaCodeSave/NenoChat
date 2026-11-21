import { describe, expect, it } from 'vitest'
import {
  decideGroupAutonomy,
  decideGroupReply,
  deriveMood,
  recoverEnergy,
  relevanceOf,
} from '../src/services/group-ai-rules'
import { GROUP_AI_DEFAULTS } from '@nenochat/shared'

const NOW = 1_800_000_000_000

function replyInput(overrides: Partial<Parameters<typeof decideGroupReply>[0]> = {}) {
  return {
    now: NOW,
    enabled: true,
    repliesToday: 0,
    maxRepliesPerDay: 5,
    lastReplyAt: null,
    cooldownMs: GROUP_AI_DEFAULTS.replyCooldownMs,
    probabilityPercent: null,
    energy: 80,
    mustReply: false,
    relevance: 0.6,
    random: () => 0,
    ...overrides,
  }
}

function autonomyInput(overrides: Partial<Parameters<typeof decideGroupAutonomy>[0]> = {}) {
  return {
    now: NOW,
    enabled: true,
    autonomyToday: 0,
    maxAutonomyPerDay: 1,
    lastAutonomyAt: null,
    idleMs: 3 * 3_600_000,
    energy: 80,
    inQuietWindow: false,
    random: () => 0,
    ...overrides,
  }
}

describe('群聊心情', () => {
  it('体力越高心情越好', () => {
    expect(deriveMood(95)).toBe('兴致高涨')
    expect(deriveMood(65)).toBe('心情不错')
    expect(deriveMood(45)).toBe('平静')
    expect(deriveMood(25)).toBe('有点累')
    expect(deriveMood(5)).toBe('不太想说话')
  })

  it('体力随时间恢复但有上限', () => {
    expect(recoverEnergy(50, 3_600_000)).toBe(50 + GROUP_AI_DEFAULTS.energyRecoveryPerHour)
    expect(recoverEnergy(99, 10 * 3_600_000)).toBe(100)
  })

  it('点名、提问、兴趣会提高相关度', () => {
    expect(relevanceOf('@小禾 在吗', '小禾', [])).toBe(1)
    expect(relevanceOf('你吃饭了吗？', '小禾', [])).toBeGreaterThan(0.3)
    expect(relevanceOf('最近在听独立音乐', '小禾', ['独立音乐'])).toBeGreaterThanOrEqual(0.3)
  })
})

describe('群聊插话判定', () => {
  it('总开关关闭时直接跳过', () => {
    expect(decideGroupReply(replyInput({ enabled: false })).fire).toBe(false)
  })

  it('当天额度用完就不再插话', () => {
    const decision = decideGroupReply(
      replyInput({ mustReply: true, repliesToday: 5, maxRepliesPerDay: 5 }),
    )
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('quota_exhausted')
  })

  it('冷却期内不连续接话', () => {
    const decision = decideGroupReply(replyInput({ lastReplyAt: NOW - 5_000, mustReply: true }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('被点名时即使没体力也会回', () => {
    const decision = decideGroupReply(replyInput({ mustReply: true, energy: 3, relevance: 0 }))
    expect(decision.fire).toBe(true)
    expect(decision.reason).toBe('mentioned')
  })

  it('没体力且没被点名时不接话', () => {
    const decision = decideGroupReply(replyInput({ energy: 3 }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('low_energy')
  })

  it('概率不足时安静，概率命中时接话', () => {
    expect(decideGroupReply(replyInput({ random: () => 0.99 })).fire).toBe(false)
    expect(decideGroupReply(replyInput({ random: () => 0.01 })).fire).toBe(true)
  })

  it('配额 -1 表示无上限', () => {
    const decision = decideGroupReply(
      replyInput({ repliesToday: 999, maxRepliesPerDay: -1, random: () => 0.01 }),
    )
    expect(decision.fire).toBe(true)
  })

  it('固定概率替代体力公式：即使相关度为 0 也按配置概率掷骰', () => {
    const hit = decideGroupReply(replyInput({ probabilityPercent: 50, relevance: 0, random: () => 0.49 }))
    const miss = decideGroupReply(replyInput({ probabilityPercent: 50, relevance: 0, random: () => 0.51 }))
    expect(hit.fire).toBe(true)
    expect(miss.fire).toBe(false)
    expect(miss.reason).toBe('not_in_mood')
  })

  it('冷却分钟数可配：0 表示不受冷却限制', () => {
    const decision = decideGroupReply(replyInput({ cooldownMs: 0, lastReplyAt: NOW - 1_000, random: () => 0.01 }))
    expect(decision.fire).toBe(true)
  })

  it('冷却分钟数覆盖默认值', () => {
    const decision = decideGroupReply(
      replyInput({ cooldownMs: 10 * 60_000, lastReplyAt: NOW - 60_000, random: () => 0.01 }),
    )
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })
})

describe('群聊主动开口判定', () => {
  it('群里刚聊过不会主动开口', () => {
    const decision = decideGroupAutonomy(autonomyInput({ idleMs: 10 * 60_000 }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('group_not_idle')
  })

  it('免打扰窗口内不开口', () => {
    expect(decideGroupAutonomy(autonomyInput({ inQuietWindow: true })).fire).toBe(false)
  })

  it('每天最多一条', () => {
    const decision = decideGroupAutonomy(autonomyInput({ autonomyToday: 1 }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('quota_exhausted')
  })

  it('配额 0 表示不主动开口', () => {
    const decision = decideGroupAutonomy(autonomyInput({ maxAutonomyPerDay: 0 }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('quota_zero')
  })

  it('配额 -1 表示无上限', () => {
    const decision = decideGroupAutonomy(
      autonomyInput({ autonomyToday: 999, maxAutonomyPerDay: -1, random: () => 0.01 }),
    )
    expect(decision.fire).toBe(true)
  })

  it('安静够久且状态好时会主动开口', () => {
    expect(decideGroupAutonomy(autonomyInput({ random: () => 0.01 })).fire).toBe(true)
  })
})
