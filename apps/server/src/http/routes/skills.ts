import type { FastifyInstance } from 'fastify'
import { SkillCreateSchema, SkillPatchSchema } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as skillService from '../../services/skill-service'

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/skills', async (request) => {
    const userId = await requireUserId(request)
    return { skills: await skillService.listSkills(db, userId) }
  })

  app.post('/skills', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(SkillCreateSchema, request.body)
    return { skill: await skillService.createSkill(db, userId, input) }
  })

  app.patch<{ Params: { id: string } }>('/skills/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(SkillPatchSchema, request.body)
    return { skill: await skillService.updateSkill(db, userId, request.params.id, input) }
  })

  app.delete<{ Params: { id: string } }>('/skills/:id', async (request) => {
    const userId = await requireUserId(request)
    await skillService.deleteSkill(db, userId, request.params.id)
    return { ok: true }
  })
}
