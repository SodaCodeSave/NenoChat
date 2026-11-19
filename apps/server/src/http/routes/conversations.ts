import type { FastifyInstance } from 'fastify'
import {
  AddMembersSchema,
  ConversationType,
  CreateConversationSchema,
  PinConversationSchema,
  TransferOwnerSchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
} from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as conversationService from '../../services/conversation-service'
import { err } from '../../util/errors'
import { toMemberPatch } from './member-patch'

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/conversations', async (request) => {
    const userId = await requireUserId(request)
    return { conversations: conversationService.list(db, userId) }
  })

  app.post('/conversations', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(CreateConversationSchema, request.body)

    if (input.type === ConversationType.Direct) {
      if (!input.targetUserId) throw err.validation('私聊需要指定对方用户')
      const conversation = conversationService.openDirect(db, userId, input.targetUserId)
      return { conversation }
    }

    if (input.type === ConversationType.Group) {
      if (!input.name) throw err.validation('群聊需要名称')
      const result = conversationService.createGroup(db, userId, {
        name: input.name,
        memberIds: input.memberIds,
        avatarUrl: input.avatarUrl ?? null,
      })
      return result
    }

    throw err.validation('AI 会话请使用 /ai/conversations 创建')
  })

  app.get<{ Params: { id: string } }>('/conversations/:id', async (request) => {
    const userId = await requireUserId(request)
    return conversationService.detail(db, request.params.id, userId)
  })

  app.patch<{ Params: { id: string } }>('/conversations/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(UpdateConversationSchema, request.body)
    return { conversation: conversationService.update(db, request.params.id, userId, input) }
  })

  app.post<{ Params: { id: string } }>('/conversations/:id/pin', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(PinConversationSchema, request.body)
    return { member: conversationService.setPin(db, request.params.id, userId, input.pinned) }
  })

  app.post<{ Params: { id: string } }>('/conversations/:id/members', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(AddMembersSchema, request.body)
    return { members: conversationService.addMembers(db, request.params.id, userId, input.userIds) }
  })

  app.patch<{ Params: { id: string; userId: string } }>(
    '/conversations/:id/members/:userId',
    async (request) => {
      const actorId = await requireUserId(request)
      const patch = parse(UpdateMemberSchema, request.body)
      const member = conversationService.updateMember(
        db,
        request.params.id,
        actorId,
        request.params.userId,
        toMemberPatch(patch),
      )
      return { member }
    },
  )

  app.delete<{ Params: { id: string; userId: string } }>(
    '/conversations/:id/members/:userId',
    async (request) => {
      const actorId = await requireUserId(request)
      conversationService.removeMember(db, request.params.id, actorId, request.params.userId)
      return { ok: true }
    },
  )

  /** 单侧删除私聊会话，对端历史不受影响 */
  app.delete<{ Params: { id: string } }>('/conversations/:id/for-me', async (request) => {
    const userId = await requireUserId(request)
    conversationService.deleteConversationForUser(db, request.params.id, userId)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/conversations/:id', async (request) => {
    const userId = await requireUserId(request)
    conversationService.dissolveGroup(db, request.params.id, userId)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/conversations/:id/transfer', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(TransferOwnerSchema, request.body)
    return conversationService.transferOwner(db, request.params.id, userId, input.userId)
  })
}
