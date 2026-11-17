import type { Channel, ChannelKind } from '@nenochat/shared'
import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface ChannelRow {
  id: string
  conversation_id: string
  name: string
  topic: string | null
  kind: string
  category: string | null
  position: number
  archived_at: number | null
  created_by: string | null
  created_at: number
  updated_at: number
}

export function mapChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    name: row.name,
    topic: row.topic,
    kind: row.kind as ChannelKind,
    category: row.category,
    position: row.position,
    archivedAt: row.archived_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listByConversation(db: DB, conversationId: string): ChannelRow[] {
  return db
    .prepare(
      `SELECT * FROM channels
       WHERE conversation_id = ? AND archived_at IS NULL
       ORDER BY COALESCE(category, ''), position, created_at`,
    )
    .all(conversationId) as ChannelRow[]
}

export function findById(db: DB, id: string): ChannelRow | undefined {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined
}

export interface CreateChannelInput {
  conversationId: string
  name: string
  topic?: string | null
  kind?: ChannelKind
  category?: string | null
  createdBy?: string | null
}

export function create(db: DB, input: CreateChannelInput): ChannelRow {
  const ts = now()
  const id = ulid()
  const maxPos = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE conversation_id = ?')
    .get(input.conversationId) as { p: number }

  db.prepare(
    `INSERT INTO channels
       (id, conversation_id, name, topic, kind, category, position, archived_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.name,
    input.topic ?? null,
    input.kind ?? 'text',
    input.category ?? null,
    maxPos.p + 1,
    input.createdBy ?? null,
    ts,
    ts,
  )
  const row = findById(db, id)
  if (!row) throw new Error('创建频道后回读失败')
  return row
}

export interface UpdateChannelInput {
  name?: string
  topic?: string | null
  category?: string | null
  position?: number
}

export function update(db: DB, id: string, patch: UpdateChannelInput): ChannelRow {
  const current = findById(db, id)
  if (!current) throw new Error('频道不存在')

  db.prepare(
    'UPDATE channels SET name = ?, topic = ?, category = ?, position = ?, updated_at = ? WHERE id = ?',
  ).run(
    patch.name ?? current.name,
    patch.topic === undefined ? current.topic : patch.topic,
    patch.category === undefined ? current.category : patch.category,
    patch.position ?? current.position,
    now(),
    id,
  )
  const row = findById(db, id)
  if (!row) throw new Error('更新频道后回读失败')
  return row
}

export function archive(db: DB, id: string): void {
  const ts = now()
  db.prepare('UPDATE channels SET archived_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id)
}

export function countActiveTextChannels(db: DB, conversationId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM channels
       WHERE conversation_id = ? AND archived_at IS NULL AND kind = 'text'`,
    )
    .get(conversationId) as { c: number }
  return row.c
}

export interface ReorderItem {
  id: string
  category: string | null
  position: number
}

export function reorder(db: DB, items: ReorderItem[]): void {
  const stmt = db.prepare('UPDATE channels SET category = ?, position = ?, updated_at = ? WHERE id = ?')
  const ts = now()
  for (const item of items) {
    stmt.run(item.category, item.position, ts, item.id)
  }
}
