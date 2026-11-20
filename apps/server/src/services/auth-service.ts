import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  ulid,
  type AuthTokens,
  type DeviceInfo,
  type LoginInput,
  type RegisterInput,
  type User,
} from '@nenochat/shared'
import type { DB } from '../db'
import { one, run } from '../db'
import { withTx } from '../db/tx'
import * as usersRepo from '../db/repo/users'
import * as devicesRepo from '../db/repo/devices'
import * as tokensRepo from '../db/repo/refresh-tokens'
import { ensureNotificationSettings, ensureUserSettings } from '../db/repo/settings'
import { err } from '../util/errors'
import { hashPassword, randomToken, sha256, verifyPassword } from '../util/crypto'
import { env } from '../env'
import { now } from '../util/clock'

/** 只依赖 @fastify/jwt 的 sign 能力，便于测试时替换 */
export interface JwtSigner {
  sign(payload: AccessTokenPayload, options?: { expiresIn?: string | number }): string
}

/** 一体化版内置服务端里唯一的本机账号 */
const LOCAL_USERNAME = 'owner'
const LOCAL_DISPLAY_NAME = '我'

export interface AccessTokenPayload {
  sub: string
  did: string
  typ: 'access'
}

export interface AuthSession {
  user: User
  tokens: AuthTokens
}

const ACCESS_TTL_SECONDS = Math.floor(ACCESS_TOKEN_TTL_MS / 1000)

async function issueTokens(
  db: DB,
  signer: JwtSigner,
  user: User,
  deviceId: string,
  familyId: string = ulid(),
): Promise<{ tokens: AuthTokens; tokenId: string }> {
  const accessToken = signer.sign(
    { sub: user.id, did: deviceId, typ: 'access' } satisfies AccessTokenPayload,
    { expiresIn: ACCESS_TTL_SECONDS },
  )

  const refreshToken = randomToken(32)
  const tokenId = await tokensRepo.insert(db, {
    userId: user.id,
    deviceId,
    tokenHash: sha256(refreshToken),
    familyId,
    // 0 表示永不过期，靠滑动使用维持自动登录，只有手动退出才失效
    expiresAt: REFRESH_TOKEN_TTL_MS > 0 ? now() + REFRESH_TOKEN_TTL_MS : 0,
  })

  return { tokens: { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }, tokenId }
}

async function assertRegistrationAllowed(db: DB, inviteCode?: string): Promise<void> {
  const mode = env.REGISTRATION_MODE
  if (mode === 'closed') throw err.forbidden('本服务器已关闭注册')

  if (mode === 'invite') {
    if (!inviteCode) throw err.validation('本服务器需要邀请码')
    const invite = await one<{ code: string; max_uses: number; uses: number; expires_at: number | null }>(
      db,
      'SELECT code, max_uses, uses, expires_at FROM invites WHERE code = ?',
      [inviteCode],
    )
    if (!invite) throw err.validation('邀请码无效')
    if (invite.expires_at !== null && invite.expires_at < now()) throw err.validation('邀请码已过期')
    if (invite.uses >= invite.max_uses) throw err.validation('邀请码已用尽')
    await run(db, 'UPDATE invites SET uses = uses + 1 WHERE code = ?', [inviteCode])
  }
}

/** 首个注册的用户自动成为管理员，方便自建服务器开箱即可运维 */
async function isFirstUser(db: DB): Promise<boolean> {
  const row = await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM users')
  return (row?.c ?? 0) === 0
}

export async function register(db: DB, signer: JwtSigner, input: RegisterInput): Promise<AuthSession> {
  const passwordHash = await hashPassword(input.password)

  return withTx(db, async (tx) => {
    await assertRegistrationAllowed(tx, input.inviteCode)

    if (await usersRepo.usernameExists(tx, input.username)) {
      throw err.conflict('用户名已被占用')
    }

    const row = await usersRepo.create(tx, {
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      isAdmin: await isFirstUser(tx),
      deviceId: input.device.id,
    })

    await devicesRepo.upsert(tx, row.id, input.device)
    await ensureUserSettings(tx, row.id)
    await ensureNotificationSettings(tx, row.id)

    const user = usersRepo.mapUser(row)
    const { tokens } = await issueTokens(tx, signer, user, input.device.id)
    return { user, tokens }
  })
}

