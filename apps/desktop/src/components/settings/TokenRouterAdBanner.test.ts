import { describe, expect, it } from 'vitest'
import source from './TokenRouterAdBanner.vue?raw'

describe('TokenRouterAdBanner', () => {
  it('使用 TokenRouter 图标与推广落地页链接', () => {
    expect(source).toContain("@/assets/icons/tokenrouter.svg")
    expect(source).toContain(':href="PROVIDER_AD_LINK"')
    expect(source).toContain('target="_blank"')
    expect(source).toContain('rel="noreferrer"')
    expect(source).toContain('前往注册')
  })

  it('只有模型名与单价两段参与轮换，固定文案不参与', () => {
    expect(source).toContain('PROVIDER_AD_DESCRIPTION_PARTS.prefix')
    expect(source).toContain('PROVIDER_AD_DESCRIPTION_PARTS.middle')
    expect(source).toContain('{{ currentModel.name }}')
    expect(source).toContain('{{ currentModel.price }}')
    expect(source).toContain('nextProviderAdIndex(index.value)')
    // 固定文案直接输出，不包在带 key 的轮换节点里
    expect(source).not.toContain('{{ description }}')
    expect(source).not.toContain('providerAdDescription')
  })

  it('两段用上下滚动切换而非淡入淡出', () => {
    expect(source.match(/<Transition name="roll">/g)).toHaveLength(2)
    expect(source.match(/:key="index"/g)).toHaveLength(2)
    expect(source).toContain('.roll-window')
    expect(source).toContain('overflow: hidden')
    expect(source).toContain('transform: translateY(100%)')
    expect(source).toContain('transform: translateY(-100%)')
    expect(source).not.toContain('ad-fade')
    expect(source).not.toContain('opacity: 0')
  })

  it('在卸载时清理轮换定时器', () => {
    expect(source).toContain('setInterval')
    expect(source).toContain('clearInterval')
    expect(source).toContain('onMounted')
    expect(source).toContain('onBeforeUnmount')
  })
})
