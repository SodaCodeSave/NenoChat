import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AiGlobalSettingsPatchSchema,
  AiScheduleQuerySchema,
  AiScheduleSaveSchema,
  normalizeScheduleItems,
  AppendAiSegmentSchema,
  AppendGroupSegmentSchema,
  GroupAiSkipSchema,
  ImageDescriptionSchema,
  MemoryWriteSchema,
  OpenAiConversationSchema,
  PersonaPatchSchema,
  PersonaSchema,
  ProviderBalanceSchema,
  ProviderPatchSchema,
  ProviderSchema,
  StartGenerationSchema,
  TestProviderSchema,
  UsageReportSchema,
} from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import { rateLimit } from '../plugins/rate-limit'
import * as aiRepo from '../../db/repo/ai'
import * as conversationsRepo from '../../db/repo/conversations'
import * as aiService from '../../services/ai-service'
import * as groupAiService from '../../services/group-ai-service'
import * as scheduleService from '../../services/schedule-service'
import { emitConversationUpdated } from '../../ws/emitter'
import { err } from '../../util/errors'

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /* ----------------------------- 服务商 ----------------------------- */

  app.get('/ai/providers', async (request) => {
    const userId = await requireUserId(request)
    return { providers: aiService.listProviders(db, userId) }
  })

  app.post('/ai/providers', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ProviderSchema, request.body)
    return { provider: aiService.createProvider(db, userId, input) }
  })

  app.patch<{ Params: { id: string } }>('/ai/providers/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ProviderPatchSchema, request.body)
    return { provider: aiService.updateProvider(db, userId, request.params.id, input) }
  })

  app.delete<{ Params: { id: string } }>('/ai/providers/:id', async (request) => {
    const userId = await requireUserId(request)
    aiService.deleteProvider(db, userId, request.params.id)
    return { ok: true }
  })

  /** 测试连接：由服务端代发一次最小请求，避免浏览器跨域 */
  app.post(
    '/ai/providers/test',
    { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
    async (request) => {
      await requireUserId(request)
      const input = parse(TestProviderSchema, request.body)
      return aiService.testProvider(input)
    },
  )

  /** 余额探测：由服务端代查各家余额接口并缓存结果，本机密钥需随请求带上明文 */
  app.post<{ Params: { id: string } }>('/ai/providers/:id/balance', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ProviderBalanceSchema, request.body ?? {})
    return { provider: await aiService.refreshProviderBalance(db, userId, request.params.id, input.apiKey) }
  })

  /* ------------------------------ 角色 ------------------------------ */

  app.get('/ai/personas', async (request) => {
    const userId = await requireUserId(request)
    return { personas: aiService.listPersonas(db, userId) }
  })

  app.post('/ai/personas', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(PersonaSchema, request.body)
    return { persona: aiService.createPersona(db, userId, input) }
  })

  app.patch<{ Params: { id: string } }>('/ai/personas/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(PersonaPatchSchema, request.body)
    return { persona: aiService.updatePersona(db, userId, request.params.id, input) }
  })

  app.delete<{ Params: { id: string } }>('/ai/personas/:id', async (request) => {
    const userId = await requireUserId(request)
    aiService.deletePersona(db, userId, request.params.id)
    return { ok: true }
  })

  /* ------------------------------ 日程 ------------------------------ */

  const ownedPersona = (userId: string, personaId: string): aiRepo.PersonaRow => {
    const persona = aiRepo.findPersona(db, personaId)
    if (!persona || persona.owner_id !== userId) throw err.notFound('角色不存在')
    return persona
  }

  /** 读取某天的日程；date 缺省为今天，只读不触发生成 */
  app.get<{ Params: { id: string } }>('/ai/personas/:id/schedule', async (request) => {
    const userId = await requireUserId(request)
    const persona = ownedPersona(userId, request.params.id)
    const query = parse(AiScheduleQuerySchema, request.query)
    return {
      schedule: scheduleService.getSchedule(
        db,
        persona.id,
        query.date ?? scheduleService.todayKey(),
      ),
    }
  })

  /** 确保当天有日程：服务端密钥直接生成，本机密钥让客户端生成后回传 */
  app.post<{ Params: { id: string } }>('/ai/personas/:id/schedule/ensure', async (request) => {
    const userId = await requireUserId(request)
    const persona = ownedPersona(userId, request.params.id)
    const query = parse(AiScheduleQuerySchema, request.body ?? {})
    return scheduleService.ensureSchedule(
      db,
      persona,
      query.date ?? scheduleService.todayKey(),
    )
  })

  /** 强制重新生成当天的日程 */
  app.post<{ Params: { id: string } }>(
    '/ai/personas/:id/schedule/generate',
    { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
    async (request) => {
      const userId = await requireUserId(request)
      const persona = ownedPersona(userId, request.params.id)
      const query = parse(AiScheduleQuerySchema, request.body ?? {})
      return scheduleService.regenerateSchedule(
        db,
        persona,
        query.date ?? scheduleService.todayKey(),
      )
    },
  )

  /** 保存日程：手动编辑与客户端本地生成的结果都走这里 */
  app.post<{ Params: { id: string } }>('/ai/personas/:id/schedule', async (request) => {
    const userId = await requireUserId(request)
    const persona = ownedPersona(userId, request.params.id)
    const input = parse(AiScheduleSaveSchema, request.body)
    const items = normalizeScheduleItems(input.items)
    if (items.length === 0) throw err.validation('日程内容不合法')

    return {
      schedule: scheduleService.saveSchedule(db, {
        ownerId: userId,
        personaId: persona.id,
        dayKey: input.dayKey,
        items,
        source: input.source ?? 'manual',
      }),
    }
  })

  /* --------------------------- 全局自动互动 --------------------------- */

  app.get('/ai/settings', async (request) => {
    const userId = await requireUserId(request)
    return { settings: aiRepo.readGlobalSettings(db, userId) }
  })

  app.patch('/ai/settings', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(AiGlobalSettingsPatchSchema, request.body)
    return { settings: aiRepo.writeGlobalSettings(db, userId, input) }
  })

  /* ------------------------------ 会话 ------------------------------ */

  app.post('/ai/conversations', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(OpenAiConversationSchema, request.body)
    const conversation = aiService.openConversation(db, userId, input)
    emitConversationUpdated(db, conversation)
    return { conversation }
  })

  /** 追加一条 AI 分段消息（客户端本地生成模式使用） */
  app.post<{ Params: { id: string } }>('/ai/conversations/:id/messages', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(AppendAiSegmentSchema, request.body)
    // 归属校验：服务层只校验会话类型，这里必须确认会话属于当前用户，防止拿他人会话 ULID 注入消息
    const conv = conversationsRepo.findById(db, request.params.id)
    if (!conv || conv.type !== 'ai') throw err.notFound('AI 会话不存在')
    if (conv.ai_owner_user_id !== userId) throw err.forbidden('无权访问该 AI 会话')
    const message = aiService.appendAiSegment(db, request.params.id, {
      generationId: input.generationId,
      index: input.index,
      content: input.content,
      clientNonce: input.clientNonce,
      model: input.model,
      totalSegments: input.totalSegments,
      proactive: input.proactive,
      connector: input.connector,
    })
    return { message }
  })

  /* ------------------------------ 生成 ------------------------------ */

  /** 服务端托管密钥时由此触发生成，分条结果通过普通消息事件下发 */
  app.post(
    '/ai/generations',
    { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
    async (request) => {
      const userId = await requireUserId(request)
      const input = parse(StartGenerationSchema, request.body)
      const result = await aiService.generateOnServer(db, {
        conversationId: input.conversationId,
        userId,
        content: input.content,
        clientNonce: input.clientNonce,
        providerId: input.providerId,
      })
      return { generation: result }
    },
  )

  /** 本机识图完成后把图片描述交回服务端：落缓存并写进消息 meta */
  app.post('/ai/image-descriptions', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ImageDescriptionSchema, request.body)
    aiService.saveImageDescriptionToMessage(db, userId, input)
    return { ok: true }
  })

  /** 服务端识图分析一张表情包的情绪标签（密钥托管模式）；本机密钥由客户端自行分析 */
  app.post(
    '/ai/stickers/analyze',
    { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) },
    async (request) => {
      const userId = await requireUserId(request)
      const input = parse(z.object({ stickerId: z.string().min(1) }), request.body)
      const tags = await aiService.analyzeStickerOnServer(db, userId, input.stickerId)
      return { tags }
    },
  )

  /* ------------------------------ 群聊 AI ------------------------------ */

  /** 本机密钥：客户端生成好一条群消息后交回服务端落库 */
  app.post('/ai/group/messages', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(AppendGroupSegmentSchema, request.body)
    const message = groupAiService.appendClientGroupSegment(db, userId, input)
    return { message }
  })

  /** 客户端判断此刻不想接话，服务端把这次配额标记为跳过 */
  app.post('/ai/group/skip', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(GroupAiSkipSchema, request.body)
    groupAiService.skipClientGroupDue(db, userId, input.logId, input.reason)
    return { ok: true }
  })

  /* ------------------------------ 调试模式 ------------------------------ */

  /** 本机密钥代跑后回传真实 usage */
  app.post('/ai/usage', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(UsageReportSchema, request.body)
    aiService.reportClientUsage(db, userId, input)
    return { ok: true }
  })

  /** 会话用量汇总：缓存命中率、token 消耗、上下文水位 */
  app.get('/ai/debug/summary', async (request) => {
    const userId = await requireUserId(request)
    const query = parse(z.object({ conversationId: z.string().min(1) }), request.query)
    return { summary: aiService.debugSummary(db, userId, query.conversationId) }
  })

  /** 会话最近的群聊决策记录（含规则层未放行与 SKIP） */
  app.get('/ai/debug/decisions', async (request) => {
    const userId = await requireUserId(request)
    const query = parse(
      z.object({
        conversationId: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      request.query,
    )
    return {
      decisions: aiService.listGroupDecisions(db, userId, query.conversationId, query.limit ?? 200),
    }
  })

  /** 按 refId 批量查最近一次 usage（消息内联调试条） */
  app.post('/ai/debug/usage-batch', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(z.object({ refIds: z.array(z.string().min(1)).max(200) }), request.body)
    return { usage: aiService.usageByRefs(db, userId, input.refIds) }
  })

  /* ------------------------------ 记忆 ------------------------------ */
  app.get<{ Params: { id: string } }>('/ai/conversations/:id/memory', async (request) => {
    const userId = await requireUserId(request)
    return aiService.listMemory(db, userId, request.params.id)
  })

  app.post<{ Params: { id: string } }>('/ai/conversations/:id/memory', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(MemoryWriteSchema, request.body)
    aiService.writeMemory(db, userId, request.params.id, input)
    return { ok: true }
  })

  app.delete<{ Params: { id: string; factId: string } }>(
    '/ai/conversations/:id/memory/facts/:factId',
    async (request) => {
      const userId = await requireUserId(request)
      aiService.deleteFact(db, userId, request.params.id, request.params.factId)
      return { ok: true }
    },
  )
}
