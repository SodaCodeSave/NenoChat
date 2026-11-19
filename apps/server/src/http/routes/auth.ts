import type { FastifyInstance } from 'fastify'
import { LocalLoginSchema, LoginSchema, LogoutSchema, RefreshSchema, RegisterSchema } from '@nenochat/shared'
import { env, localMode } from '../../env'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import { rateLimit } from '../plugins/rate-limit'
import { safeEqual } from '../../util/crypto'
import { err } from '../../util/errors'
import * as authService from '../../services/auth-service'
import * as usersRepo from '../../db/repo/users'
import * as devicesRepo from '../../db/repo/devices'
import {
  ensureNotificationSettings,
  ensureUserSettings,
  mapNotificationSettings,
  mapUserSettings,
} from '../../db/repo/settings'

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.post(
    '/auth/register',
    { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
    async (request) => {
      const input = parse(RegisterSchema, request.body)
      return authService.register(db, app.jwt, input)
    },
  )

  app.post('/auth/login', { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) }, async (request) => {
    const input = parse(LoginSchema, request.body)
    return authService.login(db, app.jwt, input)
  })

  /**
   * 一体化版入口：客户端启动时拉起本服务端，带上进程内生成的握手令牌换会话。
   * 非本地模式一律拒绝，联网版服务端不暴露这条路径。
   */
  app.post('/auth/local', async (request) => {
    if (!localMode) throw err.forbidden('该服务器未启用本地模式')
    const given = request.headers['x-local-token']
    if (typeof given !== 'string' || !safeEqual(given, env.LOCAL_AUTH_TOKEN)) {
      throw err.unauthenticated('本机凭证无效')
    }
    const input = parse(LocalLoginSchema, request.body)
    return authService.ensureLocalSession(db, app.jwt, input.device)
  })

  app.post('/auth/refresh', { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) }, async (request) => {
    const input = parse(RefreshSchema, request.body)
    return authService.refresh(db, app.jwt, input.refreshToken, input.device.id)
  })

  app.post('/auth/logout', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(LogoutSchema, request.body ?? {})
    authService.logout(db, userId, input.refreshToken, input.allDevices)
    return { ok: true }
  })

  /** 当前登录态自检：返回用户资料与两端设置，客户端启动时一次性拉齐 */
  app.get('/auth/me', async (request) => {
    const userId = await requireUserId(request)
    const row = usersRepo.findById(db, userId)
    if (!row) return { user: null, settings: null, notificationSettings: null }

    return {
      user: usersRepo.mapUser(row),
      settings: mapUserSettings(ensureUserSettings(db, userId)),
      notificationSettings: mapNotificationSettings(ensureNotificationSettings(db, userId)),
    }
  })

  /** 当前账号的登录设备列表，用于「远程登出」 */
  app.get('/auth/devices', async (request) => {
    const userId = await requireUserId(request)
    return { devices: devicesRepo.list(db, userId).map(devicesRepo.mapDevice) }
  })

  app.delete<{ Params: { deviceId: string } }>('/auth/devices/:deviceId', async (request) => {
    const userId = await requireUserId(request)
    authService.revokeDevice(db, userId, request.params.deviceId)
    return { ok: true }
  })
}
