import { describe, expect, it } from 'vitest'
import source from './MessageItem.vue?raw'

describe('MessageItem 动态分享卡片', () => {
  it('带 momentCard 的文本消息渲染成卡片而不是普通正文', () => {
    expect(source).toContain('momentCard')
    expect(source).toContain('props.message.meta?.momentCard')
    expect(source).toContain('查看动态 →')
    expect(source).toContain('momentCard.excerpt')
    expect(source).toContain('momentCard.authorName')
    expect(source).toContain('cardCoverUrl')
  })

  it('卡片链接回到动态页并定位原帖子，卡片不套 QQ 气泡', () => {
    expect(source).toContain('`#/moments?post=${encodeURIComponent(momentCard.postId)}`')
    expect(source).toContain('!momentCard.value')
  })
})
