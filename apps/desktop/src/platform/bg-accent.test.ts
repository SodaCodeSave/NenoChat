import { describe, expect, it } from 'vitest'
import { accentVariants, normalizeHex } from './bg-accent'

/** sRGB 亮度排序用：不需要精确感知亮度，能比较明暗即可 */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 近似彩度：max-min，足够断言「灰图被抬出了可见彩度」 */
function saturation(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255
}

describe('accentVariants', () => {
  it('从主色派生四档合法 hex，且结果确定', () => {
    const first = accentVariants('#7c5cff')
    expect(first).not.toBeNull()
    for (const value of Object.values(first!)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/)
    }
    const second = accentVariants('#7C5CFF')
    expect(second).toEqual(first)
  })

  it('深色档比浅色档亮，soft 档是同色系的极浅/极深底', () => {
    const variants = accentVariants('#16a34a')!
    expect(luminance(variants.dark)).toBeGreaterThan(luminance(variants.light))
    expect(luminance(variants.softLight)).toBeGreaterThan(luminance(variants.light))
    expect(luminance(variants.softDark)).toBeLessThan(luminance(variants.dark))
  })

  it('过亮/过暗的主色被拉回可读区间', () => {
    const pale = accentVariants('#f0f0f0')!
    const dark = accentVariants('#101010')!
    // 浅色档必须落在中间亮度，白底上当文字/按钮色才可读
    expect(luminance(pale.light)).toBeLessThan(luminance('#f0f0f0'))
    expect(luminance(dark.light)).toBeGreaterThan(luminance('#101010'))
  })

  it('灰图也会被抬到可见彩度，accent 不会变成纯灰', () => {
    const variants = accentVariants('#808080')!
    expect(saturation(variants.light)).toBeGreaterThan(0.08)
    expect(saturation(variants.dark)).toBeGreaterThan(0.08)
  })

  it('非 hex 输入返回 null', () => {
    expect(accentVariants('red')).toBeNull()
    expect(accentVariants('#12345')).toBeNull()
    expect(normalizeHex('')).toBeNull()
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
  })
})
