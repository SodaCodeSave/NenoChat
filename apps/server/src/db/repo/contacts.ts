import type { ContactRelation } from '@nenochat/shared'
import { all, one, run, type Executor } from '../index'
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

export async function find(db: Executor, ownerId: string, contactUserId: string): Promise<ContactRow | undefined> {
  return one<ContactRow>(db, 'SELECT * FROM contacts WHERE owner_id = ? AND contact_user_id = ?', [
    ownerId,
    contactUserId,
  ])
}

export async function list(db: Executor, ownerId: string): Promise<ContactRow[]> {
  return all<ContactRow>(db, 'SELECT * FROM contacts WHERE owner_id = ? ORDER BY created_at DESC', [
    ownerId,
  ])
}

export async function listByRelation(db: Executor, ownerId: string, relation: ContactRelation): Promise<ContactRow[]> {
  return all<ContactRow>(
    db,
    'SELECT * FROM contacts WHERE owner_id = ? AND relation = ? ORDER BY created_at DESC',
    [ownerId, relation],
  )
}

export interface UpsertContactInput {
  ownerId: string
  contactUserId: string
  relation: ContactRelation
  alias?: string | null
  requestMessage?: string | null
}

export async function upsert(db: Executor, input: UpsertContactInput): Promise<ContactRow> {
  const ts = now()
  const row = await one<ContactRow>(
    db,
    `INSERT INTO contacts
       (owner_id, contact_user_id, alias, relation, request_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, contact_user_id) DO UPDATE SET
       alias = excluded.alias,
       relation = excluded.relation,
       request_message = excluded.request_message,
       updated_at = excluded.updated_at
     RETURNING *`,
    [
      input.ownerId,
      input.contactUserId,
      input.alias ?? null,
      input.relation,
      input.requestMessage ?? null,
      ts,
      ts,
    ],
  )
  if (!row) throw new Error('写入联系人后回读失败')
  return row
}

export async function remove(db: Executor, ownerId: string, contactUserId: string): Promise<void> {
  await run(db, 'DELETE FROM contacts WHERE owner_id = ? AND contact_user_id = ?', [ownerId, contactUserId])
}

/** 好友关系是双向的，删除/拒绝时两边一起清 */
export async function removePair(db: Executor, a: string, b: string): Promise<void> {
  await run(
    db,
    `DELETE FROM contacts
     WHERE (owner_id = ? AND contact_user_id = ?) OR (owner_id = ? AND contact_user_id = ?)`,
    [a, b, b, a],
  )
}
