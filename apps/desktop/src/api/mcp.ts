import { API_PREFIX, type McpServer } from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export interface McpServerInput {
  name: string
  url: string
  enabled?: boolean
  config?: {
    timeoutMs?: number | null
  }
  secret?: {
    headers?: Record<string, string>
  }
}

export const mcpApi = {
  list: () => http.get<{ servers: McpServer[] }>(p('/mcp-servers')),
  create: (body: McpServerInput) => http.post<{ server: McpServer }>(p('/mcp-servers'), body),
  update: (id: string, body: Partial<Omit<McpServerInput, 'name' | 'url'>> & Partial<Pick<McpServerInput, 'name' | 'url'>>) =>
    http.patch<{ server: McpServer }>(p(`/mcp-servers/${id}`), body),
  remove: (id: string) => http.delete<{ ok: boolean }>(p(`/mcp-servers/${id}`)),
  /** 连接并列出工具，结果写回 last_test_* */
  test: (id: string) => http.post<{ result: { ok: boolean; message: string } }>(p(`/mcp-servers/${id}/test`)),
}
