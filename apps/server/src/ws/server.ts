import websocket from '@fastify/websocket'
import type { FastifyInstance } from 'fastify'
import { ulid, type WsFrame } from '@nenochat/shared'
import { getDb } from '../db'
import type { DB } from '../db'
import { normalizeError } from '../util/errors'
import { now } from '../util/clock'
import * as usersRepo from '../db/repo/users'
import {
  getHub,
  sendEvent,
  sendResponse,
  touchPresence,
  WS_TIMINGS,
  type Conn,
} from './connection'
import { completeHandshake, handleRequest } from './handlers'
import type { AccessTokenPayload } from '../services/auth-service'
import { maxCursor } from '../services/sync-service'

interface AuthFramePayload {
  token: string
  deviceId: string
  cursor: number
  resume: boolean
}

export async function registerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocket)
  const db: DB = getDb()
  const hub = getHub(db)

  app.get('/ws', { websocket: true }, (socket, request) => {
    const conn: Conn = {
      id: ulid(),
      socket,
      userId: null,
      deviceId: null,
      state: 'unauth',
      cursor: 0,
      pending: [],
      subscriptions: new Set(),
      alive: true,
      lastPongAt: now(),
    }

    const closeUnauthorized = (code: number, reason: string): void => {
      try {
        socket.close(code, reason)
      } catch {
        /* 连接可能已经断开，忽略 */
      }
    }

    // 握手超时：连上却不认证的连接一律断开，避免占用资源
    const authTimer = setTimeout(() => {
      if (conn.state === 'unauth') closeUnauthorized(4401, 'auth timeout')
    }, WS_TIMINGS.authTimeout)

    socket.on('message', (raw) => {
      void (async () => {
        let frame: WsFrame
        try {
          frame = JSON.parse(raw.toString()) as WsFrame
        } catch {
          return
        }
        if (frame.t !== 'req') return

        if (frame.e === 'auth') {
          const payload = frame.d as AuthFramePayload
          try {
            const decoded = await app.jwt.verify<AccessTokenPayload>(payload.token)
            if (decoded.typ !== 'access') throw new Error('bad token type')

            const user = usersRepo.findById(db, decoded.sub)
            if (!user || user.status === 'disabled') throw new Error('user unavailable')

            clearTimeout(authTimer)
            conn.userId = decoded.sub
            conn.deviceId = payload.deviceId || decoded.did
            conn.cursor = Number.isFinite(payload.cursor) ? Math.max(0, payload.cursor) : 0

            hub.add(conn)
            touchPresence(db, decoded.sub, 'online')

            const head = maxCursor(db)
            sendEvent(conn, 'auth.ok', {
              user: usersRepo.mapUser(user),
              sessionId: conn.id,
              serverTime: now(),
              cursor: conn.cursor,
              catchUp: { hasMore: conn.cursor < head, nextCursor: conn.cursor },
            })

            conn.state = 'catchingUp'
            completeHandshake(conn, db)
          } catch {
            sendResponse(conn, frame.id, false, null, {
              code: 'UNAUTHENTICATED',
              message: '连接认证失败',
            })
            closeUnauthorized(4401, 'unauthorized')
          }
          return
        }

        await handleRequest(conn, db, frame.id, frame.e, frame.d)
      })()
    })

    socket.on('pong', () => {
      conn.alive = true
      conn.lastPongAt = now()
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
      hub.remove(conn)
      if (conn.userId && !hub.isOnline(conn.userId)) {
        touchPresence(db, conn.userId, 'offline')
      }
    })

    socket.on('error', (e) => {
      request.log.warn({ err: e }, 'ws error')
    })
  })

  // 心跳巡检：两轮没有 pong 视为死连接
  const heartbeat = setInterval(() => {
    for (const conn of hub.allConnections()) {
      if (!conn.alive) {
        try {
          conn.socket.terminate()
        } catch {
          /* 忽略 */
        }
        continue
      }
      conn.alive = false
      try {
        conn.socket.ping()
      } catch {
        /* 忽略 */
      }
    }
  }, WS_TIMINGS.heartbeat)

  app.addHook('onClose', async () => {
    clearInterval(heartbeat)
  })
}

export { normalizeError }
