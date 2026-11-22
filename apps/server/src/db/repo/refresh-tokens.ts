import { run, one, type DB } from '../index'
import { now } from '../../util/clock'
import { ulid } from '@nenochat/shared'

export interface RefreshTokenRow {
  id: string
  user_id: string
  device_id: string
  token_hash: string
  family_id: string
  expires_at: number
  created_at: number
  revoked_at: number | null
  replaced_by: string | null
}

export interface InsertInput {
  userId: string
  deviceId: string
  tokenHash: string
  familyId: string
  expiresAt: number
}

export async function insert(db: DB, input: InsertInput): Promise<string> {
  const id = ulid()
  await run(
    db,
    `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, family_id, expires_at, created_at, revoked_at, replaced_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [id, input.userId, input.deviceId, input.tokenHash, input.familyId, input.expiresAt, now()],
  )
  return id
}

export function findByHash(db: DB, tokenHash: string): Promise<RefreshTokenRow | undefined> {
  return one<RefreshTokenRow>(db, 'SELECT * FROM refresh_tokens WHERE token_hash = ?', [tokenHash])
}

export async function revoke(db: DB, id: string, replacedBy?: string | null): Promise<void> {
  await run(db, 'UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL', [
    now(),
    replacedBy ?? null,
    id,
  ])
}

/** 撤销整条轮换链：检测到 token 重放时使用 */
export async function revokeFamily(db: DB, familyId: string): Promise<void> {
  await run(db, 'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', [
    now(),
    familyId,
  ])
}

export async function revokeAllForUser(db: DB, userId: string): Promise<void> {
  await run(db, 'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
    now(),
    userId,
  ])
}

/** 改密后吊销用户全部会话但保留改密发起端：其他设备凭旧密码建立的登录态即刻失效 */
export async function revokeAllForUserExceptDevice(db: DB, userId: string, deviceId: string): Promise<void> {
  await run(
    db,
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id <> ? AND revoked_at IS NULL',
    [now(), userId, deviceId],
  )
}

export async function revokeForDevice(db: DB, userId: string, deviceId: string): Promise<void> {
  await run(db, 'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL', [
    now(),
    userId,
    deviceId,
  ])
}

export async function deleteExpired(db: DB): Promise<number> {
  // expires_at = 0 是「永不过期」的哨兵值，不能被清理掉
  const result = await run(db, 'DELETE FROM refresh_tokens WHERE expires_at > 0 AND expires_at < ?', [now()])
  return result.changes
}
