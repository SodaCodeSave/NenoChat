import { ApiErrorCode, API_PREFIX, type ApiErrorBody } from '@nenochat/shared'

/**
 * 管理面板的 HTTP 客户端（参照 desktop/src/api/http.ts 的简化版）。
 * 面板与 API 同源托管，baseUrl 留空走相对路径；
 * refresh token 存 localStorage，无 Tauri keychain。
 */

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }

  get isAuthError(): boolean {
    return this.code === ApiErrorCode.UNAUTHENTICATED || this.code === ApiErrorCode.TOKEN_EXPIRED
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  /** 是否附带 access token，默认 true */
  auth?: boolean
  signal?: AbortSignal
  /** 内部使用：已经重试过一次 */
  _retried?: boolean
}

interface HttpState {
  accessToken: string | null
  /** 401 时调用，返回新的 access token；返回 null 表示无法刷新 */
  refresh: () => Promise<string | null>
  onAuthLost: () => void
}

const state: HttpState = {
  accessToken: null,
  refresh: async () => null,
  onAuthLost: () => {},
}

export function configureHttp(patch: Partial<HttpState>): void {
  Object.assign(state, patch)
}

export function setAccessToken(token: string | null): void {
  state.accessToken = token
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(API_PREFIX + path, window.location.origin)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

let refreshing: Promise<string | null> | null = null

async function refreshOnce(): Promise<string | null> {
  if (!refreshing) {
    refreshing = state
      .refresh()
      .catch(() => null)
      .finally(() => {
        refreshing = null
      }) as Promise<string | null>
  }
  return refreshing
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, auth = true, signal } = options

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (auth && state.accessToken) headers.authorization = `Bearer ${state.accessToken}`

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (response.ok) return parsed as T

  const errorBody = parsed as ApiErrorBody | null
  const code = errorBody?.error?.code ?? ApiErrorCode.INTERNAL
  const message = errorBody?.error?.message ?? `请求失败 (${response.status})`

  // access token 过期：静默刷新后重试一次
  if (response.status === 401 && auth && !options._retried) {
    const token = await refreshOnce()
    if (token) {
      return request<T>(path, { ...options, _retried: true })
    }
    state.onAuthLost()
  }

  throw new ApiError(code, message, response.status, errorBody?.error?.details)
}

export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
}

/** 服务端只返回相对路径（/files/...），同源托管下直接拼接 origin */
export function resolveFileUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (/^(https?:|data:|blob:)/i.test(url)) return url
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
}
