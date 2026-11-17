import type { PublicUser, User } from '@nenochat/shared'
import { dbExecute, dbSelect } from '../../platform/db'

export interface UserRow {
  server_id: string
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  bio: string | null
  last_seen_at: number | null
  updated_at: number
}

export function mapPublicUser(row: UserRow): PublicUser & { lastSeenAt?: number | null } {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    lastSeenAt: row.last_seen_at,
  }
}

export async function upsertUser(serverId: string, user: PublicUser): Promise<void> {
  await dbExecute(
    `INSERT INTO users (server_id, id, username, display_name, avatar_url, bio, last_seen_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(server_id, id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       bio = excluded.bio,
       updated_at = excluded.updated_at`,
    [
      serverId,
      user.id,
      user.username,
      user.displayName,
      user.avatarUrl ?? null,
      user.bio ?? null,
      (user as User & { lastSeenAt?: number | null }).lastSeenAt ?? null,
      Date.now(),
    ],
  )
}

export async function upsertUsers(serverId: string, users: PublicUser[]): Promise<void> {
  for (const user of users) {
    await upsertUser(serverId, user)
  }
}

export async function getUser(serverId: string, userId: string): Promise<PublicUser | null> {
  const rows = await dbSelect<UserRow>('SELECT * FROM users WHERE server_id = $1 AND id = $2', [serverId, userId])
  const row = rows[0]
  return row ? mapPublicUser(row) : null
}

export async function listUsers(serverId: string, ids: string[]): Promise<Map<string, PublicUser>> {
  const map = new Map<string, PublicUser>()
  if (ids.length === 0) return map
  const rows = await dbSelect<UserRow>('SELECT * FROM users WHERE server_id = $1', [serverId])
  for (const row of rows) {
    map.set(row.id, mapPublicUser(row))
  }
  return map
}
