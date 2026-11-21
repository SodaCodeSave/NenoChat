import type { FastifyInstance } from 'fastify'
import type { ServerInfo } from '@nenochat/shared'
import { MAX_GROUP_MEMBERS_DEFAULT, MAX_UPLOAD_IMAGE_BYTES } from '@nenochat/shared'
import { getDb } from '../../db'
import { APP_VERSION, BUILD_STAMP, MIN_CLIENT_VERSION } from '../../version'
import { getRegistrationMode, getServerName } from '../../services/server-settings-service'

/** 未登录也可访问：客户端加服务器时用它探测地址是否可用、能力是否匹配 */
export async function serverInfoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/server/info', async (): Promise<ServerInfo> => {
    const db = getDb()
    // 名称与注册模式支持面板运行时修改，DB 值优先、env 兜底
    const [name, mode] = await Promise.all([getServerName(db), getRegistrationMode(db)])
    return {
      name,
      version: APP_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      buildStamp: BUILD_STAMP,
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
