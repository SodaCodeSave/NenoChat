import type { FastifyInstance } from 'fastify'
import { SearchQuerySchema } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as searchService from '../../services/search-service'

/** 全局搜索：消息走全文检索（短词回退模糊匹配），用户与会话走名称匹配 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/search', async (request) => {
    const userId = await requireUserId(request)
    const query = parse(SearchQuerySchema, request.query)
    return await searchService.search(db, userId, {
      q: query.q,
      scope: query.scope,
      conversationId: query.conversationId,
      limit: query.limit,
    })
  })
}
