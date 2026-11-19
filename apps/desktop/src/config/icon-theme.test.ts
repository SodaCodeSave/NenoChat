import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { AI_PROVIDER_PRESETS, matchProviderIcon } from './ai-providers'
import { CONNECTOR_PRESETS, connectorPresetOf } from './connectors'

const isSvgSource = (value: string): boolean => value.trimStart().startsWith('<svg')

describe('服务商与连接器图标主题化', () => {
  it('全部图标以 SVG 源码导入，可内联着色', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(isSvgSource(preset.icon), `${preset.id} 主图标`).toBe(true)
      if (preset.textIcon) expect(isSvgSource(preset.textIcon), `${preset.id} 字标`).toBe(true)
    }
    for (const preset of CONNECTOR_PRESETS) {
      expect(isSvgSource(preset.icon), `${preset.id} 主图标`).toBe(true)
      if (preset.textIcon) expect(isSvgSource(preset.textIcon), `${preset.id} 字标`).toBe(true)
    }
  })

  it('字形图标保留 currentColor，内联后随主题文字色变化', async () => {
    const textIcons = [
      ...AI_PROVIDER_PRESETS.map((preset) => preset.textIcon),
      ...CONNECTOR_PRESETS.map((preset) => preset.textIcon),
    ].filter((value): value is string => Boolean(value))

    expect(textIcons.length).toBeGreaterThan(0)

    for (const source of textIcons) {
      expect(source).toContain('fill="currentColor"')
      const html = await renderToString(createSSRApp({ render: () => h(SvgIcon, { source }) }))
      expect(html).toContain('<svg')
      expect(html).toContain('fill="currentColor"')
    }
  })

  it('和风天气图标不用硬编码黑色', () => {
    const connector = connectorPresetOf('heweather')!
    expect(connector.icon).toContain('fill="currentColor"')
    expect(connector.icon).not.toContain('#000000')
    expect(connector.textIcon).toContain('fill="currentColor"')
    expect(connector.textIcon).not.toContain('#000000')
  })

  it('未色彩化的主图标保留 currentColor', () => {
    for (const id of ['openai', 'anthropic', 'zhipu', 'ollama']) {
      const preset = AI_PROVIDER_PRESETS.find((item) => item.id === id)!
      expect(preset.icon, id).toContain('fill="currentColor"')
    }
  })

  it('匹配的服务商图标仍是可直接内联的 SVG 源码', () => {
    const icon = matchProviderIcon('OpenAI', 'https://api.openai.com/v1')
    expect(icon).not.toBeNull()
    expect(isSvgSource(icon!)).toBe(true)
  })
})
