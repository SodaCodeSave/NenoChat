import { z } from 'zod'

export const ConnectorTypeSchema = z.enum(['deepseek_search', 'bilibili', 'heweather', 'mimo_tts'])

/** 非敏感配置：具体字段按连接器类型在服务端做二次校验 */
export const ConnectorConfigSchema = z.object({
  baseUrl: z.string().trim().max(512).nullable().optional(),
  count: z.number().int().min(1).max(20).nullable().optional(),
  maxComments: z.number().int().min(0).max(20).nullable().optional(),
  location: z.string().trim().max(128).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  weatherAlways: z.boolean().optional(),
  weatherOnUserMessage: z.boolean().optional(),
  weatherOnMention: z.boolean().optional(),
  weatherTool: z.boolean().optional(),
  /** MiMo TTS 预置音色 ID */
  ttsVoice: z.string().trim().max(64).nullable().optional(),
  /** MiMo TTS 风格指令（自然语言） */
  ttsInstruction: z.string().trim().max(1000).nullable().optional(),
  /** AI 回复按概率转语音，0-1 */
  voiceProbability: z.number().min(0).max(1).nullable().optional(),
  /** 允许 AI 用 [[voice]] 标记主动发语音 */
  voiceTool: z.boolean().optional(),
})

/** 敏感配置：创建/更新时随请求传入，服务端加密后只回掩码 */
export const ConnectorSecretSchema = z.object({
  apiKey: z.string().max(1024).optional(),
  cookie: z.string().max(8000).optional(),
})

export const ConnectorCreateSchema = z.object({
  type: ConnectorTypeSchema,
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().optional(),
  config: ConnectorConfigSchema.optional(),
  secret: ConnectorSecretSchema.optional(),
})

export const ConnectorPatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  config: ConnectorConfigSchema.optional(),
  secret: ConnectorSecretSchema.optional(),
})

export const ConnectorToggleSchema = z.object({
  enabled: z.boolean(),
})

export const ConnectorSearchSchema = z.object({
  query: z.string().trim().min(1).max(128),
})

export const ConnectorFetchSchema = z.object({
  url: z.string().trim().min(8).max(8192),
})

export const BilibiliPrepareSchema = z.object({
  url: z.string().trim().min(8).max(1024),
})

export const BilibiliSummaryQuerySchema = z.object({
  videoId: z.string().trim().min(1).max(32),
})

export const BilibiliSummarySaveSchema = z.object({
  videoId: z.string().trim().min(1).max(32),
  summary: z.string().trim().min(1).max(8000),
  model: z.string().max(128).optional(),
})

export const LinkPreviewQuerySchema = z.object({
  url: z.string().trim().min(8).max(1024),
})

export type ConnectorCreateInput = z.infer<typeof ConnectorCreateSchema>
export type ConnectorPatchInput = z.infer<typeof ConnectorPatchSchema>
