import { describe, expect, it } from 'vitest'
import { extractVoiceMarker, renderVoiceBlock, stripVoiceMarkers } from './voice-markers'

describe('extractVoiceMarker', () => {
  it('标记在开头时整条转语音并剔除标记', () => {
    const result = extractVoiceMarker('[[voice]]今晚想听你讲讲今天的事')
    expect(result.voice).toBe(true)
    expect(result.text).toBe('今晚想听你讲讲今天的事')
  })

  it('标记写在中间也算命中', () => {
    const result = extractVoiceMarker('嗯… [[voice]] 那我直接说啦')
    expect(result.voice).toBe(true)
    expect(result.text).toBe('嗯… 那我直接说啦')
  })

  it('只有标记没有正文时不产生语音', () => {
    const result = extractVoiceMarker('[[voice]]')
    expect(result.voice).toBe(false)
    expect(result.text).toBe('')
  })

  it('没有标记时原文原样返回', () => {
    expect(extractVoiceMarker('普通一句话')).toEqual({ voice: false, text: '普通一句话' })
  })

  it('模型换了写法（少一层括号）不误判', () => {
    const result = extractVoiceMarker('[voice] 这样不算')
    expect(result.voice).toBe(false)
    expect(result.text).toBe('[voice] 这样不算')
  })

  it('大小写不敏感', () => {
    expect(extractVoiceMarker('[[VOICE]]hi').voice).toBe(true)
  })
})

describe('stripVoiceMarkers', () => {
  it('剔除所有标记，供流式气泡展示', () => {
    expect(stripVoiceMarkers('[[voice]]前 [[voice]]后')).toBe('前 后')
    expect(stripVoiceMarkers('嗯… [[voice]] 那我直接说啦')).toBe('嗯… 那我直接说啦')
  })
})

describe('renderVoiceBlock', () => {
  it('说明标记格式与使用限制', () => {
    const block = renderVoiceBlock()
    expect(block).toContain('[[voice]]')
    expect(block).toContain('最多写一个标记')
  })
})
