import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import LoadingScreen from './LoadingScreen.vue'

describe('LoadingScreen', () => {
  it('只渲染品牌字标，不显示标题栏与启动状态文案', async () => {
    const html = await renderToString(createSSRApp(LoadingScreen))

    expect(html).toContain('boot-screen')
    expect(html).toContain('<svg')
    expect(html).toContain('currentColor')
    expect(html).not.toContain('正在启动')
    expect(html).not.toContain('title-bar')
  })
})
