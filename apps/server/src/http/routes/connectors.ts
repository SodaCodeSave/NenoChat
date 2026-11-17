import type { FastifyInstance } from 'fastify'
import {
  BilibiliPrepareSchema,
  BilibiliSummaryQuerySchema,
  BilibiliSummarySaveSchema,
  ConnectorCreateSchema,
  ConnectorPatchSchema,
  ConnectorSearchSchema,
  ConnectorToggleSchema,
  LinkPreviewQuerySchema,
} from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as connectorService from '../../services/connector-service'
import * as bilibiliService from '../../services/bilibili-service'
import * as linkPreviewService from '../../services/link-preview-service'
import { err } from '../../util/errors'

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

  /** 抓取 B 站视频信息、字幕/热评与已缓存的总结 */
  app.post('/connectors/bilibili/prepare', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(BilibiliPrepareSchema, request.body)
    const material = await bilibiliService.prepareVideoMaterial(db, userId, input.url)
    if (!material) throw err.validation('还没有启用 B 站连接器')
    return { material }
  })

  /** 本机密钥模式：客户端本地总结后回传缓存，按视频去重 */
  app.post('/connectors/bilibili/summaries', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(BilibiliSummarySaveSchema, request.body)
    bilibiliService.saveClientSummary(db, userId, input)
    return { ok: true }
  })

  /** 卡片「查看总结」读取缓存 */
  app.get('/connectors/bilibili/summary', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(BilibiliSummaryQuerySchema, request.query)
    return bilibiliService.getCachedSummary(db, userId, input.videoId)
  })

  /** 聊天链接卡片：服务端抓取并缓存元信息，失败返回 null 由客户端降级为纯链接 */
  app.get('/connectors/link-preview', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(LinkPreviewQuerySchema, request.query)
    return { preview: await linkPreviewService.getLinkPreview(db, userId, input.url) }
  })
}
