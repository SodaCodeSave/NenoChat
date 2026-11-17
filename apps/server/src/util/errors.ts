import { ApiErrorCode } from '@nenochat/shared'

const STATUS_BY_CODE: Record<string, number> = {
  [ApiErrorCode.UNAUTHENTICATED]: 401,
  [ApiErrorCode.TOKEN_EXPIRED]: 401,
  [ApiErrorCode.FORBIDDEN]: 403,
  [ApiErrorCode.NOT_FOUND]: 404,
  [ApiErrorCode.VALIDATION]: 400,
  [ApiErrorCode.CONFLICT]: 409,
  [ApiErrorCode.RATE_LIMITED]: 429,
  [ApiErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ApiErrorCode.UPSTREAM_AI_ERROR]: 502,
  [ApiErrorCode.INTERNAL]: 500,
}

/** 业务错误：携带稳定的机器可读 code 与 HTTP 状态码 */
export class AppError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS_BY_CODE[code] ?? 500
    this.details = details
  }
}

export const err = {
  unauthenticated: (message = '请先登录') => new AppError(ApiErrorCode.UNAUTHENTICATED, message),
  tokenExpired: (message = '登录已过期') => new AppError(ApiErrorCode.TOKEN_EXPIRED, message),
  forbidden: (message = '没有权限执行此操作') => new AppError(ApiErrorCode.FORBIDDEN, message),
  notFound: (message = '资源不存在') => new AppError(ApiErrorCode.NOT_FOUND, message),
  validation: (message = '参数不合法', details?: unknown) =>
    new AppError(ApiErrorCode.VALIDATION, message, details),
  conflict: (message = '操作冲突') => new AppError(ApiErrorCode.CONFLICT, message),
  rateLimited: (message = '操作过于频繁') => new AppError(ApiErrorCode.RATE_LIMITED, message),
  tooLarge: (message = '内容超出大小限制') => new AppError(ApiErrorCode.PAYLOAD_TOO_LARGE, message),
  upstreamAi: (message = 'AI 服务返回异常', details?: unknown) =>
    new AppError(ApiErrorCode.UPSTREAM_AI_ERROR, message, details),
  internal: (message = '服务器内部错误') => new AppError(ApiErrorCode.INTERNAL, message),
}

/** 把任意异常规整为 { code, message, details } */
export function normalizeError(e: unknown): { code: string; message: string; details?: unknown } {
  if (e instanceof AppError) {
    return { code: e.code, message: e.message, details: e.details }
  }
  if (e instanceof Error) {
    return { code: ApiErrorCode.INTERNAL, message: e.message }
  }
  return { code: ApiErrorCode.INTERNAL, message: '未知错误' }
}
