import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface ConnectorRow {
  id: string
  owner_id: string
  type: string
  name: string
  enabled: number
  config: string
  secret_enc: string | null
  last_test_at: number | null
  last_test_ok: number | null
  last_test_message: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export function listConnectors(db: DB, ownerId: string): ConnectorRow[] {
  return db
    .prepare(
      `SELECT * FROM connectors
       WHERE owner_id = ? AND deleted_at IS NULL
       ORDER BY created_at`,
    )
    .all(ownerId) as ConnectorRow[]
}

export function listEnabledByType(db: DB, ownerId: string, type: string): ConnectorRow[] {
  return db
    .prepare(
      `SELECT * FROM connectors
       WHERE owner_id = ? AND type = ? AND enabled = 1 AND deleted_at IS NULL
       ORDER BY created_at`,
    )
    .all(ownerId, type) as ConnectorRow[]
}

export function findConnector(db: DB, id: string): ConnectorRow | undefined {
  return db
    .prepare('SELECT * FROM connectors WHERE id = ? AND deleted_at IS NULL')
    .get(id) as ConnectorRow | undefined
}

export interface CreateConnectorInput {
  ownerId: string
  type: string
  name: string
  enabled: boolean
  config: string
  secretEnc: string | null
}

export function createConnector(db: DB, input: CreateConnectorInput): ConnectorRow {
  const ts = now()
  const id = ulid()
  db.prepare(
    `INSERT INTO connectors
       (id, owner_id, type, name, enabled, config, secret_enc,
        last_test_at, last_test_ok, last_test_message, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    id,
    input.ownerId,
    input.type,
    input.name,
    input.enabled ? 1 : 0,
    input.config,
    input.secretEnc,
    ts,
    ts,
  )
  const row = findConnector(db, id)
  if (!row) throw new Error('创建连接器后回读失败')
  return row
}

export interface UpdateConnectorInput {
  name?: string
  enabled?: boolean
  config?: string
  /** undefined 表示不改；null 表示清空 */
  secretEnc?: string | null
}

export function updateConnector(db: DB, id: string, patch: UpdateConnectorInput): ConnectorRow {
  const current = findConnector(db, id)
  if (!current) throw new Error('连接器不存在')

  db.prepare(
    `UPDATE connectors
     SET name = ?, enabled = ?, config = ?, secret_enc = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
    patch.config ?? current.config,
    patch.secretEnc === undefined ? current.secret_enc : patch.secretEnc,
    now(),
    id,
  )
  const row = findConnector(db, id)
  if (!row) throw new Error('更新连接器后回读失败')
  return row
}

export function softDeleteConnector(db: DB, id: string): void {
  db.prepare('UPDATE connectors SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
    now(),
    now(),
    id,
  )
}

export function saveTestResult(
  db: DB,
  id: string,
  result: { ok: boolean; message: string },
): void {
  db.prepare(
    'UPDATE connectors SET last_test_at = ?, last_test_ok = ?, last_test_message = ? WHERE id = ?',
  ).run(now(), result.ok ? 1 : 0, result.message.slice(0, 200), id)
}
