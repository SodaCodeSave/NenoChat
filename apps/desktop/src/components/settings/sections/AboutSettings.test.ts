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
    expect(source).toContain('CLIENT_VERSION')
    expect(source).not.toContain('>0.1.0<')
    expect(source).toContain('servers.serverInfo?.version')
    expect(source).toContain('normalizeServerUrl')
  })

  it('一体版的服务端版本显示为内嵌，不再暴露远端版本号', () => {
    expect(source).toContain('servers.integrated')
    expect(source).toContain('内嵌')
    // 内嵌分支与远端分支互斥，避免两个值同时渲染
    expect(source).toContain('v-if="servers.integrated"')
    expect(source).toContain('v-else')
  })
})
