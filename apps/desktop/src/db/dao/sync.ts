import { dbExecute, dbSelect } from '../../platform/db'

export async function getCursor(serverId: string): Promise<number> {
  const rows = await dbSelect<{ cursor: number }>('SELECT cursor FROM sync_state WHERE server_id = $1', [serverId])
  return rows[0]?.cursor ?? 0
}

export async function setCursor(serverId: string, cursor: number): Promise<void> {
  await dbExecute(
    `INSERT INTO sync_state (server_id, cursor, last_synced_at, catchup_done)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT(server_id) DO UPDATE SET
       cursor = excluded.cursor,
       last_synced_at = excluded.last_synced_at,
       catchup_done = excluded.catchup_done`,
    [serverId, cursor, Date.now()],
  )
}

export async function resetCursor(serverId: string): Promise<void> {
  await dbExecute('UPDATE sync_state SET cursor = 0, catchup_done = 0 WHERE server_id = $1', [serverId])
}

/* ------------------------------- 发件箱 ------------------------------- */

export interface OutboxRow {
  id: string
  server_id: string
  op: string
  payload: string
  conversation_id: string | null
  attempts: number
  last_error: string | null
  next_attempt_at: number
  created_at: number
}

export async function enqueue(input: {
  id: string
  serverId: string
  op: string
  payload: unknown
  conversationId?: string | null
}): Promise<void> {
  await dbExecute(
    `INSERT INTO outbox (id, server_id, op, payload, conversation_id, attempts, last_error, next_attempt_at, created_at)
     VALUES ($1,$2,$3,$4,$5,0,NULL,$6,$6)`,
    [input.id, input.serverId, input.op, JSON.stringify(input.payload), input.conversationId ?? null, Date.now()],
  )
}

export async function listOutbox(serverId: string, limit = 50): Promise<OutboxRow[]> {
  return dbSelect<OutboxRow>(
    `SELECT * FROM outbox WHERE server_id = $1 AND next_attempt_at <= $2 ORDER BY created_at ASC LIMIT $3`,
    [serverId, Date.now(), limit],
  )
}

export async function removeOutbox(id: string): Promise<void> {
  await dbExecute('DELETE FROM outbox WHERE id = $1', [id])
}

export async function bumpOutboxAttempt(id: string, error: string, delayMs: number): Promise<void> {
  await dbExecute(
    'UPDATE outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3 WHERE id = $1',
    [id, error, Date.now() + delayMs],
  )
}

export async function clearOutbox(serverId: string): Promise<void> {
  await dbExecute('DELETE FROM outbox WHERE server_id = $1', [serverId])
}