export async function login(db: DB, signer: JwtSigner, input: LoginInput): Promise<AuthSession> {
  const row = await usersRepo.findByUsername(db, input.username)
  // 用户不存在与密码错误返回同一提示，避免用户名枚举
  if (!row) throw err.unauthenticated('用户名或密码不正确')
  // 影子账号（AI 角色）不能登录，密码散列也不是真实凭据
  if (row.status === 'disabled' || row.is_bot === 1) throw err.forbidden('账号已被禁用')

  const ok = await verifyPassword(row.password_hash, input.password)
  if (!ok) throw err.unauthenticated('用户名或密码不正确')

  return withTx(db, async (tx) => {
    await devicesRepo.upsert(tx, row.id, input.device)
    await ensureUserSettings(tx, row.id)
    await ensureNotificationSettings(tx, row.id)
    await usersRepo.touchLastSeen(tx, row.id)

    const user = usersRepo.mapUser(row)
    const { tokens } = await issueTokens(tx, signer, user, input.device.id)
    return { user, tokens }
  })
}

/**
 * 一体化版免密码登录：本机令牌已在路由层校验过，这里只负责把 owner 账号和会话准备好。
 * 首次启动自动建号，之后每次启动直接复用同一账号，数据不会随重启丢失。
 */
export async function ensureLocalSession(
  db: DB,
  signer: JwtSigner,
  device: DeviceInfo,
): Promise<AuthSession> {
  const existing = await usersRepo.findByUsername(db, LOCAL_USERNAME)
  if (existing) {
    if (existing.status === 'disabled') throw err.forbidden('账号已被禁用')
    return withTx(db, async (tx) => {
      await devicesRepo.upsert(tx, existing.id, device)
      await ensureUserSettings(tx, existing.id)
      await ensureNotificationSettings(tx, existing.id)
      await usersRepo.touchLastSeen(tx, existing.id)
      const { tokens } = await issueTokens(tx, signer, usersRepo.mapUser(existing), device.id)
      return { user: usersRepo.mapUser(existing), tokens }
    })
  }

  // 密码用随机串占位：本机账号只能凭启动令牌进入，密码登录对它无效
  const passwordHash = await hashPassword(randomToken(24))

  return withTx(db, async (tx) => {
    const row = await usersRepo.create(tx, {
      username: LOCAL_USERNAME,
      displayName: LOCAL_DISPLAY_NAME,
      passwordHash,
      isAdmin: true,
      deviceId: device.id,
    })
    await devicesRepo.upsert(tx, row.id, device)
    await ensureUserSettings(tx, row.id)
    await ensureNotificationSettings(tx, row.id)

    const user = usersRepo.mapUser(row)
    const { tokens } = await issueTokens(tx, signer, user, device.id)
    return { user, tokens }
  })
}

export async function refresh(
  db: DB,
  signer: JwtSigner,
  refreshToken: string,
  deviceId: string,
): Promise<AuthSession> {
  const hash = sha256(refreshToken)
  const existing = await tokensRepo.findByHash(db, hash)
  if (!existing) throw err.unauthenticated('登录凭证无效')
  if (existing.revoked_at !== null) {
    // 已轮换过的 token 再次出现，视为泄露：整条链作废
    await tokensRepo.revokeFamily(db, existing.family_id)
    throw err.unauthenticated('登录凭证已失效，请重新登录')
  }
  if (existing.expires_at > 0 && existing.expires_at < now()) throw err.tokenExpired()

  const row = await usersRepo.findById(db, existing.user_id)
  if (!row) throw err.unauthenticated('用户不存在')
  if (row.status === 'disabled') throw err.forbidden('账号已被禁用')

  return withTx(db, async (tx) => {
    const user = usersRepo.mapUser(row)
    const { tokens, tokenId } = await issueTokens(tx, signer, user, deviceId, existing.family_id)
    // 新 token 落库后立刻作废旧 token，保证一条链上同时只有一个有效凭证
    await tokensRepo.revoke(tx, existing.id, tokenId)
    await devicesRepo.touch(tx, row.id, deviceId)
    return { user, tokens }
  })
}

export async function logout(db: DB, userId: string, refreshToken?: string, allDevices?: boolean): Promise<void> {
  if (allDevices) {
    await tokensRepo.revokeAllForUser(db, userId)
    return
  }
  if (refreshToken) {
    const row = await tokensRepo.findByHash(db, sha256(refreshToken))
    if (row && row.user_id === userId) await tokensRepo.revoke(db, row.id)
  }
}

export async function revokeDevice(db: DB, userId: string, deviceId: string): Promise<void> {
  await tokensRepo.revokeForDevice(db, userId, deviceId)
  await devicesRepo.remove(db, userId, deviceId)
}
