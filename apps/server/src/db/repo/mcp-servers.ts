import { ulid } from '@nenochat/shared'
import { all, one, run, type Executor } from '../index'
import { now } from '../../util/clock'

export interface McpServerRow {
  id: string
  owner_id: string
  name: string
  url: string
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

export async function listMcpServers(db: Executor, ownerId: string): Promise<McpServerRow[]> {
  return all<McpServerRow>(
    db,
    `SELECT * FROM mcp_servers
     WHERE owner_id = ? AND deleted_at IS NULL
     ORDER BY created_at`,
    [ownerId],
  )
}

export async function listEnabledMcpServers(db: Executor, ownerId: string): Promise<McpServerRow[]> {
  return all<McpServerRow>(
    db,
    `SELECT * FROM mcp_servers
     WHERE owner_id = ? AND enabled = 1 AND deleted_at IS NULL
     ORDER BY created_at`,
    [ownerId],
  )
}

export async function findMcpServer(db: Executor, id: string): Promise<McpServerRow | undefined> {
  return one<McpServerRow>(db, 'SELECT * FROM mcp_servers WHERE id = ? AND deleted_at IS NULL', [id])
}

export interface CreateMcpServerInput {
  ownerId: string
  name: string
  url: string
  enabled: boolean
  config: string
  secretEnc: string | null
}

export async function createMcpServer(db: Executor, input: CreateMcpServerInput): Promise<McpServerRow> {
  const ts = now()
  const id = ulid()
  const row = await one<McpServerRow>(
    db,
    `INSERT INTO mcp_servers
       (id, owner_id, name, url, enabled, config, secret_enc,
        last_test_at, last_test_ok, last_test_message, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
     RETURNING *`,
    [id, input.ownerId, input.name, input.url, input.enabled ? 1 : 0, input.config, input.secretEnc, ts, ts],
  )
  if (!row) throw new Error('创建 MCP 服务器后回读失败')
  return row
}

export interface UpdateMcpServerInput {
  name?: string
  url?: string
  enabled?: boolean
  config?: string
  /** undefined 表示不改；null 表示清空 */
  secretEnc?: string | null
}

export async function updateMcpServer(
  db: Executor,
  id: string,
  patch: UpdateMcpServerInput,
): Promise<McpServerRow> {
  const current = await findMcpServer(db, id)
  if (!current) throw new Error('MCP 服务器不存在')

  const row = await one<McpServerRow>(
    db,
    `UPDATE mcp_servers
     SET name = ?, url = ?, enabled = ?, config = ?, secret_enc = ?, updated_at = ?
     WHERE id = ?
     RETURNING *`,
    [
      patch.name ?? current.name,
      patch.url ?? current.url,
      patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
      patch.config ?? current.config,
      patch.secretEnc === undefined ? current.secret_enc : patch.secretEnc,
      now(),
      id,
    ],
  )
  if (!row) throw new Error('更新 MCP 服务器后回读失败')
  return row
}

export async function softDeleteMcpServer(db: Executor, id: string): Promise<void> {
  await run(db, 'UPDATE mcp_servers SET deleted_at = ?, updated_at = ? WHERE id = ?', [now(), now(), id])
}

export async function saveMcpServerTestResult(
  db: Executor,
  id: string,
  result: { ok: boolean; message: string },
): Promise<void> {
  await run(
    db,
    'UPDATE mcp_servers SET last_test_at = ?, last_test_ok = ?, last_test_message = ? WHERE id = ?',
    [now(), result.ok ? 1 : 0, result.message.slice(0, 200), id],
  )
}
