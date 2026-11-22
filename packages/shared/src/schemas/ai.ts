import { z } from 'zod'
import { MemoryFactSubject, ReplyStyle } from '../enums'

/** 供应商下的单个 AI：模型名 + 开关 + 计费价格（元 / 百万 token） */
export const ProviderModelSchema = z.object({
  model: z.string().trim().min(1).max(128),
  enabled: z.boolean().default(true),
  priceInput: z.number().min(0).max(100000).nullable().default(null),
  priceOutput: z.number().min(0).max(100000).nullable().default(null),
  priceCached: z.number().min(0).max(100000).nullable().default(null),
})

export const ProviderSchema = z.object({
  name: z.string().trim().min(1).max(64),
  baseUrl: z.string().trim().min(8).max(512),
  model: z.string().trim().min(1).max(128),
  /** 留空表示不改动密钥；空串表示清空密钥 */
  apiKey: z.string().max(512).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(32000).optional(),
  isDefault: z.boolean().optional(),
  /** 识图模型：留空表示未配置，发图时直接把图传给主模型 */
  visionModel: z.string().trim().max(128).nullable().optional(),
  /** 模型上下文窗口（token 数），调试模式算水位用 */
  contextWindow: z.number().int().min(256).max(10_000_000).nullable().optional(),
  /** 供应商下的 AI 列表；不传表示不改动 */
  models: z.array(ProviderModelSchema).max(200).optional(),
})

/** 服务商局部更新：字段全部可选 */
export const ProviderPatchSchema = ProviderSchema.partial()

/** 服务商模型列表：入参允许带临时密钥，用于保存前预览 */
export const ProviderModelsSchema = z.object({
  baseUrl: z.string().trim().min(8).max(512),
  apiKey: z.string().max(512).default(''),
})

export const TestProviderSchema = z.object({
  baseUrl: z.string().trim().min(8).max(512),
  apiKey: z.string().max(512).default(''),
  model: z.string().trim().min(1).max(128),
})

/** 用托管密钥测试已保存服务商：地址与模型可从表单覆盖，密钥永远走服务端托管 */
export const ProviderStoredTestSchema = z.object({
  baseUrl: z.string().trim().min(8).max(512).optional(),
  model: z.string().trim().min(1).max(128).optional(),
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
  /** 该角色可用的表情包分组；null = 跟随全局授权，数组 = 白名单 */
  stickerPackIds: z.array(z.string().min(1).max(64)).max(100).nullable().optional(),
  /** 主动消息跟随全局还是单独配置；不传时按是否显式启用推断 */
  proactiveMode: z.enum(['global', 'custom']).optional(),
  /** 与用户的关系；null 表示清掉 */
  relationship: z
    .object({
      stage: z.enum(['stranger', 'acquaintance', 'friend', 'close_friend', 'partner']),
      description: z.string().trim().max(500),
    })
    .nullable()
    .optional(),
  proactive: z
    .object({
      enabled: z.boolean(),
      triggerMode: z.enum(['idle', 'chance']).optional(),
      minIdleHours: z.number().min(0).max(720),
      maxPerDay: z.number().int().min(-1).max(998),
      chanceUnit: z.enum(['minute', 'hour']).optional(),
      chanceProbability: z.number().min(0).max(1).optional(),
      chanceCooldownMinutes: z.number().int().min(0).max(1440).optional(),
      windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    })
    .optional(),
})

export const PersonaPatchSchema = PersonaSchema.partial()

const HHMM = /^\d{2}:\d{2}$/
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

export const AiScheduleItemSchema = z.object({
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
  activity: z.string().trim().min(1).max(60),
})

/** 保存某一天的日程：AI 生成回写与手动编辑共用 */
export const AiScheduleSaveSchema = z.object({
  dayKey: z.string().regex(DAY_KEY),
  items: z.array(AiScheduleItemSchema).min(1).max(20),
  source: z.enum(['ai', 'manual']).optional(),
})

export const AiScheduleQuerySchema = z.object({
  date: z.string().regex(DAY_KEY).optional(),
})

/** 全局 AI 自动互动设置：主动私聊 + 动态互动共用一条 */
export const AiGlobalSettingsSchema = z.object({
  proactiveEnabled: z.boolean(),
  minIdleHours: z.number().min(0).max(720),
  /** -1 表示无上限 */
  maxPerDay: z.number().int().min(-1).max(998),
  triggerMode: z.enum(['idle', 'chance']).optional(),
  chanceUnit: z.enum(['minute', 'hour']).optional(),
  chanceProbability: z.number().min(0).max(1).optional(),
  chanceCooldownMinutes: z.number().int().min(0).max(1440).optional(),
  windowStart: z.string().regex(HHMM).nullable().optional(),
  windowEnd: z.string().regex(HHMM).nullable().optional(),
  momentsEnabled: z.boolean(),
  /** -1 表示无上限 */
  momentsPostsPerDay: z.number().int().min(-1).max(10),
  /** -1 表示无上限 */
  momentsCommentsPerDay: z.number().int().min(-1).max(20),
  /** -1 表示无上限 */
  momentsLikesPerDay: z.number().int().min(-1).max(20),
  groupEnabled: z.boolean(),
  groupRepliesPerDay: z.number().int().min(-1).max(50),
  groupRepliesPerMessage: z.number().int().min(1).max(5),
  groupReplyProbability: z.number().int().min(0).max(100).nullable().optional(),
  groupReplyCooldownMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  /** -1 表示无上限 */
  groupAutonomyPerDay: z.number().int().min(-1).max(10),
  segmentEnabled: z.boolean(),
  segmentPattern: z.string().trim().min(1).max(200),
  streamEnabled: z.boolean(),
  relationshipEnabled: z.boolean(),
  debugMode: z.boolean(),
})

export const AiGlobalSettingsPatchSchema = AiGlobalSettingsSchema.partial()
export type AiGlobalSettingsInput = z.infer<typeof AiGlobalSettingsSchema>

export const OpenAiConversationSchema = z.object({
  personaId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  title: z.string().trim().max(64).optional(),
})

export const ConnectorActionMetaSchema = z.object({
  kind: z.enum(['web_search', 'fetch', 'bilibili']),
  detail: z.string().max(200).optional(),
})

export const AppendAiSegmentSchema = z.object({
  generationId: z.string().min(1),
  index: z.number().int().min(0),
  content: z.string().min(1).max(8000),
  clientNonce: z.string().min(1).max(64).optional(),
  model: z.string().max(128).optional(),
  totalSegments: z.number().int().min(1).max(50).optional(),
  proactive: z.boolean().optional(),
  connector: z.array(ConnectorActionMetaSchema).max(10).optional(),
})

export const StartGenerationSchema = z.object({
  conversationId: z.string().min(1),
  /** 允许为空：只发图片不带文字时，正文由图片描述补位 */
  content: z.string().max(8000),
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
