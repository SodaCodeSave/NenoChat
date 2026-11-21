import type { FastifyInstance } from 'fastify'
import {
  EditMessageSchema,
  ForwardMessagesSchema,
  MarkReadSchema,
  MessagePageQuerySchema,
  PinMessageSchema,
  SendMessageSchema,
} from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as messageService from '../../services/message-service'
import { scheduleGroupResponse } from '../../services/group-ai-service'
import * as messagesRepo from '../../db/repo/messages'
import * as readCursorsRepo from '../../db/repo/read-cursors'
import { assertMember } from '../../services/permission-service'

function deviceIdOf(request: { headers: Record<string, unknown> }): string | undefined {
  const value = request.headers['x-device-id']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get<{ Params: { id: string } }>('/conversations/:id/messages', async (request) => {
    const userId = await requireUserId(request)
    const query = parse(MessagePageQuerySchema, request.query)

    return await messageService.listPage(db, {
      conversationId: request.params.id,
      userId,
      before: query.before ?? null,
      after: query.after ?? null,
      limit: query.limit,
    })
  })

  app.get<{ Params: { id: string; messageId: string } }>(
    '/conversations/:id/messages/around/:messageId',
    async (request) => {
      const userId = await requireUserId(request)
      return await messageService.around(db, {
        conversationId: request.params.id,
        userId,
        messageId: request.params.messageId,
      })
    },
  )

  app.post('/messages', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(SendMessageSchema, request.body)

    const result = await messageService.send(db, {
      conversationId: input.conversationId,
      senderId: userId,
      clientNonce: input.clientNonce,
      type: input.type,
      content: input.content,
      meta: input.meta ?? null,
      replyToId: input.replyToId ?? null,
      deviceId: deviceIdOf(request),
    })

    // 群聊里的 AI 成员按自己的规则与心情决定是否接话，不阻塞这次发送
    if (!result.duplicated && input.type === 'text') {
      void scheduleGroupResponse(db, {
        conversationId: input.conversationId,
        messageId: result.message.id,
        senderId: userId,
        content: result.message.content,
        mentions: result.message.meta?.mentions,
        mentionAll: result.message.meta?.mentionAll,
      })
    }

    return result
  })

  app.post('/messages/forward', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ForwardMessagesSchema, request.body)
    return await messageService.forward(db, {
      userId,
      messageIds: input.messageIds,
      targetConversationIds: input.targetConversationIds,
      deviceId: deviceIdOf(request),
    })
  })

  app.patch<{ Params: { id: string } }>('/messages/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(EditMessageSchema, request.body)
    return {
      message: await messageService.edit(db, {
        messageId: request.params.id,
        userId,
        content: input.content,
        deviceId: deviceIdOf(request),
      }),
    }
  })

  app.delete<{ Params: { id: string } }>('/messages/:id', async (request) => {
    const userId = await requireUserId(request)
    return { message: await messageService.recall(db, { messageId: request.params.id, userId }) }
  })

  app.post<{ Params: { id: string } }>('/messages/:id/pin', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(PinMessageSchema, request.body)
    return { message: await messageService.pin(db, { messageId: request.params.id, userId, pinned: input.pinned }) }
  })

  app.get<{ Params: { id: string } }>('/conversations/:id/pins', async (request) => {
    const userId = await requireUserId(request)
    await assertMember(db, request.params.id, userId)
    const pinned = await messagesRepo.listPinned(db, request.params.id)
    return { messages: pinned.map(messagesRepo.mapMessage) }
  })

  app.post<{ Params: { id: string } }>('/conversations/:id/read', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(MarkReadSchema, request.body)
    return await messageService.markRead(db, {
      conversationId: request.params.id,
      userId,
      seq: input.messageSeq,
      messageId: input.messageId ?? null,
      deviceId: deviceIdOf(request),
    })
  })

  /** 群聊已读人数：由已读游标聚合推导，不额外存每消息回执 */
  app.get<{ Params: { id: string }; Querystring: { seq?: string } }>(
    '/conversations/:id/read-count',
    async (request) => {
      const userId = await requireUserId(request)
      await assertMember(db, request.params.id, userId)
      const seq = Number(request.query.seq ?? 0)
      return {
        count: await readCursorsRepo.countReadUpTo(db, request.params.id, Number.isFinite(seq) ? seq : 0),
      }
    },
  )
}
