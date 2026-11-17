import {
  API_PREFIX,
  type AiDebugSummary,
  type AiGlobalSettings,
  type AiGroupDecision,
  type AiMemoryFact,
  type AiMemorySummary,
  type AiPersona,
  type AiProvider,
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
  keyLocation: 'local' | 'server'
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
  /** 探测服务商余额；本机密钥模式需把明文 key 带上 */
  providerBalance: (id: string, apiKey?: string) =>
    http.post<{ provider: AiProvider }>(
      p(`/ai/providers/${id}/balance`),
      apiKey ? { apiKey } : {},
    ),

  personas: () => http.get<{ personas: AiPersona[] }>(p('/ai/personas')),
  createPersona: (body: PersonaInput) => http.post<{ persona: AiPersona }>(p('/ai/personas'), body),
  updatePersona: (id: string, body: Partial<PersonaInput>) =>
    http.patch<{ persona: AiPersona }>(p(`/ai/personas/${id}`), body),
  deletePersona: (id: string) => http.delete<{ ok: boolean }>(p(`/ai/personas/${id}`)),

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
  appendMessage: (
    conversationId: string,
    body: {
      generationId: string
      index: number
      content: string
      clientNonce: string
      model?: string
      totalSegments?: number
      proactive?: boolean
    },
  ) => http.post<{ message: unknown }>(p(`/ai/conversations/${conversationId}/messages`), body),

  startGeneration: (body: {
    conversationId: string
    content: string
    clientNonce: string
    providerId: string
  }) => http.post<{ generation: { generationId: string; segments: number } }>(p('/ai/generations'), body),
  cancelGeneration: (id: string) => http.post<{ ok: boolean }>(p(`/ai/generations/${id}/cancel`)),

  /** 本机识图后把图片描述交回服务端缓存并写进消息 meta */
  saveImageDescription: (body: {
    messageId: string
    attachmentId: string
    description: string
    model?: string | null
  }) => http.post<{ ok: boolean }>(p('/ai/image-descriptions'), body),

  /** 群聊：本机密钥生成后把分段交回服务端落库 */
  appendGroupMessage: (body: {
    logId: string
    personaId: string
    conversationId: string
    channelId?: string | null
    generationId: string
    index: number
    content: string
    clientNonce: string
    model?: string
    totalSegments?: number
  }) => http.post<{ message: unknown }>(p('/ai/group/messages'), body),
  skipGroup: (logId: string, reason?: string) =>
    http.post<{ ok: boolean }>(p('/ai/group/skip'), { logId, reason }),

  /* ------------------------------ 调试模式 ------------------------------ */

  /** 本机代跑的真实 usage 回传服务端落库 */
  reportUsage: (body: {
    conversationId?: string
    personaId?: string
    providerId?: string
    kind: string
    refId?: string
    model?: string
    promptTokens: number
    completionTokens: number
    cachedTokens?: number
  }) => http.post<{ ok: boolean }>(p('/ai/usage'), body),

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
