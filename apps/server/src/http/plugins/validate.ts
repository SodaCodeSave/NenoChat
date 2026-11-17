import type { ZodType } from 'zod'
import { err } from '../../util/errors'

/**
 * 用 zod 校验入参，失败时抛出带字段路径的 VALIDATION 错误。
 * 比接 fastify schema 更直观，也便于同一份 schema 在客户端复用。
 */
export function parse<S extends ZodType>(schema: S, data: unknown): S['_output'] {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw err.validation(
      '参数不合法',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    )
  }
  return result.data
}
