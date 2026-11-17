import type { FastifyInstance } from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { corsOrigins } from '../../env'

/**
 * 手写 CORS：自建服务器场景足够用，且省掉一个依赖。
 * 支持带凭证的跨域（Web 版客户端需要）。
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
      reply.header('Access-Control-Allow-Credentials', 'true')
      reply.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Device-Id, X-Client-Version',
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
