import { describe, expect, it } from 'vitest'
import source from './ProviderAdBanner.vue?raw'

describe('ProviderAdBanner', () => {
  it('文案模板拆段渲染，滚动段共用下标同步轮换', () => {
    expect(source).toContain('parseAdTemplate(props.ad.text)')
    expect(source).toContain('hasRollSegment')
    expect(source).toContain('<template v-for="(segment, i) in segments" :key="i">')
    expect(source).toContain('{{ rollPartOf(segment, index) }}')
    expect(source).toContain('index.value += 1')
  })

  it('有链接渲染成外链横幅，没链接渲染成不可点的展示条', () => {
    expect(source).toContain(`:is="ad.link ? 'a' : 'div'"`)
    expect(source).toContain(`:target="ad.link ? '_blank' : undefined"`)
    expect(source).toContain(`:rel="ad.link ? 'noreferrer' : undefined"`)
    expect(source).toContain('查看详情')
  })

  it('图标 URL 为空时回退内置喇叭图标', () => {
    expect(source).toContain('<img v-if="ad.iconUrl"')
    expect(source).toContain('<Icon v-else name="megaphone"')
  })

  it('标题为空时不显示标题行', () => {
    expect(source).toContain('<span v-if="ad.title"')
  })

  it('滚动窗口用候选项隐形撑宽，切换时不左右跳动', () => {
    expect(source).toContain('class="roll-ghost"')
    expect(source).toContain('visibility: hidden')
    expect(source).toContain('display: inline-grid')
    expect(source).toContain('overflow: hidden')
    expect(source).not.toContain('min-width')
  })

  it('只有存在滚动段时才启动轮换，卸载时清理定时器', () => {
    expect(source).toContain('if (!rolling.value) return')
    expect(source).toContain('setInterval')
    expect(source).toContain('clearInterval')
    expect(source).toContain('onMounted')
    expect(source).toContain('onBeforeUnmount')
  })
})
