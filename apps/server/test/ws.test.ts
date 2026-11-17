import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-ws-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let wsUrlToken: { alice: string; bob: string }

interface Frame {
  t: 'req' | 'res' | 'evt' | 'ack'
  e?: string
  d?: unknown
  id?: string
  ok?: boolean
  seq?: number
}

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  })
  return { status: res.statusCode, json: res.json() as T }
}

async function register(username: string, deviceId: string) {
  const res = await api<{ user: { id: string }; tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: { username, password: 'pass12345', displayName: username, device: device(deviceId) },
  })
  if (res.status !== 200) throw new Error(`注册失败: ${JSON.stringify(res.json)}`)
  return { id: res.json.user.id, token: res.json.tokens.accessToken }
}

interface Collector {
  frames: Frame[]
  waitFor: (predicate: (f: Frame) => boolean, timeoutMs?: number) => Promise<Frame>
  close: () => void
}

function collect(socket: WebSocket): Collector {
  const frames: Frame[] = []
  const waiters: Array<{ predicate: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []

  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame
    // 已满足的等待者优先消费，避免同一帧被多次匹配
    const idx = waiters.findIndex((w) => w.predicate(frame))
    if (idx >= 0) {
      const [waiter] = waiters.splice(idx, 1)
      waiter!.resolve(frame)
      return
    }
    frames.push(frame)
  })

  return {
    frames,
    waitFor(predicate, timeoutMs = 3000) {
      const existing = frames.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 WS 帧超时')), timeoutMs)
        waiters.push({
          predicate,
          resolve: (f) => {
            clearTimeout(timer)
            resolve(f)
          },
        })
      })
    },
    close() {
      socket.close()
    },
  }
}

async function openSocket(token: string, cursor = 0): Promise<{ socket: WebSocket; collector: Collector }> {
  // @fastify/websocket 在应用实例上注入 injectWS 用于测试
  const socket = await (app as unknown as {
    injectWS: (url: string) => Promise<WebSocket> | WebSocket
  }).injectWS('/ws')

  const collector = collect(socket)
  // injectWS 返回时连接通常已 open，直接发首帧，避免错过 open 事件
  const sendAuth = (): void => {
    socket.send(
      JSON.stringify({
        t: 'req',
        id: 'auth-1',
        e: 'auth',
        d: { token, deviceId: 'dev-b', cursor, resume: cursor > 0 },
      }),
    )
  }
  if (socket.readyState === socket.OPEN) sendAuth()
  else socket.on('open', sendAuth)

  return { socket, collector }
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const alice = await register('ws_alice', 'dev-a')
  const bob = await register('ws_bob', 'dev-b')
  wsUrlToken = { alice: alice.token, bob: bob.token }
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('WebSocket 握手与实时推送', () => {
  it('首帧 auth 后返回 auth.ok 并追平变更', async () => {
    const { collector } = await openSocket(wsUrlToken.bob)

    const authOk = await collector.waitFor((f) => f.t === 'evt' && f.e === 'auth.ok', 5000)
    expect(authOk.d).toBeTruthy()

    // 追平阶段至少会下发一批 sync.batch（哪怕为空）
    const batch = await collector.waitFor((f) => f.t === 'evt' && f.e === 'sync.batch', 5000)
    expect(batch.d).toHaveProperty('changes')
    expect(batch.d).toHaveProperty('hasMore', false)

    collector.close()
  }, 15000)

  it('另一端发消息时实时收到 message.created', async () => {
    const alice = await api<{ user: { id: string }; tokens: { accessToken: string } }>(
      'POST',
      '/auth/login',
      { body: { username: 'ws_alice', password: 'pass12345', device: device('dev-a') } },
    )
    const aliceToken = alice.json.tokens.accessToken

    const bobLogin = await api<{ user: { id: string }; tokens: { accessToken: string } }>(
      'POST',
      '/auth/login',
      { body: { username: 'ws_bob', password: 'pass12345', device: device('dev-b') } },
    )
    const bobId = bobLogin.json.user.id

    const conv = await api<{ conversation: { id: string } }>('POST', '/conversations', {
      token: aliceToken,
      body: { type: 'direct', targetUserId: bobId },
    })
    const conversationId = conv.json.conversation.id

    const { collector } = await openSocket(wsUrlToken.bob)
    await collector.waitFor((f) => f.t === 'evt' && f.e === 'auth.ok', 5000)
    await collector.waitFor((f) => f.t === 'evt' && f.e === 'sync.batch', 5000)

    await api('POST', '/messages', {
      token: aliceToken,
      body: { conversationId, clientNonce: 'ws-1', type: 'text', content: '实时推送测试' },
    })

    const created = await collector.waitFor(
      (f) => f.t === 'evt' && f.e === 'message.created',
      5000,
    )
    const payload = created.d as { message: { content: string; seq: number }; tempId: string | null }
    expect(payload.message.content).toBe('实时推送测试')
    expect(payload.message.seq).toBeGreaterThan(0)

    collector.close()
  }, 20000)

  it('未认证连接发请求被拒绝', async () => {
    const socket = await (app as unknown as { injectWS: (url: string) => Promise<WebSocket> | WebSocket }).injectWS('/ws')
    const collector = collect(socket)

    socket.send(
      JSON.stringify({ t: 'req', id: 'r1', e: 'message.send', d: { conversationId: 'x', clientNonce: 'x' } }),
    )

    const res = await collector.waitFor((f) => f.t === 'res' && f.id === 'r1', 5000)
    expect(res.ok).toBe(false)
    collector.close()
  }, 15000)
})
