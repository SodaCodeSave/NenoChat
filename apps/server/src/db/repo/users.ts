import type { PublicUser, User } from '@nenochat/shared'
import { all, one, run, type DB } from '../index'
import { now } from '../../util/clock'
import { ulid } from '@nenochat/shared'

export interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  avatar_url: string | null
  bio: string | null
  status: string
  is_admin: number
  last_seen_at: number | null
  created_at: number
  updated_at: number
  updated_by_device: string | null
  /** 影子账号：AI 角色在 users 表里的身份，不能登录、不出现在用户搜索里 */
  is_bot: number
}

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    isAdmin: row.is_admin === 1,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
  }
}

export function findById(db: DB, id: string): Promise<UserRow | undefined> {
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [id])
}

export function findByUsername(db: DB, username: string): Promise<UserRow | undefined> {
  return one<UserRow>(db, 'SELECT * FROM users WHERE lower(username) = lower(?)', [username])
}

export async function usernameExists(db: DB, username: string): Promise<boolean> {
  const row = await one<{ hit: number }>(db, 'SELECT 1 AS hit FROM users WHERE lower(username) = lower(?)', [
    username,
  ])
  return row !== undefined
}

export interface CreateUserInput {
  username: string
  displayName: string
  passwordHash: string
  isAdmin?: boolean
  deviceId?: string | null
}

export async function create(db: DB, input: CreateUserInput): Promise<UserRow> {
  const ts = now()
  const id = ulid()
  const row = await one<UserRow>(
    db,
    `INSERT INTO users (id, username, display_name, password_hash, avatar_url, bio, status,
                        is_admin, last_seen_at, created_at, updated_at, updated_by_device)
     VALUES (?, ?, ?, ?, NULL, NULL, 'active', ?, NULL, ?, ?, ?)
     RETURNING *`,
    [
      id,
      input.username,
      input.displayName,
      input.passwordHash,
      input.isAdmin ? 1 : 0,
      ts,
      ts,
      input.deviceId ?? null,
    ],
  )
  if (!row) throw new Error('创建用户后回读失败')
  return row
}

export interface UpdateProfileInput {
  displayName?: string
  avatarUrl?: string | null
  bio?: string | null
}

export async function updateProfile(db: DB, id: string, patch: UpdateProfileInput, deviceId?: string): Promise<UserRow> {
  const current = await findById(db, id)
  if (!current) throw new Error('用户不存在')

  const row = await one<UserRow>(
    db,
    `UPDATE users SET display_name = ?, avatar_url = ?, bio = ?, updated_at = ?, updated_by_device = ?
     WHERE id = ?
     RETURNING *`,
    [
      patch.displayName ?? current.display_name,
      patch.avatarUrl === undefined ? current.avatar_url : patch.avatarUrl,
      patch.bio === undefined ? current.bio : patch.bio,
      now(),
      deviceId ?? null,
      id,
    ],
  )
  if (!row) throw new Error('更新用户后回读失败')
  return row
}

export async function setPasswordHash(db: DB, id: string, hash: string): Promise<void> {
  await run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, now(), id])
}

/* ------------------------------ 影子账号 ------------------------------ */

/** 角色进群、加好友都靠这个账号；id 与 persona 一一对应（bot- + personaId） */
export async function createBot(
  db: DB,
  input: { id: string; displayName: string; avatarUrl?: string | null },
): Promise<UserRow> {
  const ts = now()
  const row = await one<UserRow>(
    db,
    `INSERT INTO users (id, username, display_name, password_hash, avatar_url, bio, status,
                        is_admin, last_seen_at, created_at, updated_at, updated_by_device, is_bot)
     VALUES (?, ?, ?, '!', ?, NULL, 'active', 0, NULL, ?, ?, NULL, 1)
     RETURNING *`,
    [input.id, `ai_${input.id}`, input.displayName, input.avatarUrl ?? null, ts, ts],
  )
  if (!row) throw new Error('创建角色账号后回读失败')
  return row
}

/** 角色改名/换头像时同步影子账号，群成员列表才不会显示旧资料 */
export async function updateBotProfile(
  db: DB,
  id: string,
  patch: { displayName?: string; avatarUrl?: string | null },
): Promise<void> {
  const current = await findById(db, id)
  if (!current) return
  await run(db, 'UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?', [
    patch.displayName ?? current.display_name,
    patch.avatarUrl === undefined ? current.avatar_url : patch.avatarUrl,
    now(),
    id,
  ])
}

export async function disableBot(db: DB, id: string): Promise<void> {
  await run(db, "UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ? AND is_bot = 1", [now(), id])
}

export async function touchLastSeen(db: DB, id: string): Promise<void> {
  await run(db, 'UPDATE users SET last_seen_at = ? WHERE id = ?', [now(), id])
}

/** 按用户名或昵称模糊搜索，排除自己；影子账号不在公开搜索里出现 */
export function search(db: DB, keyword: string, excludeUserId: string, limit = 20): Promise<UserRow[]> {
  const like = `%${keyword.replace(/[%_]/g, '')}%`
  return all<UserRow>(
    db,
    `SELECT * FROM users
     WHERE (username ILIKE ? OR display_name ILIKE ?) AND id <> ? AND is_bot = 0
     ORDER BY username LIMIT ?`,
    [like, like, excludeUserId, limit],
  )
}

export function listByIds(db: DB, ids: string[]): Promise<UserRow[]> {
  if (ids.length === 0) return Promise.resolve([])
  const placeholders = ids.map(() => '?').join(',')
  return all<UserRow>(db, `SELECT * FROM users WHERE id IN (${placeholders})`, ids)
}
