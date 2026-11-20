import type { ServerEventName, WsFrame } from '@nenochat/shared'
import { SYNC_BATCH_SIZE, WS_AUTH_TIMEOUT_MS, WS_HEARTBEAT_MS } from '@nenochat/shared'
import type { DB } from '../db'
import { all } from '../db'
import * as membersRepo from '../db/repo/members'
import * as usersRepo from '../db/repo/users'
import { setHub, type RealtimeHub } from './hub'
import { listChanges } from '../services/sync-service'

export type ConnState = 'unauth' | 'catchingUp' | 'live'

/** catchUp 期间 pending 缓冲上限：超出后丢弃最旧事件，客户端靠 seq 游标走 sync.pull 兜底补拉 */
export const WS_PENDING_LIMIT = 5000

export interface Conn {
  id: string
  socket: import('ws').WebSocket
  userId: string | null
  deviceId: string | null
  state: ConnState
  cursor: number
  /** catchUp 期间产生的实时事件，追平后按 seq 排序补发 */
  pending: Array<{ event: ServerEventName; payload: unknown; seq?: number }>
  /** 按需订阅会话的高频事件（typing/presence） */
  subscriptions: Set<string>
  alive: boolean
  lastPongAt: number
}

export function sendEvent(
  conn: Conn,
  event: ServerEventName,
  payload: unknown,
  seq?: number,
): void {
  if (conn.socket.readyState !== 1) return
  const frame: WsFrame = { t: 'evt', e: event, d: payload, ...(seq !== undefined ? { seq } : {}) }
  conn.socket.send(JSON.stringify(frame))
}

export function sendResponse(conn: Conn, id: string, ok: boolean, data: unknown, error?: unknown): void {
  if (conn.socket.readyState !== 1) return
  const frame: WsFrame = ok
    ? { t: 'res', id, ok: true, d: data }
    : { t: 'res', id, ok: false, err: (error as { code: string; message: string }) ?? { code: 'INTERNAL', message: '未知错误' } }
  conn.socket.send(JSON.stringify(frame))
}

/** 实时广播实现：按用户索引连接，通往下发不做扇出扫描 */
class RealtimeHubImpl implements RealtimeHub {
  private connections = new Map<string, Set<Conn>>()

  constructor(private readonly db: DB) {}

  add(conn: Conn): void {
    if (!conn.userId) return
    let set = this.connections.get(conn.userId)
    if (!set) {
      set = new Set()
      this.connections.set(conn.userId, set)
    }
    set.add(conn)
  }

  remove(conn: Conn): void {
    if (!conn.userId) return
    const set = this.connections.get(conn.userId)
    if (!set) return
    set.delete(conn)
    if (set.size === 0) this.connections.delete(conn.userId)
  }

  private deliver(conn: Conn, event: ServerEventName, payload: unknown, seq?: number): void {
    if (conn.state === 'catchingUp') {
      // 背压上限：追平期间实时事件可能持续涌入，超出即丢最旧的，防止 pending 无限增长
      if (conn.pending.length >= WS_PENDING_LIMIT) {
        conn.pending.splice(0, conn.pending.length - WS_PENDING_LIMIT + 1)
      }
      conn.pending.push({ event, payload, seq })
      return
    }
    sendEvent(conn, event, payload, seq)
  }

  sendToUser(userId: string, event: ServerEventName, payload: unknown, seq?: number): void {
    const set = this.connections.get(userId)
    if (!set) return
    for (const conn of set) this.deliver(conn, event, payload, seq)
  }

  sendToUsers(userIds: string[], event: ServerEventName, payload: unknown, seq?: number): void {
    const seen = new Set<string>()
    for (const userId of userIds) {
      if (seen.has(userId)) continue
      seen.add(userId)
      this.sendToUser(userId, event, payload, seq)
    }
  }

  async sendToConversation(
    conversationId: string,
    event: ServerEventName,
    payload: unknown,
    seq?: number,
    exceptUserId?: string,
  ): Promise<void> {
    const members = await membersRepo.listActive(this.db, conversationId)
    const ids = members
      .map((m) => m.user_id)
      .filter((id) => id !== exceptUserId)
    this.sendToUsers(ids, event, payload, seq)
  }

  isOnline(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0
  }

  onlineUserIds(): string[] {
    return [...this.connections.keys()]
  }

  /** 心跳巡检需要遍历全部连接 */
  allConnections(): Conn[] {
    const out: Conn[] = []
    for (const set of this.connections.values()) out.push(...set)
    return out
  }

  connectionCount(): number {
    let total = 0
    for (const set of this.connections.values()) total += set.size
    return total
  }
}

let hubInstance: RealtimeHubImpl | null = null

export function getHub(db: DB): RealtimeHubImpl {
  if (!hubInstance) {
    hubInstance = new RealtimeHubImpl(db)
    setHub(hubInstance)
  }
  return hubInstance
}

/**
 * 追平阶段：分批下发变更直到追平，再按 seq 排序补发期间产生的实时事件。
 * 只有全部应用完成才把连接置为 live，保证客户端不会先看到实时事件、后看到历史。
 * 批与批之间让出事件循环：大批量追平不再阻塞其它连接的收发（背压）。
 */
export async function catchUp(conn: Conn, db: DB): Promise<{ cursor: number; hasMore: boolean }> {
  if (!conn.userId) return { cursor: conn.cursor, hasMore: false }

  let cursor = conn.cursor
  let hasMore = true

  while (hasMore) {
    const batch = await listChanges(db, conn.userId, cursor, SYNC_BATCH_SIZE)
    sendEvent(conn, 'sync.batch', {
      changes: batch.changes,
      nextCursor: batch.nextCursor,
      hasMore: batch.hasMore,
    })
    cursor = batch.nextCursor
    hasMore = batch.hasMore
    if (hasMore) await new Promise<void>((resolve) => setImmediate(resolve))
  }

  conn.cursor = cursor
  return { cursor, hasMore: false }
}

/** 选择要推送 presence 的用户：共同会话中的成员 */
export async function sharedContactIds(db: DB, userId: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT DISTINCT m2.user_id AS id
     FROM conversation_members m1
     JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
     WHERE m1.user_id = ? AND m1.left_at IS NULL AND m2.left_at IS NULL AND m2.user_id <> ?`,
    [userId, userId],
  )
  return rows.map((r) => r.id)
}

export async function touchPresence(db: DB, userId: string, status: 'online' | 'away' | 'dnd' | 'offline'): Promise<void> {
  const hub = hubInstance
  if (!hub) return
  const lastSeenAt = Date.now()
  await usersRepo.touchLastSeen(db, userId)
  hub.sendToUsers(await sharedContactIds(db, userId), 'presence.updated', { userId, status, lastSeenAt })
}

export const WS_TIMINGS = {
  authTimeout: WS_AUTH_TIMEOUT_MS,
  heartbeat: WS_HEARTBEAT_MS,
}
