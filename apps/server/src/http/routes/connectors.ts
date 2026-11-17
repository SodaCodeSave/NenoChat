import type { FastifyInstance } from 'fastify'
import {
  ConnectorCreateSchema,
  ConnectorPatchSchema,
  ConnectorSearchSchema,
  ConnectorToggleSchema,
} from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as connectorService from '../../services/connector-service'

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/connectors', async (request) => {
    const userId = await requireUserId(request)
    return { connectors: connectorService.listConnectors(db, userId) }
  })

  app.post('/connectors', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ConnectorCreateSchema, request.body)
    return { connector: connectorService.createConnector(db, userId, input) }
  })

  app.patch<{ Params: { id: string } }>('/connectors/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ConnectorPatchSchema, request.body)
    return { connector: connectorService.updateConnector(db, userId, request.params.id, input) }
  })

  app.delete<{ Params: { id: string } }>('/connectors/:id', async (request) => {
    const userId = await requireUserId(request)
    connectorService.deleteConnector(db, userId, request.params.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/connectors/:id/toggle', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ConnectorToggleSchema, request.body)
    return {
      connector: connectorService.toggleConnector(db, userId, request.params.id, input.enabled),
    }
  })

  app.post<{ Params: { id: string } }>('/connectors/:id/test', async (request) => {
    const userId = await requireUserId(request)
    return connectorService.testConnector(db, userId, request.params.id)
  })

  /** 用已启用的搜索连接器检索网页；本机密钥模式由客户端拿到结果后自行注入上下文 */
  app.post('/connectors/search', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(ConnectorSearchSchema, request.body)
    const results = await connectorService.searchWithEnabledConnector(db, userId, input.query)
    return { results }
  })
}
