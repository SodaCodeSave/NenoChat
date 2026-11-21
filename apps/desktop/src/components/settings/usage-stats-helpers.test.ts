import { describe, expect, it } from 'vitest'
import type { AiUsageKind, AiUsageStats } from '@nenochat/shared'
import {
  bucketLabel,
  bucketMsOf,
  bucketTooltip,
  bucketTotal,
  fillSeries,
  labelStep,
  usageKindLabel,
} from './usage-stats-helpers'

const HOUR = 3_600_000

function makeStats(partial: Partial<AiUsageStats>): AiUsageStats {
  return {
    window: '24h',
    from: 0,
    to: 0,
    bucketMs: HOUR,
    totals: { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    series: [],
    byModel: [],
    byKind: [],
    byPersona: [],
    ...partial,
  }
}

describe('fillSeries', () => {
  it('把非空桶之间的空档补零，序列连续等宽', () => {
    const stats = makeStats({
      from: 10 * HOUR,
      to: 20 * HOUR + 30 * 60_000,
      series: [
        { bucketStart: 11 * HOUR, calls: 2, promptTokens: 100, completionTokens: 50, cachedTokens: 10 },
        { bucketStart: 13 * HOUR, calls: 1, promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
      ],
    })
    const filled = fillSeries(stats)
    // from=10H 到 to 对齐后的 20H，共 11 桶
    expect(filled).toHaveLength(11)
    expect(filled[0]).toEqual({ bucketStart: 10 * HOUR, calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 })
    expect(filled[1]).toMatchObject({ bucketStart: 11 * HOUR, calls: 2, promptTokens: 100 })
    expect(filled[2]).toMatchObject({ calls: 0 })
    expect(filled[3]).toMatchObject({ bucketStart: 13 * HOUR, calls: 1 })
    expect(filled[10].bucketStart).toBe(20 * HOUR)
  })

  it('没有数据时返回全零序列，仍覆盖整个窗口', () => {
    const stats = makeStats({ from: 0, to: 3 * HOUR, series: [] })
    const filled = fillSeries(stats)
    expect(filled).toHaveLength(4)
    expect(filled.every((bucket) => bucket.calls === 0)).toBe(true)
  })

  it('服务端序列超出 to 对齐桶时也不丢桶', () => {
    const stats = makeStats({
      from: 0,
      to: 2 * HOUR,
      series: [{ bucketStart: 5 * HOUR, calls: 1, promptTokens: 1, completionTokens: 1, cachedTokens: 0 }],
    })
    const filled = fillSeries(stats)
    expect(filled).toHaveLength(6)
    expect(filled[5].calls).toBe(1)
  })
})

describe('bucketLabel / bucketTooltip', () => {
  it('24h 显示 HH:00，7d/30d 显示 M/D', () => {
    const at = new Date(2026, 10, 21, 14, 0, 0).getTime()
    expect(bucketLabel(at, '24h')).toBe('14:00')
    expect(bucketLabel(at, '7d')).toBe('11/21')
    expect(bucketLabel(at, '30d')).toBe('11/21')
  })

  it('tooltip 带输入/输出/调用次数明细', () => {
    const at = new Date(2026, 10, 21, 9, 0, 0).getTime()
    expect(bucketTooltip({ bucketStart: at, calls: 2, promptTokens: 100, completionTokens: 50, cachedTokens: 0 }, '24h')).toBe(
      '11/21 09:00\n输入 100 · 输出 50 · 调用 2 次',
    )
    expect(bucketTooltip({ bucketStart: at, calls: 3, promptTokens: 1, completionTokens: 2, cachedTokens: 0 }, '30d')).toBe(
      '11/21\n输入 1 · 输出 2 · 调用 3 次',
    )
  })
})

describe('杂项', () => {
  it('桶宽度：24h 每小时，7d/30d 每天', () => {
    expect(bucketMsOf('24h')).toBe(HOUR)
    expect(bucketMsOf('7d')).toBe(86_400_000)
    expect(bucketMsOf('30d')).toBe(86_400_000)
  })

  it('桶总量 = 输入 + 输出', () => {
    expect(bucketTotal({ promptTokens: 100, completionTokens: 50 })).toBe(150)
  })

  it('标签步长控制横轴密度', () => {
    expect(labelStep(8)).toBe(3)
    expect(labelStep(12)).toBe(4)
    expect(labelStep(31)).toBe(4)
    expect(labelStep(41)).toBe(6)
  })

  it('功能标签中文映射，未知 kind 原样返回', () => {
    expect(usageKindLabel('chat')).toBe('私聊对话')
    expect(usageKindLabel('group_autonomy')).toBe('群聊自主')
    expect(usageKindLabel('weird' as AiUsageKind)).toBe('weird')
  })
})
