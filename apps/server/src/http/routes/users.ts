import type { FastifyInstance } from 'fastify'
import { ChangePasswordSchema, UpdateProfileSchema } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import { err } from '../../util/errors'
import { hashPassword, verifyPassword } from '../../util/crypto'
import * as usersRepo from '../../db/repo/users'
import { writeChange } from '../../services/change-log'

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.patch('/users/me', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(UpdateProfileSchema, request.body)
    const deviceId = request.headers['x-device-id']

    const row = await usersRepo.updateProfile(db, userId, input, typeof deviceId === 'string' ? deviceId : undefined)
    await writeChange(db, {
      entity: 'user',
      entityId: userId,
      op: 'upsert',
      payload: usersRepo.mapPublicUser(row),
      actorId: userId,
    })
    return { user: usersRepo.mapUser(row) }
  })

  app.post('/users/me/password', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ChangePasswordSchema, request.body)

    const row = await usersRepo.findById(db, userId)
    if (!row) throw err.notFound('用户不存在')

    const ok = await verifyPassword(row.password_hash, input.oldPassword)
    if (!ok) throw err.validation('原密码不正确')

    await usersRepo.setPasswordHash(db, userId, await hashPassword(input.newPassword))
    return { ok: true }
  })

  app.get<{ Querystring: { q?: string } }>('/users/search', async (request) => {
    const userId = await requireUserId(request)
    const keyword = (request.query.q ?? '').trim()
    if (keyword.length === 0) return { users: [] }
    const rows = await usersRepo.search(db, keyword, userId, 20)
    return { users: rows.map(usersRepo.mapPublicUser) }
  })

  app.get<{ Params: { id: string } }>('/users/:id', async (request) => {
    await requireUserId(request)
    const row = await usersRepo.findById(db, request.params.id)
    if (!row) throw err.notFound('用户不存在')
    return { user: usersRepo.mapPublicUser(row) }
  })
}
