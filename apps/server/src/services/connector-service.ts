import type {
  Connector,
  ConnectorConfig,
  ConnectorSearchResult,
  ConnectorSecretMask,
  ConnectorType,
  FetchedPage,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as repo from '../db/repo/connectors'
import { decryptSecret, encryptSecret, maskSecret } from '../util/crypto'
import { err } from '../util/errors'

/** 各类连接器的默认配置 */
const DEFAULTS = {
  deepseek_search: { baseUrl: 'https://api.deepseek.com', count: 5, maxComments: 8 },
  bilibili: { baseUrl: '', count: 0, maxComments: 8 },
  heweather: { baseUrl: 'https://api.qweather.com/v7', count: 0, maxComments: 0 },
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
  if (type === 'heweather') {
    merged.location = config?.location?.trim() || null
    merged.latitude = config?.latitude ?? null
    merged.longitude = config?.longitude ?? null
    merged.weatherAlways = config?.weatherAlways ?? false
    merged.weatherOnUserMessage = config?.weatherOnUserMessage ?? false
    merged.weatherOnMention = config?.weatherOnMention ?? true
    merged.weatherTool = config?.weatherTool ?? false
  }
  return merged
}

function assertSecret(type: ConnectorType, secret: ConnectorSecret): void {
  if ((type === 'deepseek_search' || type === 'heweather') && !secret.apiKey?.trim()) {
    throw err.validation(type === 'heweather' ? '和风天气连接器需要填写 API Key' : 'DeepSeek 搜索连接器需要填写 API Key')
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

/** 兼容用户填 api.deepseek.com、/v1 或完整 tools 路径 */
function deepseekUrl(config: ConnectorConfig, endpoint: 'tools/search' | 'tools/fetch'): string {
  const base = (config.baseUrl || DEFAULTS.deepseek_search.baseUrl).replace(/\/$/, '')
  if (base.endsWith(`/${endpoint}`)) return base
  if (base.endsWith('/v1')) return `${base}/${endpoint}`
  return `${base}/v1/${endpoint}`
}

export async function searchDeepSeek(
  row: repo.ConnectorRow,
  query: string,
  count?: number,
): Promise<ConnectorSearchResult[]> {
  const config = parseConfig(row)
  const secret = readConnectorSecret(row)
  if (!secret.apiKey) throw err.validation('该连接器没有保存 API Key')
  const url = deepseekUrl(config, 'tools/search')

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

interface DeepSeekFetchPayload {
  title?: string
  content?: string
}

/** 复用 DeepSeek 连接器抓取网页正文（Markdown） */
export async function fetchDeepSeekPage(
  row: repo.ConnectorRow,
  url: string,
): Promise<FetchedPage> {
  const config = parseConfig(row)
  const secret = readConnectorSecret(row)
  if (!secret.apiKey) throw err.validation('该连接器没有保存 API Key')

  const payload = await fetchConnectorJson<DeepSeekFetchPayload>(
    deepseekUrl(config, 'tools/fetch'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret.apiKey}`,
      },
      body: JSON.stringify({ url }),
      timeoutMs: 20_000,
      maxBytes: 8 * 1024 * 1024,
    },
  )
  if (typeof payload.content !== 'string') {
    throw new ConnectorRequestError('网页抓取失败：上游没有返回正文')
  }
  return { url, title: payload.title ?? '', content: payload.content }
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

interface WeatherPayload {
  code?: string
  updateTime?: string
  fxLink?: string
  now?: { temp?: string; feelsLike?: string; text?: string; windDir?: string; windScale?: string; humidity?: string; precip?: string; vis?: string }
  daily?: Array<{ fxDate?: string; tempMax?: string; tempMin?: string; textDay?: string; windDirDay?: string; windScaleDay?: string }>
  condition?: { text?: string }
  temperature?: { value?: number; unit?: string }
  feelsLike?: { value?: number; unit?: string }
  wind?: { direction?: { compass?: string }; scale?: number }
  humidity?: number
}

function weatherUrl(config: ConnectorConfig, endpoint: string, location: string): string {
  let base = (config.baseUrl || DEFAULTS.heweather.baseUrl).trim().replace(/\/+$/, '')
  // 和风天气 Web API 的地址通常填写为根域名或 /v7；统一补齐版本路径，避免
  // 用户填写 https://api.qweather.com 后请求成 /weather/now 导致 404。
  try {
    const parsed = new URL(base)
    if (parsed.hostname === 'api.qweather.com' && !parsed.pathname.endsWith('/v7')) {
      base = `${base}/v7`
    }
  } catch {
    // URL 校验交给后续请求处理，保持原有错误信息。
  }
  const normalizedEndpoint = endpoint.replace(/^\/+/, '')
  const url = new URL(`${base}/${normalizedEndpoint}`)
  url.searchParams.set('location', location)
  return url.toString()
}

export async function fetchHeweather(row: repo.ConnectorRow): Promise<string> {
  const config = parseConfig(row)
  const secret = readConnectorSecret(row)
  if (!secret.apiKey) throw err.validation('该连接器没有保存和风天气 API Key')
  const coordinates = config.latitude != null && config.longitude != null
    ? { latitude: config.latitude, longitude: config.longitude }
    : null
  const location = coordinates ? `${coordinates.longitude},${coordinates.latitude}` : config.location?.trim()
  if (!location) throw err.validation('请先配置默认城市或经纬度')
  const base = (config.baseUrl || DEFAULTS.heweather.baseUrl).replace(/\/+$/, '')
  const isV1 = /\/weather\/v1(?:\/|$)/.test(base) || /qweatherapi\.com$/i.test(new URL(base).hostname)
  const apiKeyHeaders = { 'X-QW-Api-Key': secret.apiKey! }
  let current: WeatherPayload
  let forecast: WeatherPayload | null = null
  if (isV1) {
    if (!coordinates) throw err.validation('和风天气实时天气 v1 需要纬度和经度，请填写坐标')
    const v1Base = base.replace(/\/weather\/v1\/?$/, '').replace(/\/$/, '')
    const currentUrl = `${v1Base}/weather/v1/current/${coordinates.latitude}/${coordinates.longitude}`
    const dailyUrl = `${v1Base}/weather/v1/daily/${coordinates.latitude}/${coordinates.longitude}`
    ;[current, forecast] = await Promise.all([
      fetchConnectorJson<WeatherPayload>(currentUrl, { headers: apiKeyHeaders }),
      fetchConnectorJson<WeatherPayload>(dailyUrl, { headers: apiKeyHeaders }).catch(() => null),
    ])
  } else {
    let v7Base = base
    if (/^https?:\/\/(?:api|devapi)\.qweather\.com$/i.test(base)) v7Base += '/v7'
    const withKey = (endpoint: string) => {
      const url = new URL(`${v7Base}/${endpoint}`)
      url.searchParams.set('location', location)
      url.searchParams.set('key', secret.apiKey!)
      return url.toString()
    }
    ;[current, forecast] = await Promise.all([
      fetchConnectorJson<WeatherPayload>(withKey('weather/now')),
      fetchConnectorJson<WeatherPayload>(withKey('weather/3d')).catch(() => null),
    ])
  }
  if (current.code && current.code !== '200') throw new ConnectorRequestError(`和风天气返回错误：${current.code}`)
  const legacy = current.now
  const description = legacy?.text ?? current.condition?.text ?? '未知'
  const temperature = legacy?.temp ?? current.temperature?.value ?? '--'
  const feelsLike = legacy?.feelsLike ?? current.feelsLike?.value ?? '--'
  const lines = [`【天气信息】${config.location ?? location}`, `当前：${description}，${temperature}°C（体感 ${feelsLike}°C）`]
  if (legacy?.windDir || current.wind?.direction?.compass || legacy?.windScale || current.wind?.scale) {
    lines.push(`风：${legacy?.windDir ?? current.wind?.direction?.compass ?? ''} ${legacy?.windScale ?? current.wind?.scale ?? ''}级，湿度 ${legacy?.humidity ?? (current.humidity == null ? '--' : Math.round(current.humidity * 100))}%`)
  }
  for (const day of (forecast?.daily ?? []).slice(0, 3)) lines.push(`${day.fxDate ?? ''}：${day.textDay ?? ''}，${day.tempMin ?? '--'}-${day.tempMax ?? '--'}°C，${day.windDirDay ?? ''}${day.windScaleDay ?? ''}级`)
  return lines.join('\n')
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
    } else if (type === 'heweather') {
      await fetchHeweather(row)
      result = { ok: true, message: '连接成功，天气数据获取正常' }
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
