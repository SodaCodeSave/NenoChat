import type { FastifyInstance } from 'fastify'
import { AddPersonaContactSchema, ContactAliasSchema, FriendRequestSchema } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as contactService from '../../services/contact-service'

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /** 通讯录：好友、收到的申请、发出的申请，AI 与真人在同一个列表里 */
  app.get('/contacts', async (request) => {
    const userId = await requireUserId(request)
    return await contactService.list(db, userId)
  })

  app.post('/contacts/requests', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(FriendRequestSchema, request.body)
    return { contact: await contactService.sendRequest(db, userId, input.userId, input.message) }
  })

  app.post<{ Params: { userId: string } }>('/contacts/requests/:userId/accept', async (request) => {
    const userId = await requireUserId(request)
    return await contactService.accept(db, userId, request.params.userId)
  })

  app.post<{ Params: { userId: string } }>('/contacts/requests/:userId/decline', async (request) => {
    const userId = await requireUserId(request)
    await contactService.decline(db, userId, request.params.userId)
    return { ok: true }
  })

  /** 把自己的 AI 角色加回通讯录（移除后会话仍在） */
  app.post('/contacts/personas', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(AddPersonaContactSchema, request.body)
    return { contact: await contactService.addOwnPersona(db, userId, input.personaId) }
  })

  app.patch<{ Params: { userId: string } }>('/contacts/:userId', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ContactAliasSchema, request.body)
    return { contact: await contactService.setAlias(db, userId, request.params.userId, input.alias ?? null) }
  })

  app.delete<{ Params: { userId: string } }>('/contacts/:userId', async (request) => {
    const userId = await requireUserId(request)
    await contactService.removeFriend(db, userId, request.params.userId)
    return { ok: true }
  })
}
