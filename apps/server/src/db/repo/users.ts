import type { PublicUser, User } from '@nenochat/shared'
import type { DB } from '../index'
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

export function findById(db: DB, id: string): UserRow | undefined {
  return db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id) as UserRow | undefined
}

export function findByUsername(db: DB, username: string): UserRow | undefined {
  return db
    .prepare('SELECT * FROM users WHERE lower(username) = lower(?)')
    .get(username) as UserRow | undefined
}

export function usernameExists(db: DB, username: string): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM users WHERE lower(username) = lower(?)')
    .get(username) as { hit: number } | undefined
  return row !== undefined
}

export interface CreateUserInput {
  username: string
  displayName: string
  passwordHash: string
  isAdmin?: boolean
  deviceId?: string | null
}

export function create(db: DB, input: CreateUserInput): UserRow {
  const ts = now()
  const id = ulid()
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_url, bio, status,
                        is_admin, last_seen_at, created_at, updated_at, updated_by_device)
     VALUES (?, ?, ?, ?, NULL, NULL, 'active', ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.username,
    input.displayName,
    input.passwordHash,
    input.isAdmin ? 1 : 0,
    ts,
    ts,
    input.deviceId ?? null,
  )
  const row = findById(db, id)
  if (!row) throw new Error('创建用户后回读失败')
  return row
}

export interface UpdateProfileInput {
  displayName?: string
  avatarUrl?: string | null
  bio?: string | null
}

export function updateProfile(db: DB, id: string, patch: UpdateProfileInput, deviceId?: string): UserRow {
  const current = findById(db, id)
  if (!current) throw new Error('用户不存在')

  db.prepare(
    `UPDATE users SET display_name = ?, avatar_url = ?, bio = ?, updated_at = ?, updated_by_device = ?
     WHERE id = ?`,
  ).run(
    patch.displayName ?? current.display_name,
    patch.avatarUrl === undefined ? current.avatar_url : patch.avatarUrl,
    patch.bio === undefined ? current.bio : patch.bio,
    now(),
    deviceId ?? null,
    id,
  )
  const row = findById(db, id)
  if (!row) throw new Error('更新用户后回读失败')
  return row
}

export function setPasswordHash(db: DB, id: string, hash: string): void {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), id)
}

/* ------------------------------ 影子账号 ------------------------------ */

/** 角色进群、加好友都靠这个账号；id 与 persona 一一对应（bot- + personaId） */
export function createBot(
  db: DB,
  input: { id: string; displayName: string; avatarUrl?: string | null },
): UserRow {
  const ts = now()
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_url, bio, status,
                        is_admin, last_seen_at, created_at, updated_at, updated_by_device, is_bot)
     VALUES (?, ?, ?, '!', ?, NULL, 'active', 0, NULL, ?, ?, NULL, 1)`,
  ).run(input.id, `ai_${input.id}`, input.displayName, input.avatarUrl ?? null, ts, ts)
  const row = findById(db, input.id)
  if (!row) throw new Error('创建角色账号后回读失败')
  return row
}

/** 角色改名/换头像时同步影子账号，群成员列表才不会显示旧资料 */
export function updateBotProfile(
  db: DB,
  id: string,
  patch: { displayName?: string; avatarUrl?: string | null },
): void {
  const current = findById(db, id)
  if (!current) return
  db.prepare('UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?').run(
    patch.displayName ?? current.display_name,
    patch.avatarUrl === undefined ? current.avatar_url : patch.avatarUrl,
    now(),
    id,
  )
}

export function disableBot(db: DB, id: string): void {
  db.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ? AND is_bot = 1").run(now(), id)
}

export function touchLastSeen(db: DB, id: string): void {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), id)
}

/** 按用户名或昵称模糊搜索，排除自己；影子账号不在公开搜索里出现 */
export function search(db: DB, keyword: string, excludeUserId: string, limit = 20): UserRow[] {
  const like = `%${keyword.replace(/[%_]/g, '')}%`
  return db
    .prepare(
      `SELECT * FROM users
       WHERE (username LIKE ? OR display_name LIKE ?) AND id <> ? AND is_bot = 0
       ORDER BY username LIMIT ?`,
    )
    .all(like, like, excludeUserId, limit) as UserRow[]
}

export function listByIds(db: DB, ids: string[]): UserRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db
    .prepare(`SELECT * FROM users WHERE id IN (${placeholders})`)
    .all(...ids) as UserRow[]
}
