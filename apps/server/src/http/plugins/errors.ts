import type { FastifyInstance } from 'fastify'
import { ApiErrorCode } from '@nenochat/shared'
import { AppError, normalizeError } from '../../util/errors'
import { isDev } from '../../env'

/** 统一错误响应体：{ error: { code, message, details? } } */
export function applyErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: ApiErrorCode.NOT_FOUND,
        message: `接口不存在: ${request.method} ${request.url}`,
      },
    }),
  )

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error)

    // 框架层的校验/体积错误映射到业务码
    const status = (error as { statusCode?: number }).statusCode ?? 500
    let code = normalized.code
    if (code === ApiErrorCode.INTERNAL) {
      if (status === 400) code = ApiErrorCode.VALIDATION
      else if (status === 404) code = ApiErrorCode.NOT_FOUND
      else if (status === 413) code = ApiErrorCode.PAYLOAD_TOO_LARGE
      else if (status === 429) code = ApiErrorCode.RATE_LIMITED
    }

    const httpStatus = error instanceof AppError ? error.status : status

    if (httpStatus >= 500) {
      request.log.error({ err: error, url: request.url }, 'request failed')
    } else if (isDev) {
      request.log.warn({ err: error, url: request.url }, 'request rejected')
    }

    return reply.code(httpStatus).send({
      error: {
        code,
        message: normalized.message,
        ...(isDev && normalized.details !== undefined ? { details: normalized.details } : {}),
      },
    })
  })
}
