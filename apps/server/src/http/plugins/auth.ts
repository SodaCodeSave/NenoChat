import type { FastifyInstance, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import type { AccessTokenPayload } from '../../services/auth-service'
import { env } from '../../env'
import { err } from '../../util/errors'

export async function registerAuthPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: '15m' },
    verify: { algorithms: ['HS256'] },
  })
}

/**
 * 校验 Authorization: Bearer <access> 并返回载荷。
 * access 过期与无效分开上报，客户端据此决定是刷新还是重新登录。
 */
export async function requireUser(request: FastifyRequest): Promise<AccessTokenPayload> {
  try {
    const payload = await request.jwtVerify<AccessTokenPayload>()
    if (payload.typ !== 'access' || !payload.sub) throw err.unauthenticated('凭证类型不合法')
    return payload
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === 'FAST_JWT_EXPIRED') {
      throw err.tokenExpired()
    }
    if (e instanceof Error && e.name === 'AppError') throw e
    throw err.unauthenticated('登录状态无效')
  }
}

export interface AuthedRequest extends FastifyRequest {
  auth: AccessTokenPayload
}

/** 组合 requireUser 与 userId 取出，减少每次手写解构 */
export async function requireUserId(request: FastifyRequest): Promise<string> {
  const auth = await requireUser(request)
  return auth.sub
}
