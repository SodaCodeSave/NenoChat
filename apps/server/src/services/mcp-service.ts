import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ChatToolDef, McpServer, McpServerConfig, McpServerSecretMask } from '@nenochat/shared'
import type { DB } from '../db'
import * as repo from '../db/repo/mcp-servers'
import { allowPrivateAiEndpoint } from '../env'
import { decryptSecret, encryptSecret, maskSecret } from '../util/crypto'
import { err } from '../util/errors'
import { assertPublicUrl } from '../util/ssrf'

/** 生成期间的默认工具调用超时；用户可在 config.timeoutMs 里调 */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const MAX_TOOL_TIMEOUT_MS = 120_000
/** 连接与列工具的预算：生成期间逐服务器连接，太慢会拖住整条回复 */
const CONNECT_TIMEOUT_MS = 10_000
/** 工具结果截断，防止超大返回撑爆上下文 */
const TOOL_RESULT_LIMIT = 16_000

export interface McpServerSecret {
  headers?: Record<string, string>
}

export interface McpServerCreatePayload {
  name: string
  url: string
  enabled?: boolean
  config?: McpServerConfig
  secret?: McpServerSecret
}

export interface McpServerPatchPayload {
  name?: string
  url?: string
  enabled?: boolean
  config?: McpServerConfig
  secret?: McpServerSecret
}

export interface McpToolset {
  /** 供上游 tools 字段用的工具定义 */
  tools: ChatToolDef[]
  /** 执行一个已注册的 MCP 工具，失败以文本形式返回给模型而不是中断生成 */
  call: (toolName: string, argsJson: string) => Promise<string>
  /** 调用名 → MCP 原始工具名，用于实时提示里的人类可读展示 */
  labelOf: (toolName: string) => string
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

function parseConfig(row: repo.McpServerRow): McpServerConfig {
  try {
    return JSON.parse(row.config || '{}') as McpServerConfig
  } catch {
    return {}
  }
}

function parseSecret(row: repo.McpServerRow): McpServerSecret {
  if (!row.secret_enc) return {}
  try {
    const parsed = JSON.parse(decryptSecret(row.secret_enc)) as McpServerSecret
    return { headers: parsed.headers ?? {} }
  } catch {
    return {}
  }
}

function maskHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    masked[key] = maskSecret(value)
  }
  return masked
}

function toPublic(row: repo.McpServerRow): McpServer {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    url: row.url,
    enabled: row.enabled === 1,
    config: parseConfig(row),
    secretMasked: { headers: maskHeaders(parseSecret(row).headers) },
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestMessage: row.last_test_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function assertMcpUrl(raw: string): Promise<URL> {
  return assertPublicUrl(raw, { allowPrivate: allowPrivateAiEndpoint }).catch((e) => {
    throw err.validation(`MCP 服务器地址不合法：${e instanceof Error ? e.message : String(e)}`)
  })
}

function encodeSecret(secret: McpServerSecret | undefined): string | null {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(secret?.headers ?? {})) {
    const trimmed = value.trim()
    if (trimmed) headers[key.trim()] = trimmed
  }
  if (Object.keys(headers).length === 0) return null
  return encryptSecret(JSON.stringify({ headers }))
}

export async function listMcpServers(db: DB, ownerId: string): Promise<McpServer[]> {
  const rows = await repo.listMcpServers(db, ownerId)
  return rows.map(toPublic)
}

export async function findOwnedServer(db: DB, ownerId: string, id: string): Promise<repo.McpServerRow> {
  const row = await repo.findMcpServer(db, id)
  if (!row || row.owner_id !== ownerId) throw err.notFound('MCP 服务器不存在')
  return row
}

export async function createMcpServer(db: DB, ownerId: string, input: McpServerCreatePayload): Promise<McpServer> {
  await assertMcpUrl(input.url)
  const row = await repo.createMcpServer(db, {
    ownerId,
    name: input.name,
    url: input.url,
    enabled: input.enabled ?? true,
    config: JSON.stringify(input.config ?? {}),
    secretEnc: encodeSecret(input.secret),
  })
  return toPublic(row)
}

export async function updateMcpServer(
  db: DB,
  ownerId: string,
  id: string,
  patch: McpServerPatchPayload,
): Promise<McpServer> {
  await findOwnedServer(db, ownerId, id)
  if (patch.url !== undefined) await assertMcpUrl(patch.url)
  const row = await repo.updateMcpServer(db, id, {
    name: patch.name,
    url: patch.url,
    enabled: patch.enabled,
    config: patch.config === undefined ? undefined : JSON.stringify(patch.config),
    // undefined 表示保持原值；显式传 {} 表示清空
    secretEnc: patch.secret === undefined ? undefined : encodeSecret(patch.secret),
  })
  return toPublic(row)
}

export async function deleteMcpServer(db: DB, ownerId: string, id: string): Promise<void> {
  await findOwnedServer(db, ownerId, id)
  await repo.softDeleteMcpServer(db, id)
}

/**
 * 建一条到 MCP 服务器的客户端连接：先走 Streamable HTTP，
 * 协商失败（常见于旧版仅 SSE 端点）再退回 SSE 传输。
 */
