import { describe, expect, it } from 'vitest'
import source from './AiSettings.vue?raw'

describe('AiSettings', () => {
  it('在 AI 服务商卡片内展示 TokenRouter 推广横幅', () => {
    expect(source).toContain(
      "import TokenRouterAdBanner from '@/components/settings/TokenRouterAdBanner.vue'",
    )
    expect(source).toContain('<TokenRouterAdBanner />')

    const providersAt = source.indexOf('id="providers"')
    const bannerAt = source.indexOf('<TokenRouterAdBanner />')
    const replyAt = source.indexOf('id="reply"')
    expect(bannerAt).toBeGreaterThan(providersAt)
    expect(bannerAt).toBeLessThan(replyAt)
  })
})
