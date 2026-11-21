import type { FastifyInstance } from 'fastify'
import { UserSettingsPatchSchema } from '@nenochat/shared'
import { NotificationSettingsPatchSchema } from '@nenochat/shared/notifications/schema'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import {
  mapNotificationSettings,
  mapUserSettings,
  updateNotificationSettings,
  updateUserSettings,
} from '../../db/repo/settings'

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.patch('/settings', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(UserSettingsPatchSchema, request.body)
    return {
      settings: mapUserSettings(await updateUserSettings(db, userId, input)),
    }
  })

  app.patch('/settings/notifications', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(NotificationSettingsPatchSchema, request.body)
    return {
      notificationSettings: mapNotificationSettings(await updateNotificationSettings(db, userId, input)),
    }
  })
}
