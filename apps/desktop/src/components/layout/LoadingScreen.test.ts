import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import LoadingScreen from './LoadingScreen.vue'
import source from './LoadingScreen.vue?raw'

describe('LoadingScreen', () => {
  it('只渲染品牌字标，不显示标题栏与启动状态文案', async () => {
    const html = await renderToString(createSSRApp(LoadingScreen))

    expect(html).toContain('boot-screen')
    expect(html).toContain('<svg')
    expect(html).toContain('currentColor')
    expect(html).not.toContain('正在启动')
    expect(html).not.toContain('title-bar')
  })

  it('桌面端居中、手机端贴底并避开安全区', () => {
    expect(source).toContain('align-items: center')
    expect(source).toContain('justify-content: center')
    expect(source).toContain('@media (max-width: 767px)')
    expect(source).toContain('env(safe-area-inset-bottom, 0px) + 48px')
    expect(source).not.toContain('top: 62%')
  })
})
