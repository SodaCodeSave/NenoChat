import { describe, expect, it } from 'vitest'
import source from './MessageItem.vue?raw'

describe('MessageItem 动态分享卡片', () => {
  it('动态卡片交给统一卡片组件渲染，正文不再内联版式', () => {
    expect(source).toContain("import MomentShareCard from '@/components/cards/MomentShareCard.vue'")
    expect(source).toContain('<MomentShareCard v-if="momentCard" :card="momentCard" />')
    expect(source).not.toContain('查看动态')
    expect(source).not.toContain('cardCoverUrl')
  })

  it('正文带定位标记时即使 meta 丢失也能渲染卡片', () => {
    expect(source).toContain('parseMomentShare(props.message.content)')
    expect(source).toContain('metaCard?.postId ?? shared?.postId')
    expect(source).toContain('coverUrl: metaCard?.coverUrl || shared?.coverUrl')
  })

  it('卡片不套 QQ 气泡', () => {
    expect(source).toContain('!momentCard.value')
  })
})
