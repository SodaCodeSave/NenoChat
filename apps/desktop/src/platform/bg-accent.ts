/**
 * 聊天背景图 → 主题色。
 *
 * 上传背景时从图里提取主色（只在上传设备做一次，结果随 user_settings 同步，
 * 其它设备启动即用，不必重复解码图片），再由主色派生浅色/深色两档 accent 与
 * 两档 soft 底色（气泡、选中态），写成 :root[data-accent='custom'] 的内联变量。
 *
 * 派生走 OKLCH：对感知亮度/彩度做钳制，保证白底上当文字色可读、深色下足够亮，
 * 且 soft 色始终是「同色相的极浅/极深底」，和内置 violet/green 等预设的搭配规则一致。
 */

export interface AccentVariants {
  /** 浅色模式的主 accent（按钮、链接、选中态） */
  light: string
  /** 深色模式的主 accent */
  dark: string
  /** 浅色模式的 accent-soft / bubble-own 底色 */
  softLight: string
  /** 深色模式的 accent-soft / bubble-own 底色 */
  softDark: string
}

interface Rgb {
  r: number
  g: number
  b: number
}

interface Oklch {
  l: number
  c: number
  h: number
}

export function normalizeHex(value: string): string | null {
  const raw = value.trim().toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(raw)) return null
  return raw
}

function hexToRgb(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function linearToSrgb(value: number): number {
  const v = clamp01(value)
  const gamma = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.round(clamp01(gamma) * 255)
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

/** sRGB → OKLCH（Björn Ottosson 的 OKLab 标准变换，常数取自参考实现） */
function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const lr = lin(r)
  const lg = lin(g)
  const lb = lin(b)

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  return { l: L, c: Math.sqrt(a * a + b2 * b2), h: Math.atan2(b2, a) }
}

function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)

  const l_ = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m_ = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s_ = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3)

  return {
    r: 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    g: -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    b: -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  }
}

function clampChroma(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 从主色派生四个 accent 档位。亮度/彩度都钳制到预设色板类似的区间：
 * 灰图（彩度极低）也会被抬到最低彩度，避免 accent 变成几乎看不见的灰。
 */
export function accentVariants(baseHex: string): AccentVariants | null {
  const normalized = normalizeHex(baseHex)
  if (!normalized) return null

  const base = rgbToOklch(hexToRgb(normalized))

  return {
    light: rgbToHex(
      oklchToRgb({
        l: clampChroma(base.l, 0.52, 0.62),
        c: clampChroma(base.c, 0.1, 0.16),
        h: base.h,
      }),
    ),
    dark: rgbToHex(
      oklchToRgb({
        l: clampChroma(base.l, 0.68, 0.78),
        c: clampChroma(base.c, 0.09, 0.15),
        h: base.h,
      }),
    ),
    softLight: rgbToHex(
      oklchToRgb({
        l: 0.955,
        c: clampChroma(base.c * 0.35, 0.02, 0.05),
        h: base.h,
      }),
    ),
    softDark: rgbToHex(
      oklchToRgb({
        l: 0.28,
        c: clampChroma(base.c * 0.35, 0.02, 0.06),
        h: base.h,
      }),
    ),
  }
}

/**
 * 从图片文件提取主色：缩到最长边 64px 后按 RGB 高 4 位分桶，
 * 以「像素数 × 饱和度权重」选桶（压住大面积白底/黑边），桶内取平均。
 * 解码失败（格式不支持等）返回 null，由调用方保留现有主题色。
 */
export async function extractDominantColor(file: File | Blob): Promise<string | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    const scale = 64 / Math.max(bitmap.width, bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    const { data } = ctx.getImageData(0, 0, width, height)

    interface Bucket {
      count: number
      r: number
      g: number
      b: number
      satWeight: number
    }
    const buckets = new Map<number, Bucket>()
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max === 0 ? 0 : (max - min) / max
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, satWeight: 0 }
      bucket.count += 1
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.satWeight += 0.3 + 0.7 * sat
      buckets.set(key, bucket)
    }

    let best: Bucket | null = null
    let bestScore = 0
    for (const bucket of buckets.values()) {
      const score = (bucket.count / (width * height)) * bucket.satWeight
      if (score > bestScore) {
        bestScore = score
        best = bucket
      }
    }
    if (!best) return null

    return rgbToHex({
      r: best.r / best.count / 255,
      g: best.g / best.count / 255,
      b: best.b / best.count / 255,
    })
  } finally {
    bitmap.close()
  }
}
