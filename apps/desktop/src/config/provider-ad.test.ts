import { describe, expect, it } from 'vitest'
import { hasRollSegment, parseAdTemplate, rollPartOf } from './provider-ad'

describe('parseAdTemplate', () => {
  it('不带大括号的文案是整段静态文字', () => {
    expect(parseAdTemplate('低价AI中转站，全场 5 折')).toEqual([
      { kind: 'text', text: '低价AI中转站，全场 5 折' },
    ])
    expect(hasRollSegment(parseAdTemplate('静态文案'))).toBe(false)
  })

  it('滚动段拆成 roll 段，选项去空格', () => {
    expect(parseAdTemplate('低价中转，{GLM 5.3| DeepSeek |Qwen} 低至 ¥1')).toEqual([
      { kind: 'text', text: '低价中转，' },
      { kind: 'roll', parts: ['GLM 5.3', 'DeepSeek', 'Qwen'] },
      { kind: 'text', text: ' 低至 ¥1' },
    ])
    expect(hasRollSegment(parseAdTemplate('低价中转，{GLM 5.3| DeepSeek |Qwen} 低至 ¥1'))).toBe(true)
  })

  it('多段滚动段按出现顺序排列', () => {
    expect(parseAdTemplate('{A|B} 输出仅 ¥{1|2}')).toEqual([
      { kind: 'roll', parts: ['A', 'B'] },
      { kind: 'text', text: ' 输出仅 ¥' },
      { kind: 'roll', parts: ['1', '2'] },
    ])
  })

  it('未配对的大括号按普通文字输出', () => {
    expect(parseAdTemplate('只有左括号 { 不配对')).toEqual([{ kind: 'text', text: '只有左括号 { 不配对' }])
    expect(parseAdTemplate('文字 {A|B 后面直接结束')).toEqual([
      { kind: 'text', text: '文字 {A|B 后面直接结束' },
    ])
  })

  it('空选项保留为空段，纯滚动文案没有静态段', () => {
    expect(parseAdTemplate('{A|}')).toEqual([{ kind: 'roll', parts: ['A', ''] }])
    expect(parseAdTemplate('{A|B|C}')).toEqual([{ kind: 'roll', parts: ['A', 'B', 'C'] }])
  })
})

describe('rollPartOf', () => {
  it('按下标取当前选项，各段长短不一时按取模循环', () => {
    const long = parseAdTemplate('{A|B|C|D|E}')[0]
    const short = parseAdTemplate('{甲|乙}')[0]
    expect(long?.kind).toBe('roll')
    expect(short?.kind).toBe('roll')
    expect(rollPartOf(long!, 0)).toBe('A')
    expect(rollPartOf(long!, 4)).toBe('E')
    // 同一个下标下短段取模回到开头
    expect(rollPartOf(short!, 2)).toBe('甲')
    expect(rollPartOf(short!, 3)).toBe('乙')
  })

  it('静态段与空滚动段返回空串', () => {
    expect(rollPartOf({ kind: 'text', text: 'x' }, 3)).toBe('')
    expect(rollPartOf({ kind: 'roll', parts: [] }, 3)).toBe('')
  })
})
