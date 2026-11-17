import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  ulid,
  type AuthTokens,
  type LoginInput,
  type RegisterInput,
  type User,
} from '@nenochat/shared'
import type { DB } from '../db'
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

function issueTokens(
  db: DB,
  signer: JwtSigner,
  user: User,
  deviceId: string,
  familyId: string = ulid(),
): { tokens: AuthTokens; tokenId: string } {
  const accessToken = signer.sign(
    { sub: user.id, did: deviceId, typ: 'access' } satisfies AccessTokenPayload,
    { expiresIn: ACCESS_TTL_SECONDS },
  )

  const refreshToken = randomToken(32)
  const tokenId = tokensRepo.insert(db, {
    userId: user.id,
    deviceId,
    tokenHash: sha256(refreshToken),
    familyId,
    // 0 表示永不过期，靠滑动使用维持自动登录，只有手动退出才失效
    expiresAt: REFRESH_TOKEN_TTL_MS > 0 ? now() + REFRESH_TOKEN_TTL_MS : 0,
  })

  return { tokens: { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }, tokenId }
}

function assertRegistrationAllowed(db: DB, inviteCode?: string): void {
  const mode = env.REGISTRATION_MODE
  if (mode === 'closed') throw err.forbidden('本服务器已关闭注册')

  if (mode === 'invite') {
    if (!inviteCode) throw err.validation('本服务器需要邀请码')
    const invite = db
      .prepare('SELECT code, max_uses, uses, expires_at FROM invites WHERE code = ?')
      .get(inviteCode) as
      | { code: string; max_uses: number; uses: number; expires_at: number | null }
      | undefined
    if (!invite) throw err.validation('邀请码无效')
    if (invite.expires_at !== null && invite.expires_at < now()) throw err.validation('邀请码已过期')
    if (invite.uses >= invite.max_uses) throw err.validation('邀请码已用尽')
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(inviteCode)
  }
}

/** 首个注册的用户自动成为管理员，方便自建服务器开箱即可运维 */
function isFirstUser(db: DB): boolean {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  return row.c === 0
}

export async function register(db: DB, signer: JwtSigner, input: RegisterInput): Promise<AuthSession> {
  const passwordHash = await hashPassword(input.password)

  return withTx(db, () => {
    assertRegistrationAllowed(db, input.inviteCode)

    if (usersRepo.usernameExists(db, input.username)) {
      throw err.conflict('用户名已被占用')
    }

    const row = usersRepo.create(db, {
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      isAdmin: isFirstUser(db),
      deviceId: input.device.id,
    })

    devicesRepo.upsert(db, row.id, input.device)
    ensureUserSettings(db, row.id)
    ensureNotificationSettings(db, row.id)

    const user = usersRepo.mapUser(row)
    const { tokens } = issueTokens(db, signer, user, input.device.id)
    return { user, tokens }
  })
}

export async function login(db: DB, signer: JwtSigner, input: LoginInput): Promise<AuthSession> {
  const row = usersRepo.findByUsername(db, input.username)
  // 用户不存在与密码错误返回同一提示，避免用户名枚举
  if (!row) throw err.unauthenticated('用户名或密码不正确')
  // 影子账号（AI 角色）不能登录，密码散列也不是真实凭据
  if (row.status === 'disabled' || row.is_bot === 1) throw err.forbidden('账号已被禁用')

  const ok = await verifyPassword(row.password_hash, input.password)
  if (!ok) throw err.unauthenticated('用户名或密码不正确')

  return withTx(db, () => {
    devicesRepo.upsert(db, row.id, input.device)
    ensureUserSettings(db, row.id)
    ensureNotificationSettings(db, row.id)
    usersRepo.touchLastSeen(db, row.id)

    const user = usersRepo.mapUser(row)
    const { tokens } = issueTokens(db, signer, user, input.device.id)
    return { user, tokens }
  })
}

export function refresh(
  db: DB,
  signer: JwtSigner,
  refreshToken: string,
  deviceId: string,
): AuthSession {
  const hash = sha256(refreshToken)
  const existing = tokensRepo.findByHash(db, hash)
  if (!existing) throw err.unauthenticated('登录凭证无效')
  if (existing.revoked_at !== null) {
    // 已轮换过的 token 再次出现，视为泄露：整条链作废
    tokensRepo.revokeFamily(db, existing.family_id)
    throw err.unauthenticated('登录凭证已失效，请重新登录')
  }
  if (existing.expires_at > 0 && existing.expires_at < now()) throw err.tokenExpired()

  const row = usersRepo.findById(db, existing.user_id)
  if (!row) throw err.unauthenticated('用户不存在')
  if (row.status === 'disabled') throw err.forbidden('账号已被禁用')

  return withTx(db, () => {
    const user = usersRepo.mapUser(row)
    const { tokens, tokenId } = issueTokens(db, signer, user, deviceId, existing.family_id)
    // 新 token 落库后立刻作废旧 token，保证一条链上同时只有一个有效凭证
    tokensRepo.revoke(db, existing.id, tokenId)
    devicesRepo.touch(db, row.id, deviceId)
    return { user, tokens }
  })
}

export function logout(db: DB, userId: string, refreshToken?: string, allDevices?: boolean): void {
  if (allDevices) {
    tokensRepo.revokeAllForUser(db, userId)
    return
  }
  if (refreshToken) {
    const row = tokensRepo.findByHash(db, sha256(refreshToken))
    if (row && row.user_id === userId) tokensRepo.revoke(db, row.id)
  }
}

export function revokeDevice(db: DB, userId: string, deviceId: string): void {
  tokensRepo.revokeForDevice(db, userId, deviceId)
  devicesRepo.remove(db, userId, deviceId)
}
