import type { AiGroupDecision, AiUsageEntry } from '@nenochat/shared'

/** 决策 reason 的中文说明 */
const REASON_LABELS: Record<string, string> = {
  disabled: '群聊互动已关闭',
  quota_zero: '配额为 0',
  quota_exhausted: '今日配额用完',
  cooldown: '冷却中',
  mentioned: '被点名',
  in_mood: '心情不错',
  not_in_mood: '没心情',
  low_energy: '体力不足',
  quiet_window: '免打扰时段',
  group_not_idle: '群还不够安静',
  no_provider: '未配置服务商',
  local_key_offline: '本机不在线',
  persona_not_loaded: '角色未加载',
  provider_not_local: '服务商不是本机密钥',
  client_cannot_run_local_key: '网页端无法代跑',
  missing_local_key: '本机缺少密钥',
  client_skip: '本机放弃',
  skip: '选择沉默',
  empty_reply: '没想出要说的话',
  stale_pending: '超时未完成',
  sent: '已发言',
}

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return '未知原因'
  return REASON_LABELS[reason] ?? reason
}

/** 决策记录的一句话描述，消息流里的调试条直接用 */
export function describeDecision(decision: AiGroupDecision): string {
  if (decision.stage === 'rules') {
    if (decision.fired) return `决定接话（${reasonLabel(decision.reason)}）`
    return `没接话：${reasonLabel(decision.reason)}`
  }
  // 模型层产出
  if (decision.reason === 'skip') return '想了想，决定沉默'
  if (decision.reason === 'sent') return '发言'
  return reasonLabel(decision.reason)
}

/** token 数的紧凑格式：1234 → 1.2k */
export function formatTokens(value: number | null | undefined): string {
  if (value == null) return '-'
  if (value >= 10000) return `${(value / 1000).toFixed(0)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** 百分比：0.654 → 65% */
export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '-'
  return `${Math.round(value * 100)}%`
}

/** usage 记录的一句话摘要，消息内联调试行与底栏共用 */
export function describeUsage(usage: AiUsageEntry | undefined): string | null {
  if (!usage) return null
  const hit =
    usage.promptTokens > 0 ? formatPercent(usage.cachedTokens / usage.promptTokens) : '-'
  return `输入 ${formatTokens(usage.promptTokens)} · 输出 ${formatTokens(usage.completionTokens)} · 缓存 ${hit}`
}
