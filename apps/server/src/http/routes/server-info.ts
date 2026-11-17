import type { FastifyInstance } from 'fastify'
import type { ServerInfo } from '@nenochat/shared'
import { MAX_GROUP_MEMBERS_DEFAULT, MAX_UPLOAD_IMAGE_BYTES } from '@nenochat/shared'
import { env } from '../../env'
import { APP_VERSION, MIN_CLIENT_VERSION } from '../../version'

/** 未登录也可访问：客户端加服务器时用它探测地址是否可用、能力是否匹配 */
export async function serverInfoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/server/info', async (): Promise<ServerInfo> => {
    const mode = env.REGISTRATION_MODE
    return {
      name: env.SERVER_NAME,
      version: APP_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      registration: {
        open: mode !== 'closed',
        inviteRequired: mode === 'invite',
      },
      limits: {
        maxUploadMb: Math.round(MAX_UPLOAD_IMAGE_BYTES / (1024 * 1024)),
        maxGroupMembers: MAX_GROUP_MEMBERS_DEFAULT,
      },
      features: {
        ai: true,
        proactive: true,
        moments: true,
      },
    }
  })
}
