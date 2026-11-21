import { describe, expect, it } from 'vitest'
import source from './UsageStatsSettings.vue?raw'
import helpersSource from './usage-stats-helpers.ts?raw'

describe('UsageStatsSettings', () => {
  it('总览卡带时间窗切换与刷新，窗口默认 7 天', () => {
    expect(source).toContain('const activeWindow = ref<AiUsageWindow>(\'7d\')')
    expect(source).toContain(':options="USAGE_WINDOW_OPTIONS"')
    expect(source).toContain('aria-label="统计时间窗"')
    expect(source).toContain('function refresh')
    expect(source).toContain('void stats.load(activeWindow.value, true)')
  })

  it('窗口切换时按需加载并缓存', () => {
    expect(source).toContain('watch(activeWindow, (value) => {')
    expect(source).toContain('void stats.load(value)')
  })

  it('柱状图：输入/输出两段堆叠，零桶灰点占位，hover 有明细', () => {
    expect(source).toContain('class="w-full rounded-t-[2px] bg-accent-soft"')
    expect(source).toContain('class="w-full rounded-b-[2px] bg-accent"')
    expect(source).toContain('rounded-full bg-surface-3')
    expect(source).toContain('bucketTooltip(bucket, activeWindow)')
    expect(source).toContain('fillSeries(current.value)')
  })

  it('按 AI 卡：角色/模型两个维度切换', () => {
    expect(source).toContain("const aiDimension = ref<'persona' | 'model'>('persona')")
    expect(source).toContain("{ value: 'persona', label: '角色' }")
    expect(source).toContain("{ value: 'model', label: '模型' }")
    expect(source).toContain("row.model ?? '未知模型'")
  })

  it('按功能卡：kind 中文标签与图标', () => {
    expect(source).toContain('usageKindLabel(row.kind)')
    expect(source).toContain("row.key === 'vision' ? 'image'")
  })

  it('榜单行有调用次数、token 数与占比条', () => {
    expect(source).toContain('{{ row.calls }} 次')
    expect(source).toContain('formatTokens(row.promptTokens + row.completionTokens)')
    expect(source).toContain('function share(row')
    expect(source).toContain('function rowMax(rows')
  })

  it('空态与数据边界说明', () => {
    expect(source).toContain('窗口内还没有 AI 调用记录')
    expect(source).toContain('仅统计服务端发起的 AI 调用')
    expect(source).toContain('不产生 token 记录')
  })

  it('helpers 提供窗口选项与补零分桶', () => {
    expect(helpersSource).toContain("value: '24h'")
    expect(helpersSource).toContain('export function fillSeries')
    expect(helpersSource).toContain('export function usageKindLabel')
    expect(helpersSource).toContain('client_report')
  })
})
