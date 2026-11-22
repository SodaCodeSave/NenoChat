import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  ApiErrorCode,
  LocalLoginSchema,
  LocalPairSchema,
  LoginSchema,
  LogoutSchema,
  RefreshSchema,
  RegisterSchema,
} from '@nenochat/shared'
import { env, localMode, pairingEnabled } from '../../env'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import { rateLimit } from '../plugins/rate-limit'
import * as loginThrottle from '../plugins/login-throttle'
import { safeEqual } from '../../util/crypto'
import { AppError, err } from '../../util/errors'
import * as pairingService from '../../services/pairing-service'
import * as authService from '../../services/auth-service'
import * as usersRepo from '../../db/repo/users'
import * as devicesRepo from '../../db/repo/devices'
import * as adminAuditRepo from '../../db/repo/admin-audit'
import {
  ensureNotificationSettings,
  ensureUserSettings,
  mapNotificationSettings,
  mapUserSettings,
} from '../../db/repo/settings'

/**
 * 管理员登录写审计：成功与失败各记一条（action: admin.login）。
 * 失败时只有当目标用户名确属管理员才落审计，避免公网扫描把审计日志刷爆。
 */
async function auditAdminLogin(
  db: ReturnType<typeof getDb>,
  userId: string,
  request: FastifyRequest,
  ok: boolean,
  deviceId: string,
): Promise<void> {
  await adminAuditRepo.insert(db, {
    actorId: userId,
    action: 'admin.login',
    targetType: 'user',
    targetId: userId,
    detail: { ok, ip: request.ip, deviceId },
  })
}

async function auditFailedLoginOfAdmin(
  db: ReturnType<typeof getDb>,
  username: string,
  request: FastifyRequest,
  deviceId: string,
): Promise<void> {
  const row = await usersRepo.findByUsername(db, username)
  if (!row || row.is_admin !== 1) return
  await auditAdminLogin(db, row.id, request, false, deviceId)
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.post(
    '/auth/register',
    { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) },
    async (request) => {
      const input = parse(RegisterSchema, request.body)
      return await authService.register(db, app.jwt, input)
    },
  )

  app.post('/auth/login', { preHandler: rateLimit({ max: 10, windowMs: 60_000 }) }, async (request) => {
    const input = parse(LoginSchema, request.body)
    // 账号维度限流先于密码校验：已在限流中的账号不再消耗 argon2 算力
    loginThrottle.check(input.username)
    try {
      const session = await authService.login(db, app.jwt, input)
      loginThrottle.clear(input.username)
      if (session.user.isAdmin) {
        await auditAdminLogin(db, session.user.id, request, true, input.device.id)
      }
      return session
    } catch (e) {
      if (e instanceof AppError && e.code === ApiErrorCode.UNAUTHENTICATED) {
        loginThrottle.recordFailure(input.username)
        await auditFailedLoginOfAdmin(db, input.username, request, input.device.id)
      }
      throw e
    }
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
    return await authService.ensureLocalSession(db, app.jwt, input.device)
  })

  /**
   * 电脑端生成手机接入用的配对码。只有本机账号能拿，且必须处于局域网开放状态。
   */
  app.post('/auth/pair/code', async (request) => {
    await requireUserId(request)
    if (!pairingEnabled) throw err.forbidden('未开启局域网接入')
    return await pairingService.issueCode()
  })

  /** 手机扫码后凭配对码换会话；码一次性，过期即失效 */
  app.post('/auth/pair', { preHandler: rateLimit({ max: 20, windowMs: 60_000 }) }, async (request) => {
    if (!pairingEnabled) throw err.forbidden('未开启局域网接入')
    const input = parse(LocalPairSchema, request.body)
    if (!(await pairingService.consumeCode(input.code))) {
      throw err.unauthenticated('配对码无效或已过期，请在电脑上刷新后重试')
    }
    return await authService.ensureLocalSession(db, app.jwt, input.device)
  })

  app.post('/auth/refresh', { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) }, async (request) => {
    const input = parse(RefreshSchema, request.body)
    return await authService.refresh(db, app.jwt, input.refreshToken, input.device.id)
  })

  app.post('/auth/logout', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(LogoutSchema, request.body ?? {})
    await authService.logout(db, userId, input.refreshToken, input.allDevices)
    return { ok: true }
  })

  /** 当前登录态自检：返回用户资料与两端设置，客户端启动时一次性拉齐 */
  app.get('/auth/me', async (request) => {
    const userId = await requireUserId(request)
    const row = await usersRepo.findById(db, userId)
    if (!row) return { user: null, settings: null, notificationSettings: null }

    return {
      user: usersRepo.mapUser(row),
      settings: mapUserSettings(await ensureUserSettings(db, userId)),
      notificationSettings: mapNotificationSettings(await ensureNotificationSettings(db, userId)),
    }
  })

  /** 当前账号的登录设备列表，用于「远程登出」 */
  app.get('/auth/devices', async (request) => {
    const userId = await requireUserId(request)
    const devices = await devicesRepo.list(db, userId)
    return { devices: devices.map(devicesRepo.mapDevice) }
  })

  app.delete<{ Params: { deviceId: string } }>('/auth/devices/:deviceId', async (request) => {
    const userId = await requireUserId(request)
    await authService.revokeDevice(db, userId, request.params.deviceId)
    return { ok: true }
  })
}
