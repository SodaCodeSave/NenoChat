import {
  API_PREFIX,
  type AiGlobalSettings,
  type AiMemoryFact,
  type AiMemorySummary,
  type AiPersona,
  type AiProvider,
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
    minIdleHours: number
    maxPerDay: number
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

  writeMemory: (
    conversationId: string,
    body: {
      summary?: { fromSeq: number; toSeq: number; text: string; model?: string | null }
      facts?: Array<{ subject: string; key: string; value: string; confidence?: number }>
    },
  ) => http.post<{ ok: boolean }>(p(`/ai/conversations/${conversationId}/memory`), body),
}
