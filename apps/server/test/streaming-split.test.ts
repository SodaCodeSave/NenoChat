import { describe, expect, it } from 'vitest'
import { cutStreamingSegments, SEGMENT_REPLY_DEFAULTS, splitSegments } from '@nenochat/shared'

describe('cutStreamingSegments 流式增量切分', () => {
  const rule = SEGMENT_REPLY_DEFAULTS

  it('分隔符命中且后面还有字符时才切出去', () => {
    const first = cutStreamingSegments('你好。', rule, false)
    expect(first.ready).toHaveLength(0)
    expect(first.rest).toBe('你好。')

    const second = cutStreamingSegments('你好。世', rule, false)
    expect(second.ready).toEqual(['你好。'])
    expect(second.rest).toBe('世')
  })

  it('一次 burst 带来多句时全部切出', () => {
    const result = cutStreamingSegments('好呀。我在。改', rule, false)
    expect(result.ready).toEqual(['好呀。', '我在。'])
    expect(result.rest).toBe('改')
  })

  it('结束时把剩余部分全部吐出', () => {
    const result = cutStreamingSegments('还没写完的半句', rule, true)
    expect(result.ready).toEqual(['还没写完的半句'])
    expect(result.rest).toBe('')
  })

  it('与整段切分结果一致', () => {
    const full = '第一句！第二句？\n第三句。'
    const streamed = cutStreamingSegments(full, rule, true)
    expect(streamed.ready).toEqual(splitSegments(full, rule))
  })

  it('分段关闭时不切，结束时整段一条', () => {
    const off = { enabled: false, pattern: rule.pattern }
    const mid = cutStreamingSegments('你好。世界！', off, false)
    expect(mid.ready).toHaveLength(0)
    expect(mid.rest).toBe('你好。世界！')

    const end = cutStreamingSegments('你好。世界！', off, true)
    expect(end.ready).toEqual(['你好。世界！'])
    expect(end.rest).toBe('')
  })

  it('多段连续调用与一次性切分等价', () => {
    const chunks = ['今天天', '气不错。我们', '出去走走吧？好', '啊，顺便买点', '喝的。']
    let pending = ''
    const collected: string[] = []
    for (const chunk of chunks) {
      pending += chunk
      const { ready, rest } = cutStreamingSegments(pending, rule, false)
      collected.push(...ready)
      pending = rest
    }
    const final = cutStreamingSegments(pending, rule, true)
    collected.push(...final.ready)

    expect(collected).toEqual(splitSegments(chunks.join(''), rule))
  })
})
