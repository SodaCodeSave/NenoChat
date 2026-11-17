import type { DB } from '../index'
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

export function insert(db: DB, input: InsertInput): string {
  const id = ulid()
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, family_id, expires_at, created_at, revoked_at, replaced_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(id, input.userId, input.deviceId, input.tokenHash, input.familyId, input.expiresAt, now())
  return id
}

export function findByHash(db: DB, tokenHash: string): RefreshTokenRow | undefined {
  return db
    .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .get(tokenHash) as RefreshTokenRow | undefined
}

export function revoke(db: DB, id: string, replacedBy?: string | null): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL').run(
    now(),
    replacedBy ?? null,
    id,
  )
}

/** 撤销整条轮换链：检测到 token 重放时使用 */
export function revokeFamily(db: DB, familyId: string): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(
    now(),
    familyId,
  )
}

export function revokeAllForUser(db: DB, userId: string): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
    now(),
    userId,
  )
}

export function revokeForDevice(db: DB, userId: string, deviceId: string): void {
  db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL',
  ).run(now(), userId, deviceId)
}

export function deleteExpired(db: DB): number {
  // expires_at = 0 是「永不过期」的哨兵值，不能被清理掉
  const result = db.prepare('DELETE FROM refresh_tokens WHERE expires_at > 0 AND expires_at < ?').run(now())
  return result.changes
}
