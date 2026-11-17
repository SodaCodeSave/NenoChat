import type { ContactRelation } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface ContactRow {
  owner_id: string
  contact_user_id: string
  alias: string | null
  relation: string
  request_message: string | null
  created_at: number
  updated_at: number
}

export function find(db: DB, ownerId: string, contactUserId: string): ContactRow | undefined {
  return db
    .prepare('SELECT * FROM contacts WHERE owner_id = ? AND contact_user_id = ?')
    .get(ownerId, contactUserId) as ContactRow | undefined
}

export function list(db: DB, ownerId: string): ContactRow[] {
  return db
    .prepare('SELECT * FROM contacts WHERE owner_id = ? ORDER BY created_at DESC')
    .all(ownerId) as ContactRow[]
}

export function listByRelation(db: DB, ownerId: string, relation: ContactRelation): ContactRow[] {
  return db
    .prepare('SELECT * FROM contacts WHERE owner_id = ? AND relation = ? ORDER BY created_at DESC')
    .all(ownerId, relation) as ContactRow[]
}

export interface UpsertContactInput {
  ownerId: string
  contactUserId: string
  relation: ContactRelation
  alias?: string | null
  requestMessage?: string | null
}

export function upsert(db: DB, input: UpsertContactInput): ContactRow {
  const ts = now()
  db.prepare(
    `INSERT INTO contacts
       (owner_id, contact_user_id, alias, relation, request_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, contact_user_id) DO UPDATE SET
       alias = excluded.alias,
       relation = excluded.relation,
       request_message = excluded.request_message,
       updated_at = excluded.updated_at`,
  ).run(
    input.ownerId,
    input.contactUserId,
    input.alias ?? null,
    input.relation,
    input.requestMessage ?? null,
    ts,
    ts,
  )
  const row = find(db, input.ownerId, input.contactUserId)
  if (!row) throw new Error('写入联系人后回读失败')
  return row
}

export function remove(db: DB, ownerId: string, contactUserId: string): void {
  db.prepare('DELETE FROM contacts WHERE owner_id = ? AND contact_user_id = ?').run(ownerId, contactUserId)
}

/** 好友关系是双向的，删除/拒绝时两边一起清 */
export function removePair(db: DB, a: string, b: string): void {
  db.prepare(
    `DELETE FROM contacts
     WHERE (owner_id = ? AND contact_user_id = ?) OR (owner_id = ? AND contact_user_id = ?)`,
  ).run(a, b, b, a)
}
