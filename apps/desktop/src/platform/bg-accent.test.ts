import { describe, expect, it } from 'vitest'
import { accentVariants, normalizeHex, surfaceTints } from './bg-accent'

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

describe('surfaceTints', () => {
  /** 主色相落点：取 A/B 通道的差值方向，判断染色偏向哪一色系 */
  function chromaBias(hex: string): { r: number; g: number; b: number } {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    }
  }

  it('八档底色都是合法 hex，且结果确定', () => {
    const tints = surfaceTints('#7c5cff')!
    expect(Object.keys(tints)).toHaveLength(8)
    for (const value of Object.values(tints)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
    expect(surfaceTints('#7C5CFF')).toEqual(tints)
  })

  it('明度阶梯和中性底一致：surface 最亮，selected 最暗', () => {
    const tints = surfaceTints('#16a34a')!
    expect(luminance(tints.surface)).toBeGreaterThan(luminance(tints.surface2))
    expect(luminance(tints.surface2)).toBeGreaterThan(luminance(tints.surface3))
    expect(luminance(tints.surface3)).toBeGreaterThan(luminance(tints.selected))
    // 浅色底必须留在「接近白」的区间，不能把画布压灰
    expect(luminance(tints.surface)).toBeGreaterThan(luminance('#f2f2f2'))
  })

  it('染色跟着主色的色相走，彩度压得很低', () => {
    const blue = surfaceTints('#2f6bff')!
    const orange = surfaceTints('#ea7317')!
    const blueRgb = chromaBias(blue.surface)
    const orangeRgb = chromaBias(orange.surface)
    // 蓝调底里蓝通道最高，橙调底里蓝通道最低
    expect(blueRgb.b).toBeGreaterThan(blueRgb.r)
    expect(orangeRgb.b).toBeLessThan(orangeRgb.r)
    // 极浅染色：最暗的 selected 也不该看出饱和色块
    expect(saturation(orange.selected)).toBeLessThan(0.1)
  })

  it('灰阶 / 非法输入不染色，回落到中性底', () => {
    expect(surfaceTints('#808080')).toBeNull()
    expect(surfaceTints('nope')).toBeNull()
    expect(surfaceTints('#12345')).toBeNull()
  })
})
