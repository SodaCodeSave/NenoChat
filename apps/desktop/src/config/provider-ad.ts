/**
 * AI 服务商设置页推广横幅的数据与文案模板解析。
 * 文案里的 {甲|乙|丙} 段落上下滚动轮换，多段同步滚动；不带大括号则是静态文案。
 */

export interface ProviderAdData {
  /** 品牌名/标题；空串表示不显示标题行 */
  title: string
  /** 文案模板，{a|b|c} 为滚动段 */
  text: string
  /** 跳转链接；空串表示横幅不可点击 */
  link: string
  /** 图标 URL；空串表示用内置图标 */
  iconUrl: string
}

/** 轮换间隔（毫秒） */
export const PROVIDER_AD_ROTATION_MS = 4000

export type AdSegment =
  | { kind: 'text'; text: string }
  | { kind: 'roll'; parts: string[] }

/**
 * 把文案模板拆成静态段与滚动段序列。
 * 未配对的大括号按普通文字输出；选项两端去空格，空选项保留为空段。
 */
export function parseAdTemplate(text: string): AdSegment[] {
  const segments: AdSegment[] = []
  let staticText = ''
  const flushStatic = (): void => {
    if (staticText.length > 0) {
      segments.push({ kind: 'text', text: staticText })
      staticText = ''
    }
  }

  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor)
    // 剩余部分没有滚动段，全部按静态文字收尾
    if (open === -1) {
      staticText += text.slice(cursor)
      break
    }
    const close = text.indexOf('}', open + 1)
    // 只有左大括号没有右大括号，当作普通文字
    if (close === -1) {
      staticText += text.slice(cursor)
      break
    }
    staticText += text.slice(cursor, open)
    flushStatic()
    const parts = text
      .slice(open + 1, close)
      .split('|')
      .map((part) => part.trim())
    segments.push({ kind: 'roll', parts })
    cursor = close + 1
  }
  flushStatic()
  return segments
}

/** 某个滚动段当前展示的选项；各段长短不一时按下标取模循环 */
export function rollPartOf(segment: AdSegment, index: number): string {
  if (segment.kind !== 'roll' || segment.parts.length === 0) return ''
  return segment.parts[index % segment.parts.length] ?? ''
}

/** 文案里是否存在滚动段：没有就不启动轮换定时器 */
export function hasRollSegment(segments: AdSegment[]): boolean {
  return segments.some((segment) => segment.kind === 'roll' && segment.parts.length > 0)
}
