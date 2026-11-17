import type {
  Connector,
  ConnectorConfig,
  ConnectorSearchResult,
  ConnectorSecretMask,
  ConnectorType,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as repo from '../db/repo/connectors'
import { decryptSecret, encryptSecret, maskSecret } from '../util/crypto'
import { err } from '../util/errors'

/** 各类连接器的默认配置 */
const DEFAULTS = {
  deepseek_search: { baseUrl: 'https://api.deepseek.com', count: 5, maxComments: 8 },
  bilibili: { baseUrl: '', count: 0, maxComments: 8 },
} satisfies Record<ConnectorType, { baseUrl: string; count: number; maxComments: number }>

export interface ConnectorSecret {
  apiKey?: string
  cookie?: string
}

export interface ConnectorCreatePayload {
  type: ConnectorType
  name: string
  enabled?: boolean
  config?: ConnectorConfig
  secret?: ConnectorSecret
}

export interface ConnectorPatchPayload {
  name?: string
  enabled?: boolean
  config?: ConnectorConfig
  secret?: ConnectorSecret
}

function parseConfig(row: repo.ConnectorRow): ConnectorConfig {
  try {
    const parsed = JSON.parse(row.config) as ConnectorConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function readConnectorSecret(row: repo.ConnectorRow): ConnectorSecret {
  if (!row.secret_enc) return {}
  try {
    const parsed = JSON.parse(decryptSecret(row.secret_enc)) as ConnectorSecret
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function toPublic(row: repo.ConnectorRow): Connector {
  const secret = readConnectorSecret(row)
  const secretMasked: ConnectorSecretMask = {
    apiKey: secret.apiKey ? maskSecret(secret.apiKey) : null,
    cookie: secret.cookie ? maskSecret(secret.cookie) : null,
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type as ConnectorType,
    name: row.name,
    enabled: row.enabled === 1,
    config: parseConfig(row),
    secretMasked,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestMessage: row.last_test_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 按类型补齐默认值并校验必填项 */
function normalizeConfig(type: ConnectorType, config: ConnectorConfig | undefined): ConnectorConfig {
  const base = DEFAULTS[type]
  const merged: ConnectorConfig = {
    baseUrl: config?.baseUrl?.trim() || base.baseUrl || null,
    count:
      config?.count === undefined || config.count === null
        ? type === 'deepseek_search'
          ? base.count
          : null
        : Math.min(20, Math.max(1, Math.round(config.count))),
    maxComments:
      config?.maxComments === undefined || config.maxComments === null
        ? base.maxComments
        : Math.min(20, Math.max(0, Math.round(config.maxComments))),
  }
  return merged
}

function assertSecret(type: ConnectorType, secret: ConnectorSecret): void {
  if (type === 'deepseek_search' && !secret.apiKey?.trim()) {
    throw err.validation('DeepSeek 搜索连接器需要填写 API Key')
  }
}

function encodeSecret(secret: ConnectorSecret): string | null {
  const cleaned: ConnectorSecret = {}
  if (secret.apiKey?.trim()) cleaned.apiKey = secret.apiKey.trim()
  if (secret.cookie?.trim()) cleaned.cookie = secret.cookie.trim()
  if (Object.keys(cleaned).length === 0) return null
  return encryptSecret(JSON.stringify(cleaned))
}

export function listConnectors(db: DB, ownerId: string): Connector[] {
  return repo.listConnectors(db, ownerId).map(toPublic)
}

export function findOwnedConnector(db: DB, ownerId: string, id: string): repo.ConnectorRow {
  const row = repo.findConnector(db, id)
  if (!row || row.owner_id !== ownerId) throw err.notFound('连接器不存在')
  return row
}

export function createConnector(
  db: DB,
  ownerId: string,
  input: ConnectorCreatePayload,
): Connector {
  const secret = input.secret ?? {}
  assertSecret(input.type, secret)
  const row = repo.createConnector(db, {
    ownerId,
    type: input.type,
    name: input.name,
    enabled: input.enabled ?? true,
    config: JSON.stringify(normalizeConfig(input.type, input.config)),
    secretEnc: encodeSecret(secret),
  })
  return toPublic(row)
}

export function updateConnector(
  db: DB,
  ownerId: string,
  id: string,
  input: ConnectorPatchPayload,
): Connector {
  const current = findOwnedConnector(db, ownerId, id)
  const type = current.type as ConnectorType

  let secretEnc: string | null | undefined
  if (input.secret) {
    const existing = readConnectorSecret(current)
    const merged: ConnectorSecret = { ...existing }
    if (input.secret.apiKey !== undefined) merged.apiKey = input.secret.apiKey
    if (input.secret.cookie !== undefined) merged.cookie = input.secret.cookie
    assertSecret(type, merged)
    secretEnc = encodeSecret(merged)
  }

  const config =
    input.config === undefined
      ? undefined
      : JSON.stringify(normalizeConfig(type, { ...parseConfig(current), ...input.config }))

  const row = repo.updateConnector(db, id, {
    name: input.name,
    enabled: input.enabled,
    config,
    secretEnc,
  })
  return toPublic(row)
}

export function toggleConnector(
  db: DB,
  ownerId: string,
  id: string,
  enabled: boolean,
): Connector {
  findOwnedConnector(db, ownerId, id)
  return toPublic(repo.updateConnector(db, id, { enabled }))
}

export function deleteConnector(db: DB, ownerId: string, id: string): void {
  findOwnedConnector(db, ownerId, id)
  repo.softDeleteConnector(db, id)
}

/* ------------------------------ 限流 ------------------------------ */

const buckets = new Map<string, number[]>()

/** 进程内滑动窗口限流：自建服务单实例部署，够用且无需额外依赖 */
export function takeRateLimit(key: string, limit: number, windowMs: number): void {
  const ts = Date.now()
  const history = (buckets.get(key) ?? []).filter((at) => ts - at < windowMs)
  if (history.length >= limit) {
    buckets.set(key, history)
    throw err.rateLimited('连接器调用过于频繁，请稍后再试')
  }
  history.push(ts)
  buckets.set(key, history)
  // 顺手清理过大的桶，避免长期运行内存膨胀
  if (buckets.size > 500) {
    for (const [bucketKey, list] of buckets) {
      if (list.every((at) => ts - at >= windowMs)) buckets.delete(bucketKey)
    }
  }
}

/* --------------------------- 外部请求工具 --------------------------- */

export class ConnectorRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorRequestError'
  }
}

interface FetchJsonInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
}

async function readBodyLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new ConnectorRequestError('上游响应过大')

  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ConnectorRequestError('上游响应过大')
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return text
}

/** 带超时与响应体上限的 JSON 请求，错误信息直接给用户看 */
export async function fetchConnectorJson<T>(
  url: string,
  init: FetchJsonInit = {},
): Promise<T> {
  const { timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024, method, headers, body } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  let text: string
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    })
    text = await readBodyLimited(response, maxBytes)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ConnectorRequestError('连接超时，请检查网络或稍后重试')
    }
    if (e instanceof ConnectorRequestError) throw e
    throw new ConnectorRequestError('无法连接到上游服务，请检查地址与网络')
  } finally {
    clearTimeout(timer)
  }

  let payload: unknown = null
  try {
    payload = text ? (JSON.parse(text) as unknown) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object'
        ? extractErrorMessage(payload)
        : ''
    throw new ConnectorRequestError(
      message ? `上游返回 ${response.status}：${message}` : `上游返回 ${response.status}`,
    )
  }
  if (payload === null) throw new ConnectorRequestError('上游返回了无法解析的内容')
  return payload as T
}

