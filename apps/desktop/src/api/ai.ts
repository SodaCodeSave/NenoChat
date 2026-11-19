import {
  API_PREFIX,
  type AiDebugSummary,
  type AiGlobalSettings,
  type AiGroupDecision,
  type AiMemoryFact,
  type AiMemorySummary,
  type AiPersona,
  type AiProvider,
  type AiSchedule,
  type AiScheduleItem,
  type AiUsageEntry,
  type Conversation,
} from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export interface ProviderInput {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
  /** 识图模型：把聊天图片转成文字描述，留空则发图时直接传给主模型 */
  visionModel?: string | null
  /** 模型上下文窗口（token 数），调试模式算水位用 */
  contextWindow?: number | null
}

export interface PersonaInput {
  name: string
  systemPrompt: string
  avatarUrl?: string | null
  interests?: string[]
  card?: string | null
  cardUrl?: string | null
  cardFilename?: string | null
  inContacts?: boolean
  providerId?: string | null
  modelOverride?: string | null
  temperature?: number | null
  replyStyle?: 'chatty' | 'concise' | 'narrative'
  greeting?: string | null
  proactiveMode?: 'global' | 'custom'
  proactive?: {
    enabled: boolean
    triggerMode?: 'idle' | 'chance'
    minIdleHours: number
    maxPerDay: number
    chanceUnit?: 'minute' | 'hour'
    chanceProbability?: number
    chanceCooldownMinutes?: number
    windowStart?: string
    windowEnd?: string
  }
}

export const aiApi = {
  providers: () => http.get<{ providers: AiProvider[] }>(p('/ai/providers')),
  createProvider: (body: ProviderInput) => http.post<{ provider: AiProvider }>(p('/ai/providers'), body),
  updateProvider: (id: string, body: Partial<ProviderInput>) =>
    http.patch<{ provider: AiProvider }>(p(`/ai/providers/${id}`), body),
  deleteProvider: (id: string) => http.delete<{ ok: boolean }>(p(`/ai/providers/${id}`)),
  testProvider: (body: { baseUrl: string; apiKey: string; model: string }) =>
    http.post<{ ok: boolean; sample: string }>(p('/ai/providers/test'), body),
  /** 保存前用表单参数预览模型列表 */
  previewModels: (body: { baseUrl: string; apiKey: string }) =>
    http.post<{ models: string[] }>(p('/ai/providers/models'), body),
  /** 读取已保存服务商的模型列表 */
  providerModels: (id: string) =>
    http.get<{ models: string[] }>(p(`/ai/providers/${id}/models`)),
  /** 探测服务商余额 */
  providerBalance: (id: string) =>
    http.post<{ provider: AiProvider }>(p(`/ai/providers/${id}/balance`), {}),

  personas: () => http.get<{ personas: AiPersona[] }>(p('/ai/personas')),
  createPersona: (body: PersonaInput) => http.post<{ persona: AiPersona }>(p('/ai/personas'), body),
  updatePersona: (id: string, body: Partial<PersonaInput>) =>
    http.patch<{ persona: AiPersona }>(p(`/ai/personas/${id}`), body),
  deletePersona: (id: string) => http.delete<{ ok: boolean }>(p(`/ai/personas/${id}`)),

  /** 读取某天日程；不传 date 取今天 */
  schedule: (personaId: string, date?: string) =>
    http.get<{ schedule: AiSchedule | null }>(p(`/ai/personas/${personaId}/schedule`), {
      query: date ? { date } : undefined,
    }),
  /** 确保当天有日程 */
  ensureSchedule: (personaId: string, date?: string) =>
    http.post<{ schedule: AiSchedule | null }>(
      p(`/ai/personas/${personaId}/schedule/ensure`),
      date ? { date } : {},
    ),
  /** 强制重新生成当天日程 */
  regenerateSchedule: (personaId: string, date?: string) =>
    http.post<{ schedule: AiSchedule | null }>(
      p(`/ai/personas/${personaId}/schedule/generate`),
      date ? { date } : {},
    ),
  saveSchedule: (
    personaId: string,
    body: { dayKey: string; items: AiScheduleItem[]; source?: 'ai' | 'manual' },
  ) => http.post<{ schedule: AiSchedule }>(p(`/ai/personas/${personaId}/schedule`), body),

  settings: () => http.get<{ settings: AiGlobalSettings }>(p('/ai/settings')),
  updateSettings: (body: Partial<Omit<AiGlobalSettings, 'updatedAt'>>) =>
    http.patch<{ settings: AiGlobalSettings }>(p('/ai/settings'), body),

  openConversation: (body: { personaId: string; providerId?: string; title?: string }) =>
    http.post<{ conversation: Conversation }>(p('/ai/conversations'), body),

  memory: (conversationId: string) =>
    http.get<{ summaries: AiMemorySummary[]; facts: AiMemoryFact[] }>(
      p(`/ai/conversations/${conversationId}/memory`),
    ),
  deleteFact: (conversationId: string, factId: string) =>
    http.delete<{ ok: boolean }>(p(`/ai/conversations/${conversationId}/memory/facts/${factId}`)),
  startGeneration: (body: {
    conversationId: string
    content: string
    clientNonce: string
    providerId: string
  }) => http.post<{ generation: { generationId: string; segments: number } }>(p('/ai/generations'), body),
  cancelGeneration: (id: string) => http.post<{ ok: boolean }>(p(`/ai/generations/${id}/cancel`)),

  /* ------------------------------ 调试模式 ------------------------------ */

  /** 会话用量汇总：缓存命中率、token 消耗、上下文水位 */
  debugSummary: (conversationId: string) =>
    http.get<{ summary: AiDebugSummary }>(
      p(`/ai/debug/summary?conversationId=${encodeURIComponent(conversationId)}`),
    ),

  /** 会话最近的群聊决策记录 */
  debugDecisions: (conversationId: string, limit = 200) =>
    http.get<{ decisions: AiGroupDecision[] }>(
      p(
        `/ai/debug/decisions?conversationId=${encodeURIComponent(conversationId)}&limit=${limit}`,
      ),
    ),

  /** 按 refId 批量查最近一次 usage（消息内联调试条） */
  usageByRefs: (refIds: string[]) =>
    http.post<{ usage: Record<string, AiUsageEntry> }>(p('/ai/debug/usage-batch'), { refIds }),

  writeMemory: (
    conversationId: string,
    body: {
      summary?: { fromSeq: number; toSeq: number; text: string; model?: string | null }
      facts?: Array<{ subject: string; key: string; value: string; confidence?: number }>
    },
  ) => http.post<{ ok: boolean }>(p(`/ai/conversations/${conversationId}/memory`), body),
}
