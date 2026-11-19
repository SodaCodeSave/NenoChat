import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SvgIcon from './SvgIcon.vue'

const svg = '<svg fill="currentColor" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'

describe('SvgIcon', () => {
  it('把 SVG 源码内联进文档，保留 currentColor 供主题着色', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(SvgIcon, { source: svg }) }))

    expect(html).toContain('<svg')
    expect(html).toContain('fill="currentColor"')
    expect(html).not.toContain('<img')
  })

  it('字标模式按 SVG 比例决定宽度', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(SvgIcon, { source: svg, autoWidth: true }) }),
    )

    expect(html).toContain('auto-width')
  })

  it('有标签时暴露无障碍名称，无标签时隐藏图标', async () => {
    const named = await renderToString(
      createSSRApp({ render: () => h(SvgIcon, { source: svg, label: 'OpenAI' }) }),
    )
    const hidden = await renderToString(createSSRApp({ render: () => h(SvgIcon, { source: svg }) }))

    expect(named).toContain('role="img"')
    expect(named).toContain('aria-label="OpenAI"')
    expect(hidden).toContain('aria-hidden="true"')
  })
})
