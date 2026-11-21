import { describe, expect, it } from 'vitest'
import { dayKey, dayLabel } from '@/composables/message-display'

/**
 * 聊天截图与消息列表共用的展示解析纯函数。
 * 日期分隔规则直接影响截图长图的版式，回归必须覆盖跨天与相对日期。
 */

describe('message-display 日期分隔', () => {
  it('同一天的时间派生相同分组键，跨天不同', () => {
    const morning = new Date(2026, 10, 21, 8, 30).getTime()
    const evening = new Date(2026, 10, 21, 22, 5).getTime()
    const otherDay = new Date(2026, 10, 22, 0, 1).getTime()
    expect(dayKey(morning)).toBe(dayKey(evening))
    expect(dayKey(morning)).not.toBe(dayKey(otherDay))
  })

  it('当天的日期文案是「今天」', () => {
    expect(dayLabel(Date.now())).toBe('今天')
  })

  it('24 小时前的日期文案是「昨天」', () => {
    expect(dayLabel(Date.now() - 86_400_000)).toBe('昨天')
  })

  it('更早的日期用完整年月日', () => {
    const date = new Date()
    date.setMonth(0, 5)
    // 若今天是 1 月 5 日，退回前年会得到未来日期，跳过该边界
    if (date.getTime() > Date.now()) return
    expect(dayLabel(date.getTime())).toBe(`${date.getFullYear()}年1月5日`)
  })
})
