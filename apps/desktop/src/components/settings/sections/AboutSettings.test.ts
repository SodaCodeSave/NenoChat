import { describe, expect, it } from 'vitest'
import source from './AboutSettings.vue?raw'

describe('AboutSettings', () => {
  it('关于页顶部展示品牌字标与渐变光晕背景', () => {
    expect(source).toContain('BrandLogo')
    expect(source).toContain('class="about-hero"')
    expect(source).toContain('about-hero__logo')
    expect(source).toContain('linear-gradient')
    expect(source).toContain('color-mix(in srgb, var(--accent)')
    expect(source).toContain('filter: blur')
    expect(source).toContain('@keyframes about-drift-a')
    expect(source).toContain('@keyframes about-drift-b')
  })

  it('光晕区不使用毛玻璃背景', () => {
    expect(source).not.toContain('backdrop-filter')
  })

  it('保留版本信息与数据模式两张卡片及锚点', () => {
    expect(source).toContain('id="version"')
    expect(source).toContain('id="storage-mode"')
    expect(source).toContain('title="版本信息"')
    expect(source).toContain('title="数据模式"')
    expect(source).toContain('客户端版本')
    expect(source).toContain('servers.serverInfo?.version')
    expect(source).toContain('normalizeServerUrl')
  })
})
