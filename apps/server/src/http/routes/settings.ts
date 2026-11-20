import type { FastifyInstance } from 'fastify'
import { NotificationSettingsPatchSchema } from '@nenochat/shared/notifications/schema'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import {
  mapNotificationSettings,
  updateNotificationSettings,
} from '../../db/repo/settings'

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.patch('/settings/notifications', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(NotificationSettingsPatchSchema, request.body)
    return {
      notificationSettings: mapNotificationSettings(await updateNotificationSettings(db, userId, input)),
    }
  })
}
