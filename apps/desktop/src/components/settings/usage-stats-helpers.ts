import type { AiUsageBucket, AiUsageKind, AiUsageStats, AiUsageWindow } from '@nenochat/shared'

/** 功能场景的中文标签，与 shared 的 AiUsageKind 一一对应 */
export const USAGE_KIND_LABELS: Record<AiUsageKind, string> = {
  chat: '私聊对话',
  group_reply: '群聊回复',
  group_autonomy: '群聊自主',
  proactive: '主动消息',
  moment: '动态广场',
  schedule: '角色日程',
  summary: '记忆摘要',
  vision: '图片理解',
  title: '标题生成',
  client_report: '客户端上报',
}

export function usageKindLabel(kind: AiUsageKind): string {
  return USAGE_KIND_LABELS[kind] ?? kind
}

/** 时间窗切换器选项，value 与 AiUsageWindow 一致 */
export const USAGE_WINDOW_OPTIONS: Array<{ value: AiUsageWindow; label: string }> = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

export function bucketMsOf(window: AiUsageWindow): number {
  return window === '24h' ? 3_600_000 : 86_400_000
}

/** 一个桶的输入+输出总量，柱高与榜单排序都用它 */
export function bucketTotal(bucket: Pick<AiUsageBucket, 'promptTokens' | 'completionTokens'>): number {
  return bucket.promptTokens + bucket.completionTokens
}

/**
 * 把服务端返回的非空桶补零成连续序列（from 起到最后一个非空桶或当前时刻所在桶），
 * 柱状图需要等宽的柱子，空桶也要占位。
 */
export function fillSeries(stats: AiUsageStats): AiUsageBucket[] {
  const byStart = new Map(stats.series.map((bucket) => [bucket.bucketStart, bucket]))
  const lastServerStart = stats.series.length
    ? stats.series[stats.series.length - 1].bucketStart
    : stats.from
  const lastStart = Math.max(
    Math.floor(stats.to / stats.bucketMs) * stats.bucketMs,
    lastServerStart,
  )
  const filled: AiUsageBucket[] = []
  for (let start = stats.from; start <= lastStart; start += stats.bucketMs) {
    filled.push(
      byStart.get(start) ?? {
        bucketStart: start,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
      },
    )
  }
  return filled
}

/** 桶起点格式化成横轴标签：24h 显示 HH:00，7d/30d 显示 M/D（本地时区） */
export function bucketLabel(bucketStart: number, window: AiUsageWindow): string {
  const date = new Date(bucketStart)
  if (window === '24h') {
    return `${String(date.getHours()).padStart(2, '0')}:00`
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 柱状图横轴每隔几根柱显示一个标签，避免拥挤 */
export function labelStep(bucketCount: number): number {
  if (bucketCount <= 9) return 3
  if (bucketCount <= 13) return 4
  return Math.ceil(bucketCount / 8)
}

/** 柱的 hover 提示：一行时间 + 一行明细 */
export function bucketTooltip(bucket: AiUsageBucket, window: AiUsageWindow): string {
  const date = new Date(bucket.bucketStart)
  const time =
    window === '24h'
      ? `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`
      : `${date.getMonth() + 1}/${date.getDate()}`
  return `${time}\n输入 ${bucket.promptTokens} · 输出 ${bucket.completionTokens} · 调用 ${bucket.calls} 次`
}
