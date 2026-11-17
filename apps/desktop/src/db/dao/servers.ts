import type { ServerInstance } from '@nenochat/shared'
import { dbExecute, dbSelect } from '../../platform/db'

export interface ServerRow {
  id: string
  name: string
  base_url: string
  ws_url: string
  server_name: string | null
  icon_url: string | null
  registration_mode: string | null
  last_user_id: string | null
  last_connected_at: number | null
  added_at: number
}

export function mapServer(row: ServerRow): ServerInstance {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    wsUrl: row.ws_url,
    serverName: row.server_name,
    iconUrl: row.icon_url,
    lastUserId: row.last_user_id,
    lastConnectedAt: row.last_connected_at,
    addedAt: row.added_at,
  }
}

export async function listServers(): Promise<ServerInstance[]> {
  const rows = await dbSelect<ServerRow>('SELECT * FROM server_instances ORDER BY added_at ASC')
  return rows.map(mapServer)
}

export async function upsertServer(server: ServerInstance, registrationMode?: string | null): Promise<void> {
  await dbExecute(
    `INSERT INTO server_instances
       (id, name, base_url, ws_url, server_name, icon_url, registration_mode, last_user_id, last_connected_at, added_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       base_url = excluded.base_url,
       ws_url = excluded.ws_url,
       server_name = excluded.server_name,
       icon_url = excluded.icon_url,
       registration_mode = COALESCE(excluded.registration_mode, server_instances.registration_mode),
       last_user_id = COALESCE(excluded.last_user_id, server_instances.last_user_id),
       last_connected_at = excluded.last_connected_at`,
    [
      server.id,
      server.name,
      server.baseUrl,
      server.wsUrl,
      server.serverName ?? null,
      server.iconUrl ?? null,
      registrationMode ?? null,
      server.lastUserId ?? null,
      server.lastConnectedAt ?? null,
      server.addedAt,
    ],
  )
}

export async function touchServer(serverId: string, patch: { name?: string; serverName?: string; lastUserId?: string }): Promise<void> {
  await dbExecute(
    `UPDATE server_instances
     SET name = COALESCE($2, name),
         server_name = COALESCE($3, server_name),
         last_user_id = COALESCE($4, last_user_id),
         last_connected_at = $5
     WHERE id = $1`,
    [serverId, patch.name ?? null, patch.serverName ?? null, patch.lastUserId ?? null, Date.now()],
  )
}

/** 删除服务器时连带清理该服务器的全部本地镜像数据 */
export async function removeServerCascade(serverId: string): Promise<void> {
  const tables = [
    'users',
    'conversations',
    'members',
    'channels',
    'messages',
    'read_cursors',
    'contacts',
    'posts',
    'post_comments',
    'sticker_packs',
    'stickers',
    'ai_providers',
    'ai_personas',
    'ai_memory_summaries',
    'ai_memory_facts',
    'notifications',
    'app_settings',
    'outbox',
    'sync_state',
    'drafts',
  ]
  for (const table of tables) {
    await dbExecute(`DELETE FROM ${table} WHERE server_id = $1`, [serverId])
  }
  await dbExecute('DELETE FROM message_fts WHERE server_id = $1', [serverId])
  await dbExecute('DELETE FROM server_instances WHERE id = $1', [serverId])
}
