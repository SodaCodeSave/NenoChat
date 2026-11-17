import { z } from 'zod'
import { KeyLocation, MemoryFactSubject, ReplyStyle } from '../enums'

export const ProviderSchema = z.object({
  name: z.string().trim().min(1).max(64),
  baseUrl: z.string().trim().min(8).max(512),
  model: z.string().trim().min(1).max(128),
  apiKey: z.string().max(512).optional(),
  keyLocation: z.enum([KeyLocation.Local, KeyLocation.Server]).default(KeyLocation.Local),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(32000).optional(),
  isDefault: z.boolean().optional(),
})

export const ProviderPatchSchema = ProviderSchema.partial()

export const TestProviderSchema = z.object({
  baseUrl: z.string().trim().min(8).max(512),
  apiKey: z.string().max(512).default(''),
  model: z.string().trim().min(1).max(128),
})

export const ProviderBalanceSchema = z.object({
  apiKey: z.string().max(512).optional(),
})

export const PersonaSchema = z.object({
  name: z.string().trim().min(1).max(64),
  systemPrompt: z.string().trim().min(1).max(8000),
  avatarUrl: z.string().max(512).nullable().optional(),
  interests: z.array(z.string().trim().min(1).max(24)).max(20).optional(),
  card: z.string().max(8000).nullable().optional(),
  cardUrl: z.string().max(512).nullable().optional(),
  cardFilename: z.string().max(128).nullable().optional(),
  inContacts: z.boolean().optional(),
  providerId: z.string().min(1).nullable().optional(),
  modelOverride: z.string().max(128).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  replyStyle: z.enum([ReplyStyle.Chatty, ReplyStyle.Concise, ReplyStyle.Narrative]).optional(),
  greeting: z.string().max(2000).nullable().optional(),
  /** 主动消息跟随全局还是单独配置；不传时按是否显式启用推断 */
  proactiveMode: z.enum(['global', 'custom']).optional(),
  proactive: z
    .object({
      enabled: z.boolean(),
      minIdleHours: z.number().min(0).max(720),
      maxPerDay: z.number().int().min(0).max(20),
      windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    })
    .optional(),
})

export const PersonaPatchSchema = PersonaSchema.partial()

const HHMM = /^\d{2}:\d{2}$/

/** 全局 AI 自动互动设置：主动私聊 + 动态互动共用一条 */
export const AiGlobalSettingsSchema = z.object({
  proactiveEnabled: z.boolean(),
  minIdleHours: z.number().min(0).max(720),
  maxPerDay: z.number().int().min(0).max(20),
  windowStart: z.string().regex(HHMM).nullable().optional(),
  windowEnd: z.string().regex(HHMM).nullable().optional(),
  momentsEnabled: z.boolean(),
  momentsPostsPerDay: z.number().int().min(0).max(10),
  momentsCommentsPerDay: z.number().int().min(0).max(20),
  momentsLikesPerDay: z.number().int().min(0).max(20),
  groupEnabled: z.boolean(),
  groupRepliesPerDay: z.number().int().min(0).max(50),
  groupAutonomyPerDay: z.number().int().min(0).max(10),
  segmentEnabled: z.boolean(),
  segmentPattern: z.string().trim().min(1).max(200),
})

export const AiGlobalSettingsPatchSchema = AiGlobalSettingsSchema.partial()
export type AiGlobalSettingsInput = z.infer<typeof AiGlobalSettingsSchema>

export const OpenAiConversationSchema = z.object({
  personaId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  title: z.string().trim().max(64).optional(),
})

export const AppendAiSegmentSchema = z.object({
  generationId: z.string().min(1),
  index: z.number().int().min(0),
  content: z.string().min(1).max(8000),
  clientNonce: z.string().min(1).max(64).optional(),
  model: z.string().max(128).optional(),
  totalSegments: z.number().int().min(1).max(50).optional(),
  proactive: z.boolean().optional(),
})

/** 本机密钥代跑：客户端把群聊回复交回服务端落库 */
export const AppendGroupSegmentSchema = z.object({
  logId: z.string().min(1),
  personaId: z.string().min(1),
  conversationId: z.string().min(1),
  channelId: z.string().min(1).nullable().optional(),
  generationId: z.string().min(1),
  index: z.number().int().min(0),
  content: z.string().min(1).max(4000),
  clientNonce: z.string().min(1).max(64),
  model: z.string().max(128).optional(),
  totalSegments: z.number().int().min(1).max(20).optional(),
})

export const GroupAiSkipSchema = z.object({
  logId: z.string().min(1),
  reason: z.string().max(120).optional(),
})

export const StartGenerationSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1).max(8000),
  clientNonce: z.string().min(1).max(64),
  providerId: z.string().min(1).optional(),
})

export const MemoryWriteSchema = z.object({
  summary: z
    .object({
      fromSeq: z.number().int().min(0),
      toSeq: z.number().int().min(0),
      text: z.string().min(1).max(4000),
      model: z.string().max(128).nullable().optional(),
    })
    .optional(),
  facts: z
    .array(
      z.object({
        subject: z.enum([
          MemoryFactSubject.User,
          MemoryFactSubject.Persona,
          MemoryFactSubject.Relation,
          MemoryFactSubject.World,
        ]),
        key: z.string().min(1).max(64),
        value: z.string().min(1).max(1000),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(50)
    .optional(),
})
