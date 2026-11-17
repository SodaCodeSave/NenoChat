import type { FastifyInstance } from 'fastify'
import { getDb } from '../../db'
import { requireUserId } from '../plugins/auth'
import * as syncService from '../../services/sync-service'

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /** WS 断线时的兜底补拉，与 WS catchUp 走同一条查询路径 */
  app.get<{ Querystring: { since?: string; limit?: string } }>('/sync/changes', async (request) => {
    const userId = await requireUserId(request)
    const since = Number(request.query.since ?? 0)
    const limit = Math.min(Number(request.query.limit ?? 500) || 500, 1000)

    const min = syncService.minCursor(db)
    if (since > 0 && min > 0 && since < min - 1) {
      return { reset: true, reason: 'cursor_expired', snapshotCursor: min - 1 }
    }

    return syncService.listChanges(db, userId, Number.isFinite(since) ? since : 0, limit)
  })

  app.get('/sync/head', async () => ({ cursor: syncService.maxCursor(db) }))
}