function extractErrorMessage(payload: object): string {
  const record = payload as Record<string, unknown>
  const nested = record.error
  if (nested && typeof nested === 'object') {
    const message = (nested as Record<string, unknown>).message
    if (typeof message === 'string') return message.slice(0, 160)
  }
  if (typeof record.message === 'string' && record.message && record.message !== 'OK') {
    return record.message.slice(0, 160)
  }
  return ''
}

/* ------------------------------ 测试连接 ------------------------------ */

interface DeepSeekSearchPayload {
  results?: Array<{
    title?: string
    url?: string
    snippet?: string
    summary?: string
    site_name?: string | null
    site_icon?: string | null
    date?: string | null
    rerank_score?: number
  }>
}

export function normalizeSearchResults(payload: DeepSeekSearchPayload): ConnectorSearchResult[] {
  return (payload.results ?? [])
    .filter((item) => typeof item.title === 'string' && typeof item.url === 'string')
    .map((item) => ({
      title: item.title!.trim(),
      url: item.url!,
      snippet: item.snippet ?? '',
      summary: item.summary ?? '',
      siteName: item.site_name ?? null,
      siteIcon: item.site_icon ?? null,
      date: item.date ?? null,
      score: item.rerank_score ?? null,
    }))
}

export async function searchDeepSeek(
  row: repo.ConnectorRow,
  query: string,
  count?: number,
): Promise<ConnectorSearchResult[]> {
  const config = parseConfig(row)
  const secret = readConnectorSecret(row)
  if (!secret.apiKey) throw err.validation('该连接器没有保存 API Key')
  const base = (config.baseUrl || DEFAULTS.deepseek_search.baseUrl).replace(/\/$/, '')
  const url = base.endsWith('/tools/search')
    ? base
    : base.endsWith('/v1')
      ? `${base}/tools/search`
      : `${base}/v1/tools/search`

  const payload = await fetchConnectorJson<DeepSeekSearchPayload>(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret.apiKey}`,
    },
    body: JSON.stringify({
      query: query.slice(0, 128),
      count: Math.min(20, Math.max(1, count ?? config.count ?? 5)),
      need_content: false,
    }),
  })
  return normalizeSearchResults(payload)
}

interface BilibiliViewPayload {
  code?: number
  message?: string
  data?: { bvid?: string; title?: string; owner?: { name?: string } }
}

/** 用一条公开视频验证 B 站接口可达；带 Cookie 时顺带验证登录态 */
export async function probeBilibili(secret: ConnectorSecret): Promise<{
  ok: boolean
  message: string
}> {
  const headers: Record<string, string> = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    referer: 'https://www.bilibili.com/',
  }
  if (secret.cookie) headers.cookie = secret.cookie

  const payload = await fetchConnectorJson<BilibiliViewPayload>(
    'https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7',
    { headers, timeoutMs: 10_000 },
  )
  if (payload.code !== 0) {
    return { ok: false, message: payload.message || 'B 站接口返回异常' }
  }
  if (!secret.cookie) {
    return { ok: true, message: '连接正常（未填写 Cookie，只能获取公开信息，字幕可能不可用）' }
  }

  const nav = await fetchConnectorJson<{
    code?: number
    message?: string
    data?: { isLogin?: boolean; uname?: string }
  }>('https://api.bilibili.com/x/web-interface/nav', { headers, timeoutMs: 10_000 })
  if (nav.code !== 0 || !nav.data?.isLogin) {
    return { ok: false, message: 'Cookie 无效或已过期，请重新复制' }
  }
  return { ok: true, message: `连接正常，已登录：${nav.data.uname ?? 'B 站账号'}` }
}

export async function testConnector(
  db: DB,
  ownerId: string,
  id: string,
): Promise<{ connector: Connector; ok: boolean; message: string }> {
  const row = findOwnedConnector(db, ownerId, id)
  const type = row.type as ConnectorType
  takeRateLimit(`test:${ownerId}:${id}`, 6, 60_000)

  let result: { ok: boolean; message: string }
  try {
    if (type === 'deepseek_search') {
      const results = await searchDeepSeek(row, 'DeepSeek', 1)
      result = { ok: true, message: `连接成功，返回 ${results.length} 条结果` }
    } else if (type === 'bilibili') {
      result = await probeBilibili(readConnectorSecret(row))
    } else {
      throw err.validation('不支持的连接器类型')
    }
  } catch (e) {
    result = { ok: false, message: e instanceof Error ? e.message : '测试失败' }
  }

  repo.saveTestResult(db, id, result)
  const fresh = repo.findConnector(db, id)
  return {
    connector: toPublic(fresh ?? row),
    ok: result.ok,
    message: result.message,
  }
}

/** 供其他服务取「已启用的某类连接器」，没有时返回 null */
export function enabledConnectorOfType(
  db: DB,
  ownerId: string,
  type: ConnectorType,
): repo.ConnectorRow | null {
  return repo.listEnabledByType(db, ownerId, type)[0] ?? null
}

/** 用用户已启用的 DeepSeek 搜索连接器检索网页 */
export async function searchWithEnabledConnector(
  db: DB,
  ownerId: string,
  query: string,
): Promise<ConnectorSearchResult[]> {
  const row = enabledConnectorOfType(db, ownerId, 'deepseek_search')
  if (!row) throw err.validation('还没有启用 DeepSeek 搜索连接器')
  takeRateLimit(`search:${ownerId}`, 30, 60_000)
  return searchDeepSeek(row, query)
}
