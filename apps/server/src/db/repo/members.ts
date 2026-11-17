import type { Member, NotificationLevel, Role } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface MemberRow {
  conversation_id: string
  user_id: string
  role: string
  nickname: string | null
  allow: number
  deny: number
  mute_until: number | null
  pinned_at: number | null
  notification_level: string | null
  joined_at: number
  invited_by: string | null
  left_at: number | null
  updated_at: number
}

export function mapMember(row: MemberRow): Member {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role as Role,
    nickname: row.nickname,
    allow: row.allow,
    deny: row.deny,
    muteUntil: row.mute_until,
    pinnedAt: row.pinned_at,
    notificationLevel: (row.notification_level as NotificationLevel | null) ?? null,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    updatedAt: row.updated_at,
  }
}

export function find(db: DB, conversationId: string, userId: string): MemberRow | undefined {
  return db
    .prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId) as MemberRow | undefined
}

/** 只返回仍在群内的成员记录 */
export function findActive(db: DB, conversationId: string, userId: string): MemberRow | undefined {
  const row = find(db, conversationId, userId)
  return row && row.left_at === null ? row : undefined
}

export function listActive(db: DB, conversationId: string): MemberRow[] {
  return db
    .prepare(
      `SELECT * FROM conversation_members
       WHERE conversation_id = ? AND left_at IS NULL
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at`,
    )
    .all(conversationId) as MemberRow[]
}

export function countActive(db: DB, conversationId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL')
    .get(conversationId) as { c: number }
  return row.c
}

export interface UpsertMemberInput {
  conversationId: string
  userId: string
  role?: Role
  nickname?: string | null
  invitedBy?: string | null
}

/** 加群与重新入群共用：已有记录时把 left_at 清空 */
export function upsert(db: DB, input: UpsertMemberInput): MemberRow {
  const ts = now()
  db.prepare(
    `INSERT INTO conversation_members
       (conversation_id, user_id, role, nickname, allow, deny, mute_until, pinned_at,
        notification_level, joined_at, invited_by, left_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, NULL, NULL, NULL, ?, ?, NULL, ?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET
       role = excluded.role,
       nickname = COALESCE(excluded.nickname, conversation_members.nickname),
       left_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(
    input.conversationId,
    input.userId,
    input.role ?? 'member',
    input.nickname ?? null,
    ts,
    input.invitedBy ?? null,
    ts,
  )
  const row = find(db, input.conversationId, input.userId)
  if (!row) throw new Error('写入成员后回读失败')
  return row
}

export interface UpdateMemberInput {
  role?: Role
  nickname?: string | null
  allow?: number
  deny?: number
  muteUntil?: number | null
  pinnedAt?: number | null
  notificationLevel?: NotificationLevel | null
}

export function update(db: DB, conversationId: string, userId: string, patch: UpdateMemberInput): MemberRow {
  const current = find(db, conversationId, userId)
  if (!current) throw new Error('成员不存在')

  db.prepare(
    `UPDATE conversation_members
     SET role = ?, nickname = ?, allow = ?, deny = ?, mute_until = ?, pinned_at = ?,
         notification_level = ?, updated_at = ?
     WHERE conversation_id = ? AND user_id = ?`,
  ).run(
    patch.role ?? current.role,
    patch.nickname === undefined ? current.nickname : patch.nickname,
    patch.allow ?? current.allow,
    patch.deny ?? current.deny,
    patch.muteUntil === undefined ? current.mute_until : patch.muteUntil,
    patch.pinnedAt === undefined ? current.pinned_at : patch.pinnedAt,
    patch.notificationLevel === undefined ? current.notification_level : patch.notificationLevel,
    now(),
    conversationId,
    userId,
  )
  const row = find(db, conversationId, userId)
  if (!row) throw new Error('更新成员后回读失败')
  return row
}

/** 退群/被踢：软删除，保留历史消息的归属，便于补拉与审计 */
export function markLeft(db: DB, conversationId: string, userId: string): void {
  const ts = now()
  db.prepare(
    `UPDATE conversation_members SET left_at = ?, updated_at = ?
     WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
  ).run(ts, ts, conversationId, userId)
}

export function isMember(db: DB, conversationId: string, userId: string): boolean {
  return findActive(db, conversationId, userId) !== undefined
}
