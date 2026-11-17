import { describe, expect, it } from 'vitest'
import { ReplyStyle } from '../enums'
import { segmentDelay, splitIncremental, splitReply, splitSegments, SPLIT_DEFAULTS } from './splitter'

describe('splitReply', () => {
  it('短回复不切分', () => {
    expect(splitReply('好呀，那就这么定了。')).toEqual(['好呀，那就这么定了。'])
  })

  it('空输入返回空数组', () => {
    expect(splitReply('')).toEqual([])
    expect(splitReply('   \n\n  ')).toEqual([])
  })

  it('去掉 Markdown 装饰', () => {
    const out = splitReply('## 标题\n\n**重点**是这件事。')
    expect(out.join('')).not.toContain('#')
    expect(out.join('')).not.toContain('**')
  })

  it('长回复按段落切分为多条', () => {
    const para = '这是一段比较长的说明文字，用来测试段落切分是否正常工作。'.repeat(4)
    const text = [para, para, para].join('\n\n')
    const out = splitReply(text, ReplyStyle.Chatty)
    expect(out.length).toBeGreaterThan(1)
    expect(out.length).toBeLessThanOrEqual(SPLIT_DEFAULTS.chatty.maxSegments)
    out.forEach((s) => expect(s.length).toBeLessThanOrEqual(SPLIT_DEFAULTS.chatty.hardLimit))
  })

  it('按句号断句而不是在句中截断', () => {
    const text = `${'甲'.repeat(90)}。${'乙'.repeat(90)}。${'丙'.repeat(90)}。`
    const out = splitReply(text, ReplyStyle.Concise)
    expect(out.length).toBeGreaterThan(1)
    out.slice(0, -1).forEach((s) => expect(s.endsWith('。')).toBe(true))
  })

  it('超过 maxSegments 时尾部合并，不丢内容', () => {
    const text = Array.from({ length: 20 }, (_, i) => `第${i}句内容在此处。`).join('')
    const out = splitReply(text, ReplyStyle.Concise)
    expect(out.length).toBeLessThanOrEqual(SPLIT_DEFAULTS.concise.maxSegments)
    expect(out.join('')).toContain('第19句')
    expect(out.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })

  it('无标点的超长文本被硬切', () => {
    const text = '啊'.repeat(2000)
    const out = splitReply(text, ReplyStyle.Chatty)
    expect(out.length).toBeGreaterThan(1)
    out.forEach((s) => expect(s.length).toBeLessThanOrEqual(SPLIT_DEFAULTS.chatty.hardLimit))
  })

  it('不会切出超短独立条', () => {
    const text = `${'甲'.repeat(200)}。嗯。${'乙'.repeat(200)}。`
    const out = splitReply(text, ReplyStyle.Chatty)
    out.forEach((s) => expect(s.trim().length).toBeGreaterThanOrEqual(1))
    expect(out.some((s) => s.trim() === '嗯。')).toBe(false)
  })
})

describe('splitIncremental', () => {
  it('只吐出已闭合的段落', () => {
    const { ready, rest } = splitIncremental('第一段内容够长了可以发出去。\n\n第二段还', ReplyStyle.Chatty)
    expect(ready.length).toBe(1)
    expect(ready[0]).toContain('第一段')
    expect(rest).toBe('第二段还')
  })

  it('没有段落分隔时不吐出任何内容', () => {
    const { ready, rest } = splitIncremental('还在打字中的内容', ReplyStyle.Chatty)
    expect(ready).toEqual([])
    expect(rest).toBe('还在打字中的内容')
  })
})

describe('segmentDelay', () => {
  it('随长度增长并被钳制在 400~1600ms', () => {
    expect(segmentDelay('短')).toBe(400)
    expect(segmentDelay('中'.repeat(100))).toBeGreaterThan(400)
    expect(segmentDelay('长'.repeat(500))).toBe(1600)
  })
})

describe('splitSegments', () => {
  it('默认按句号、感叹号、问号和换行分段', () => {
    expect(splitSegments('第一句。第二句！第三句？\n第四句')).toEqual([
      '第一句。',
      '第二句！',
      '第三句？',
      '第四句',
    ])
  })

  it('去掉空换行', () => {
    expect(splitSegments('上面。\n\n\n\n下面。')).toEqual(['上面。', '下面。'])
  })

  it('连续的标点不会单独成条', () => {
    expect(splitSegments('真的吗？！我也不信。')).toEqual(['真的吗？！', '我也不信。'])
  })

  it('关闭分段时整段作为一条消息', () => {
    expect(splitSegments('第一句。\n\n第二句！', { enabled: false, pattern: '[。]' })).toEqual([
      '第一句。\n第二句！',
    ])
  })

  it('正则写错时退回默认规则', () => {
    expect(splitSegments('甲。乙！', { enabled: true, pattern: '([' })).toEqual(['甲。', '乙！'])
  })
})
