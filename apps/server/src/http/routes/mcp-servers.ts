import type { FastifyInstance } from 'fastify'
import { McpServerCreateSchema, McpServerPatchSchema } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as mcpService from '../../services/mcp-service'

export async function mcpServerRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/mcp-servers', async (request) => {
    const userId = await requireUserId(request)
    return { servers: await mcpService.listMcpServers(db, userId) }
  })

  app.post('/mcp-servers', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(McpServerCreateSchema, request.body)
    return { server: await mcpService.createMcpServer(db, userId, input) }
  })

  app.patch<{ Params: { id: string } }>('/mcp-servers/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(McpServerPatchSchema, request.body)
    return { server: await mcpService.updateMcpServer(db, userId, request.params.id, input) }
  })

  app.delete<{ Params: { id: string } }>('/mcp-servers/:id', async (request) => {
    const userId = await requireUserId(request)
    await mcpService.deleteMcpServer(db, userId, request.params.id)
    return { ok: true }
  })

  /** 连接并列出工具，结果写回 last_test_* 供卡片展示 */
  app.post<{ Params: { id: string } }>('/mcp-servers/:id/test', async (request) => {
    const userId = await requireUserId(request)
    return { result: await mcpService.testMcpServer(db, userId, request.params.id) }
  })
}
