import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import messageItem from '@/components/chat/MessageItem.vue?raw'
import messageInput from '@/components/chat/MessageInput.vue?raw'
import linkCard from '@/components/chat/LinkCard.vue?raw'
import icon from '@/components/ui/Icon.vue?raw'
import conversationView from '@/views/ConversationView.vue?raw'
import loginForm from '@/components/auth/LoginForm.vue?raw'
import conversationList from '@/components/layout/ConversationList.vue?raw'
import momentsComposer from '@/components/moments/MomentsComposer.vue?raw'
import newChatDialog from '@/components/layout/NewChatDialog.vue?raw'

/** CSS 走不了 ?raw（会被当样式模块吃掉），直接读源文件 */
const styles = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

/** 取某个选择器块的花括号内容，断言配色只在对应主题里生效 */
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  if (start === -1) return ''
  return source.slice(start, source.indexOf('}', start))
}

describe('层级不靠边框', () => {
  it('底色不用纯白，浅色走 f5f5f3 / fcfcfb', () => {
    const light = block(styles, ':root')
    expect(light).toContain('--surface: #fcfcfb')
    expect(light).toContain('--surface-2: #f5f5f3')
    expect(light).not.toContain('--surface: #ffffff')
  })

  it('暗色走 0b0b0a / 151515 / 1a1a19 / 20201e 四档', () => {
    const dark = block(styles, '.dark')
    expect(dark).toContain('--surface: #151515')
    expect(dark).toContain('--surface-2: #1a1a19')
    expect(dark).toContain('--surface-3: #20201e')
    expect(dark).toContain('--rail: #0b0b0a')
  })

  it('整套样式里没有纯黑底色', () => {
    expect(styles).not.toContain('#000')
    expect(styles).not.toContain('rgb(0 0 0')
  })

  it('输入框外壳不再画边框，只留明度分层', () => {
    expect(messageInput).toContain('class="field-shell relative rounded-xl"')
    expect(messageInput).not.toContain('focus-within:border-accent')
  })
})

describe('输入框聚焦', () => {
  it('双环阴影咬合，不加 outline', () => {
    expect(styles).toContain('--focus-ring:')
    expect(styles).toMatch(/\.field-shell:focus-within\s*\{[^}]*outline: none/)
    expect(styles).toMatch(/\.field-shell:focus-within\s*\{[^}]*box-shadow: var\(--focus-ring\)/)
  })

  it('散落的手写输入框也走同一套双环', () => {
    for (const source of [loginForm, conversationList, momentsComposer, newChatDialog]) {
      expect(source).not.toContain('focus:border-accent')
    }
    expect(conversationList).toContain('field-shell h-10 w-full rounded-xl')
  })
})

describe('暗色字重补偿', () => {
  it('暗色下整套字重降 40', () => {
    const dark = block(styles, '.dark')
    expect(dark).toContain('--font-weight-normal: 360')
    expect(dark).toContain('--font-weight-medium: 460')
    expect(dark).toContain('--font-weight-semibold: 560')
  })
})

describe('流式出字', () => {
  it('单字 90ms、相邻错开 30ms、指定缓动', () => {
    expect(styles).toContain('--dur-char-in: 90ms')
    expect(styles).toContain('--stagger-char-in: 30ms')
    expect(styles).toContain('--ease-char-in: cubic-bezier(0.215, 0.61, 0.355, 1)')
    expect(styles).toMatch(/@keyframes neno-char-in[\s\S]*blur\(6px\)[\s\S]*blur\(0\)/)
  })

  it('只有新出的字播动画，已经稳定下来的字不重播', () => {
    expect(messageItem).toContain('const streamPieces = computed<StreamPiece[]>')
    expect(messageItem).toContain('piece.delay ? { animationDelay: piece.delay } : undefined')
    // 拉丁词跨帧追加时切开，稳定前缀不重复播
    expect(messageItem).toContain('pieces.push({ text: token.text.slice(0, cut), delay: null })')
  })

  it('拉丁词整体成块，正文出字时不把字母拆开', () => {
    expect(messageItem).toContain("const pattern = /\\n|[^\\S\\n]+|[A-Za-z0-9][A-Za-z0-9'’._-]*|[\\s\\S]/gu")
  })
})

describe('排版细节', () => {
  it('行内图标压 1/8 em 对齐中心', () => {
    expect(styles).toMatch(/\.inline-icon\s*\{\s*vertical-align: -0\.125em/)
    expect(icon).toContain('class="inline-icon shrink-0"')
  })

  it('数字锁等宽，正文不留孤字', () => {
    expect(styles).toContain('font-variant-numeric: tabular-nums')
    expect(styles).toContain('text-wrap: pretty')
    expect(messageItem).toContain('text-pretty')
  })
})

describe('折叠与弹簧', () => {
  it('总结面板用 grid 0fr → 1fr 过渡，不靠 JS 量高度', () => {
    expect(linkCard).toContain("grid-rows-[0fr]")
    expect(linkCard).toContain("grid-rows-[1fr]")
    expect(linkCard).toContain('transition-[grid-template-rows]')
  })

  it('过阻尼曲线单调不回弹，欠阻尼曲线收尾有微弹', () => {
    const firm = /--ease-spring-firm: linear\(\s*([^)]+)\)/.exec(styles)?.[1]
    const soft = /--ease-spring-soft: linear\(\s*([^)]+)\)/.exec(styles)?.[1]
    const parse = (value?: string) =>
      (value ?? '').split(',').map((point) => Number(point.trim()))

    const firmPoints = parse(firm)
    const softPoints = parse(soft)

    expect(firmPoints.every((point) => point <= 1)).toBe(true)
    for (let index = 1; index < firmPoints.length; index += 1) {
      expect(firmPoints[index]!).toBeGreaterThanOrEqual(firmPoints[index - 1]!)
    }
    expect(Math.max(...softPoints)).toBeGreaterThan(1.1)
    expect(softPoints[softPoints.length - 1]).toBe(1)
  })

  it('拖拽遮罩弹入、点赞与对勾用弹簧曲线', () => {
    expect(conversationView).toContain('<Transition name="drag-veil">')
    expect(styles).toMatch(/\.drag-veil-enter-active[\s\S]*--ease-spring-firm/)
    expect(styles).toMatch(/\.like-tap\s*\{[\s\S]*--ease-spring-soft/)
    expect(styles).toMatch(/\.check-pop\s*\{[\s\S]*--ease-spring-soft/)
    expect(messageItem).toContain('check-pop absolute')
  })
})

describe('反馈自熄', () => {
  it('复制后的对勾 2.5s 自动淡出', () => {
    expect(conversationView).toContain("showToast('已复制', { icon: 'check', duration: 2500 })")
    expect(conversationView).toMatch(/toastTimer = window\.setTimeout\([\s\S]*?options\?\.duration \?\? 1800/)
  })
})
