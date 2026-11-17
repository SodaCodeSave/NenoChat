import type { FastifyInstance } from 'fastify'
import {
  AiGlobalSettingsPatchSchema,
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
} from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as aiRepo from '../../db/repo/ai'
import * as aiService from '../../services/ai-service'
import * as groupAiService from '../../services/group-ai-service'
import { emitConversationUpdated } from '../../ws/emitter'

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
  app.post('/ai/providers/test', async (request) => {
    await requireUserId(request)
    const input = parse(TestProviderSchema, request.body)
    return aiService.testProvider(input)
  })

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
    await requireUserId(request)
    const input = parse(AppendAiSegmentSchema, request.body)
    const message = aiService.appendAiSegment(db, request.params.id, {
      generationId: input.generationId,
      index: input.index,
      content: input.content,
      clientNonce: input.clientNonce,
      model: input.model,
      totalSegments: input.totalSegments,
      proactive: input.proactive,
    })
    return { message }
  })

  /* ------------------------------ 生成 ------------------------------ */

  /** 服务端托管密钥时由此触发生成，分条结果通过普通消息事件下发 */
  app.post('/ai/generations', async (request) => {
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
  })

  /** 本机识图完成后把图片描述交回服务端：落缓存并写进消息 meta */
  app.post('/ai/image-descriptions', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ImageDescriptionSchema, request.body)
    aiService.saveImageDescriptionToMessage(db, userId, input)
    return { ok: true }
  })

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
