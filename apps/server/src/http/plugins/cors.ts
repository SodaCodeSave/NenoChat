import type { FastifyInstance } from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { corsOrigins } from '../../env'

/**
 * 手写 CORS：自建服务器场景足够用，且省掉一个依赖。
 * 默认通配所有来源（NAS 内网直连场景），此时不发送凭证头，避免「任意来源 + 允许凭证」的组合；
 * 显式配置 CORS_ORIGINS 后才允许携带凭证的跨域（Web 版客户端需要）。
 */
export function applyCors(app: FastifyInstance): void {
  const allowAll = corsOrigins === true

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin
    if (origin) {
      if (allowAll) {
        reply.header('Access-Control-Allow-Origin', origin)
      } else {
        reply.header('Access-Control-Allow-Origin', (corsOrigins as string[]).includes(origin) ? origin : '')
      }
      reply.header('Vary', 'Origin')
      if (!allowAll) {
        reply.header('Access-Control-Allow-Credentials', 'true')
      }
      reply.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Device-Id, X-Client-Version, X-Local-Token',
      )
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      reply.header('Access-Control-Max-Age', '86400')
    }

    if (request.method === 'OPTIONS') {
      return reply.code(204).send()
    }
    return undefined
  })
}
