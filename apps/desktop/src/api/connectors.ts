import {
  API_PREFIX,
  type BilibiliVideoMaterial,
  type Connector,
  type ConnectorSearchResult,
  type ConnectorType,
  type LinkPreview,
} from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export interface ConnectorInput {
  type: ConnectorType
  name: string
  enabled?: boolean
  config?: {
    baseUrl?: string | null
    count?: number | null
    maxComments?: number | null
  }
  secret?: {
    apiKey?: string
    cookie?: string
  }
}

export const connectorApi = {
  list: () => http.get<{ connectors: Connector[] }>(p('/connectors')),
  create: (body: ConnectorInput) => http.post<{ connector: Connector }>(p('/connectors'), body),
  update: (id: string, body: Partial<Omit<ConnectorInput, 'type'>>) =>
    http.patch<{ connector: Connector }>(p(`/connectors/${id}`), body),
  remove: (id: string) => http.delete<{ ok: boolean }>(p(`/connectors/${id}`)),
  toggle: (id: string, enabled: boolean) =>
    http.post<{ connector: Connector }>(p(`/connectors/${id}/toggle`), { enabled }),
  test: (id: string) =>
    http.post<{ connector: Connector; ok: boolean; message: string }>(p(`/connectors/${id}/test`)),

  /** 用已启用的 DeepSeek 搜索连接器检索网页 */
  search: (query: string) =>
    http.post<{ results: ConnectorSearchResult[] }>(p('/connectors/search'), { query }),

  /** 抓取 B 站视频材料；服务端会做缓存 */
  prepareBilibili: (url: string) =>
    http.post<{ material: BilibiliVideoMaterial }>(p('/connectors/bilibili/prepare'), { url }),

  /** 本机密钥模式：本地总结完成后回传缓存 */
  saveBilibiliSummary: (body: { videoId: string; summary: string; model?: string }) =>
    http.post<{ ok: boolean }>(p('/connectors/bilibili/summaries'), body),

  /** 读取已缓存的视频总结 */
  bilibiliSummary: (videoId: string) =>
    http.get<{ summary: string | null; updatedAt: number | null }>(
      p('/connectors/bilibili/summary'),
      { query: { videoId } },
    ),

  /** 链接卡片元信息（服务端抓取并缓存） */
  linkPreview: (url: string) =>
    http.get<{ preview: LinkPreview | null }>(p('/connectors/link-preview'), { query: { url } }),
}
