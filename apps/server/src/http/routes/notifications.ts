import type { FastifyInstance } from 'fastify'
import {
  MarkNotificationsReadSchema,
  NotificationListQuerySchema,
} from '@nenochat/shared/notifications/schema'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as notificationService from '../../services/notification-service'

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /** 通知中心：倒序分页，附带未读总数 */
  app.get('/notifications', async (request) => {
    const userId = await requireUserId(request)
    const query = parse(NotificationListQuerySchema, request.query)
    return notificationService.listNotifications(db, userId, {
      limit: query.limit,
      before: query.before ?? null,
    })
  })

  /** 标记已读：按 id 批量或全部清零 */
  app.post('/notifications/read', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(MarkNotificationsReadSchema, request.body)
    return notificationService.markNotificationsRead(db, userId, input)
  })
}
