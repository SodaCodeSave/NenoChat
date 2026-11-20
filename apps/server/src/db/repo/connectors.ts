import { ulid } from '@nenochat/shared'
import { all, one, run, type Executor } from '../index'
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

export async function listConnectors(db: Executor, ownerId: string): Promise<ConnectorRow[]> {
  return all<ConnectorRow>(
    db,
    `SELECT * FROM connectors
     WHERE owner_id = ? AND deleted_at IS NULL
     ORDER BY created_at`,
    [ownerId],
  )
}

export async function listEnabledByType(db: Executor, ownerId: string, type: string): Promise<ConnectorRow[]> {
  return all<ConnectorRow>(
    db,
    `SELECT * FROM connectors
     WHERE owner_id = ? AND type = ? AND enabled = 1 AND deleted_at IS NULL
     ORDER BY created_at`,
    [ownerId, type],
  )
}

export async function findConnector(db: Executor, id: string): Promise<ConnectorRow | undefined> {
  return one<ConnectorRow>(db, 'SELECT * FROM connectors WHERE id = ? AND deleted_at IS NULL', [id])
}

export interface CreateConnectorInput {
  ownerId: string
  type: string
  name: string
  enabled: boolean
  config: string
  secretEnc: string | null
}

export async function createConnector(db: Executor, input: CreateConnectorInput): Promise<ConnectorRow> {
  const ts = now()
  const id = ulid()
  const row = await one<ConnectorRow>(
    db,
    `INSERT INTO connectors
       (id, owner_id, type, name, enabled, config, secret_enc,
        last_test_at, last_test_ok, last_test_message, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
     RETURNING *`,
    [
      id,
      input.ownerId,
      input.type,
      input.name,
      input.enabled ? 1 : 0,
      input.config,
      input.secretEnc,
      ts,
      ts,
    ],
  )
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

export async function updateConnector(db: Executor, id: string, patch: UpdateConnectorInput): Promise<ConnectorRow> {
  const current = await findConnector(db, id)
  if (!current) throw new Error('连接器不存在')

  const row = await one<ConnectorRow>(
    db,
    `UPDATE connectors
     SET name = ?, enabled = ?, config = ?, secret_enc = ?, updated_at = ?
     WHERE id = ?
     RETURNING *`,
    [
      patch.name ?? current.name,
      patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
      patch.config ?? current.config,
      patch.secretEnc === undefined ? current.secret_enc : patch.secretEnc,
      now(),
      id,
    ],
  )
  if (!row) throw new Error('更新连接器后回读失败')
  return row
}

export async function softDeleteConnector(db: Executor, id: string): Promise<void> {
  await run(db, 'UPDATE connectors SET deleted_at = ?, updated_at = ? WHERE id = ?', [
    now(),
    now(),
    id,
  ])
}

export async function saveTestResult(
  db: Executor,
  id: string,
  result: { ok: boolean; message: string },
): Promise<void> {
  await run(
    db,
    'UPDATE connectors SET last_test_at = ?, last_test_ok = ?, last_test_message = ? WHERE id = ?',
    [now(), result.ok ? 1 : 0, result.message.slice(0, 200), id],
  )
}