async function connectClient(url: URL, headers: Record<string, string>): Promise<Client> {
  const clientInfo = { name: 'NenoChat', version: '1.0.0' }
  const streamable = new Client(clientInfo)
  try {
    await withTimeout(
      streamable.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } })),
      CONNECT_TIMEOUT_MS,
      '连接 MCP 服务器',
    )
    return streamable
  } catch {
    await streamable.close().catch(() => {})
  }
  const sse = new Client(clientInfo)
  await withTimeout(
    sse.connect(
      // SSE 传输的 GET 事件流走 EventSource，请求头要单独塞进 eventSourceInit
      new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { headers } as unknown as EventSourceInit,
      }),
    ),
    CONNECT_TIMEOUT_MS,
    '连接 MCP 服务器',
  )
  return sse
}

interface McpToolEntry {
  /** 发给上游的调用名（mcp_<服务器>_<工具>） */
  exposedName: string
  /** MCP 服务器上的原始工具名 */
  toolName: string
  serverRow: repo.McpServerRow
}

/** OpenAI function calling 的工具名有字符集限制，统一压成 [a-zA-Z0-9_-] */
function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'server'
}

async function listToolsOf(row: repo.McpServerRow): Promise<Tool[]> {
  const secret = parseSecret(row)
  const client = await connectClient(await assertPublicUrl(row.url, { allowPrivate: allowPrivateAiEndpoint }), secret.headers ?? {})
  try {
    const result = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, '获取 MCP 工具列表')
    return result.tools
  } finally {
    await client.close().catch(() => {})
  }
}

export interface McpTestResult {
  ok: boolean
  message: string
}

export async function testMcpServer(db: DB, ownerId: string, id: string): Promise<McpTestResult> {
  const row = await findOwnedServer(db, ownerId, id)
  let result: McpTestResult
  try {
    const tools = await listToolsOf(row)
    const names = tools.map((t) => t.name).slice(0, 8).join('、')
    const more = tools.length > 8 ? ` 等 ${tools.length} 个工具` : ''
    result = { ok: true, message: tools.length > 0 ? `发现 ${tools.length} 个工具：${names}${more}` : '连接成功，但服务器没有提供工具' }
  } catch (e) {
    result = { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
  await repo.saveMcpServerTestResult(db, id, result)
  return result
}

/**
 * 生成期间组装用户的 MCP 工具集：逐个启用中的服务器连接并列工具，
 * 单个失败静默跳过（与连接器上下文同一容错哲学），全部失败就是纯聊天。
 */
export async function buildToolset(db: DB, ownerId: string): Promise<McpToolset> {
  const rows = await repo.listEnabledMcpServers(db, ownerId)
  const entries: McpToolEntry[] = []
  const tools: ChatToolDef[] = []
  const usedNames = new Set<string>()

  for (const row of rows) {
    let mcpTools: Tool[]
    try {
      mcpTools = await listToolsOf(row)
    } catch {
      continue
    }
    const serverSlug = sanitizeName(row.name).replace(/^_+$/, '') || `srv${rows.indexOf(row) + 1}`
    for (const tool of mcpTools) {
      let exposed = `mcp_${serverSlug}_${sanitizeName(tool.name)}`
      let seq = 2
      while (usedNames.has(exposed)) {
        exposed = `mcp_${serverSlug}_${sanitizeName(tool.name)}_${seq}`
        seq += 1
      }
      usedNames.add(exposed)
      entries.push({ exposedName: exposed, toolName: tool.name, serverRow: row })
      tools.push({
        type: 'function',
        function: {
          name: exposed,
          description: tool.description?.slice(0, 1000) || exposed,
          parameters:
            tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
              ? (tool.inputSchema as ChatToolDef['function']['parameters'])
              : { type: 'object', properties: {} },
        },
      })
    }
  }

  const toolTimeoutOf = (row: repo.McpServerRow): number => {
    const parsed = parseConfig(row).timeoutMs
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return DEFAULT_TOOL_TIMEOUT_MS
    return Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(1000, Math.round(parsed)))
  }

  return {
    tools,
    call: async (exposedName: string, argsJson: string): Promise<string> => {
      const entry = entries.find((e) => e.exposedName === exposedName)
      if (!entry) return `工具 ${exposedName} 不存在，可能所属服务器已停用`
      let args: Record<string, unknown>
      try {
        args = (JSON.parse(argsJson || '{}') as Record<string, unknown>) ?? {}
      } catch {
        return `工具参数不是合法 JSON：${argsJson.slice(0, 200)}`
      }
      try {
        const secret = parseSecret(entry.serverRow)
        const client = await connectClient(
          await assertPublicUrl(entry.serverRow.url, { allowPrivate: allowPrivateAiEndpoint }),
          secret.headers ?? {},
        )
        try {
          const result = await withTimeout(
            client.callTool({ name: entry.toolName, arguments: args }),
            toolTimeoutOf(entry.serverRow),
            `执行工具 ${entry.toolName}`,
          )
          const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? []
          const text = content
            .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : `[${part.type ?? 'unknown'} 内容]`))
            .join('\n')
          const isError = (result as { isError?: boolean }).isError === true
          const final = isError ? `工具执行出错：${text || '未知错误'}` : text || '（工具没有返回内容）'
          return final.length > TOOL_RESULT_LIMIT ? `${final.slice(0, TOOL_RESULT_LIMIT)}…（已截断）` : final
        } finally {
          await client.close().catch(() => {})
        }
      } catch (e) {
        return `工具调用失败：${e instanceof Error ? e.message : String(e)}`
      }
    },
    labelOf: (exposedName: string): string =>
      entries.find((e) => e.exposedName === exposedName)?.toolName ?? exposedName,
  }
}
