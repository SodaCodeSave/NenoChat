import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import uiStore from '@/stores/ui?raw'
import appearance from '@/components/settings/sections/AppearanceSettings.vue?raw'

/** CSS 走不了 ?raw（会被当样式模块吃掉），直接读源文件 */
const styles = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  if (start === -1) return ''
  return source.slice(start, source.indexOf('}', start))
}

describe('Claude 预设', () => {
  it('设置里能选到，色板用品牌陶土橙', () => {
    expect(appearance).toContain("{ key: 'claude', label: 'Claude', color: '#d97757' }")
  })

  it('浅色与深色两档都定义了主色与 soft 底', () => {
    const light = block(styles, ":root[data-accent='claude']")
    const dark = block(styles, ".dark[data-accent='claude']")
    expect(light).toContain('--accent: #d97757')
    expect(light).toContain('--accent-soft:')
    expect(light).toContain('--bubble-own:')
    expect(dark).toContain('--accent: #e08a6b')
    expect(dark).toContain('--accent-soft:')
    expect(dark).toContain('--bubble-own:')
  })

  it('配色不夹带字体，字体由独立的字体档控制', () => {
    expect(styles).not.toMatch(/:root\[data-accent='claude'\]\s*\{[^}]*--font-sans/)
    expect(uiStore).not.toContain("accent.value === 'claude'")
  })
})

describe('背景随主题色染色', () => {
  /** sRGB 亮度：只用来比较各层明暗顺序 */
  function luminance(hex: string): number {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  function value(source: string, name: string): string {
    return new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(source)?.[1] ?? ''
  }

  it('彩色预设各有一套浅色底，Claude 保持中性暖灰', () => {
    for (const key of ['blue', 'violet', 'green', 'orange', 'pink']) {
      const tint = block(styles, `:root:not(.dark)[data-accent='${key}']`)
      expect(tint, key).toContain('--surface:')
      expect(tint, key).toContain('--rail:')
      expect(tint, key).toContain('--selected:')
    }
    // Claude 沿用 :root 那套暖灰，自己不再覆盖底色
    expect(block(styles, ":root[data-accent='claude']")).not.toContain('--surface')
  })

  it('染色只在浅色生效，深色底维持中性', () => {
    const tinted = styles.match(/:root:not\(\.dark\)\[data-accent='(?:blue|violet|green|orange|pink)'\]/g)
    expect(tinted).toHaveLength(5)
    // 深色块里不许出现底色覆盖，否则会把染色漏进暗色
    for (const key of ['blue', 'violet', 'green', 'orange', 'pink', 'claude', 'custom']) {
      expect(block(styles, `.dark[data-accent='${key}']`)).not.toContain('--surface')
    }
  })

  it('染色不换明度阶梯：surface 最亮、selected 最暗', () => {
    for (const key of ['blue', 'violet', 'green', 'orange', 'pink']) {
      const tint = block(styles, `:root:not(.dark)[data-accent='${key}']`)
      const surface = value(tint, 'surface')
      const surface2 = value(tint, 'surface-2')
      const surface3 = value(tint, 'surface-3')
      const selected = value(tint, 'selected')
      expect(luminance(surface)).toBeGreaterThan(luminance(surface2))
      expect(luminance(surface2)).toBeGreaterThan(luminance(surface3))
      expect(luminance(surface3)).toBeGreaterThan(luminance(selected))
    }
  })

  it('背景图主题色的底色走内联变量，缺变量时回落到中性', () => {
    const custom = block(styles, ":root:not(.dark)[data-accent='custom']")
    expect(custom).toContain('--surface: var(--surface-custom, #fcfcfb)')
    expect(custom).toContain('--selected: var(--selected-custom, #ddd9d1)')
    expect(uiStore).toContain("['--surface-custom', 'surface']")
    expect(uiStore).toContain('surfaceTints(bgAccent)')
  })
})

describe('字体档', () => {
  it('每个预设有自己的字体栈，全部走系统字体', () => {
    const serif = block(styles, ":root[data-font='serif']")
    expect(serif).toContain('Georgia')
    expect(serif).toContain('Songti SC')
    expect(serif).toContain('SimSun')

    const kai = block(styles, ":root[data-font='kai']")
    expect(kai).toContain('KaiTi')
    expect(kai).toContain('楷体')

    expect(styles).not.toMatch(/@font-face/)
    expect(styles).not.toMatch(/\.woff2?/)
  })

  it('自定义档读 --font-user，没填时回落到系统无衬线', () => {
    const custom = block(styles, ":root[data-font='custom']")
    expect(custom).toContain('var(--font-user')
    expect(custom).toContain('sans-serif')
  })

  it('applyTheme 把预设写到 data-font，把自定义字族写到 --font-user', () => {
    expect(uiStore).toContain('root.dataset.font = fontPreset.value')
    expect(uiStore).toContain("root.style.setProperty('--font-user', fontCustom.value)")
    expect(uiStore).toContain('function setFontPreset(next: FontPreset): void')
    expect(uiStore).toContain('function setFontCustom(next: string): void')
  })

  it('自定义字族会剥掉打断声明的字符，但保留字体名需要的引号', () => {
    expect(uiStore).toContain('function sanitizeFontFamily(raw: string): string')
    expect(uiStore).toMatch(/sanitizeFontFamily[\s\S]*?replace\(\/\[\\u0000-\\u001f;\{\}<>\]\/g, ''\)/)
  })

  it('body 读的是 --font-sans 变量，覆盖后全站生效', () => {
    expect(styles).toMatch(/body\s*\{[^}]*font-family: var\(--font-sans\)/)
  })
})

describe('字体设置项', () => {
  it('四个预设加自定义输入框', () => {
    for (const label of ['无衬线', '衬线', '楷体', '自定义']) {
      expect(appearance).toContain(`label: '${label}'`)
    }
    expect(appearance).toContain("v-if=\"ui.fontPreset === 'custom'\"")
    expect(appearance).toContain(':model-value="ui.fontCustom"')
    expect(appearance).toContain('@update:model-value="ui.setFontCustom"')
  })
})
