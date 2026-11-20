import { testDatabaseUrl } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-proflow-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let upstream: Server
let upstreamPort = 0
let token = ''
let conversationId = ''
let personaId = ''

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
  level: 'fatal',
} as never

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  })
  return { status: res.statusCode, json: res.json() as T }
}

beforeAll(async () => {
  // 假的 OpenAI 兼容上游：固定返回一句主动搭话
  upstream = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '刚听到一首很适合你的歌。你最近还好吗？' } }],
          usage: { prompt_tokens: 10, completion_tokens: 12 },
        }),
      )
    })
  })

  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      const address = upstream.address()
      upstreamPort = typeof address === 'object' && address ? address.port : 0
      resolve()
    })
  })

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      username: 'proflow_user',
      password: 'pass12345',
      displayName: '主动消息用户',
      device: device('dev-flow'),
    }),
  })
  token = (reg.json() as { tokens: { accessToken: string } }).tokens.accessToken

  // 密钥托管在服务端，服务端才有能力离线主动发
  const provider = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
    name: 'mock',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    model: 'mock-model',
    apiKey: 'sk-mock-key-123456',
    keyLocation: 'server',
  })
  expect(provider.status).toBe(200)

  const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
    name: '小禾',
    systemPrompt: '你是朋友。',
    interests: ['独立音乐', '猫'],
    card: '你住在一间临街旧书店的楼上。',
    providerId: provider.json.provider.id,
    proactive: { enabled: true, minIdleHours: 0, maxPerDay: 1 },
  })
  personaId = persona.json.persona.id

  const list = await api<{ conversations: Array<{ id: string; aiPersonaId: string | null }> }>(
    'GET',
    '/conversations',
  )
  conversationId = list.json.conversations.find((c) => c.aiPersonaId === personaId)!.id
})

afterAll(async () => {
  await app.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  const { closeDb } = await import('../src/db')
  await closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('主动消息端到端', () => {
  it('扫描后生成一条 AI 消息并写入日志', async () => {
    const { getDb, all, run } = await import('../src/db')
    const { scanOnce } = await import('../src/services/proactive-service')
    const db = getDb()

    // 造一条「很久以前的用户消息」，满足空闲条件
    await api('POST', '/messages', {
      conversationId,
      clientNonce: 'proflow-user-msg',
      type: 'text',
      content: '今天有点累',
    })
    await run(db, `UPDATE messages SET created_at = ? WHERE conversation_id = ? AND client_nonce = ?`, [
      Date.now() - 12 * 3_600_000,
      conversationId,
      'proflow-user-msg',
    ])

    await scanOnce(db, silentLog)

    const log = await all<{ status: string; slot: number; message_id: string | null; reason: string | null }>(
      db,
      'SELECT status, slot, message_id, reason FROM ai_proactive_log WHERE conversation_id = ?',
      [conversationId],
    )
    expect(log).toHaveLength(1)
    expect(log[0]!.status).toBe('sent')
    expect(log[0]!.message_id).toBeTruthy()

    const messages = await api<{
      messages: Array<{ senderType: string; content: string; meta?: { ai?: { proactive?: boolean; personaId?: string } } }>
    }>('GET', `/conversations/${conversationId}/messages?limit=20`)
    const proactive = messages.json.messages.find((m) => m.meta?.ai?.proactive)
    expect(proactive).toBeTruthy()
    expect(proactive!.senderType).toBe('ai')
    expect(proactive!.content).toContain('歌')
    expect(proactive!.meta!.ai!.personaId).toBe(personaId)
  })

  it('同一轮再扫一次不会重复发（日上限 1）', async () => {
    const { getDb, one } = await import('../src/db')
    const { scanOnce } = await import('../src/services/proactive-service')
    const db = getDb()

    await scanOnce(db, silentLog)

    const log = (await one<{ c: number }>(
      db,
      'SELECT COUNT(*) AS c FROM ai_proactive_log WHERE conversation_id = ?',
      [conversationId],
    ))!
    expect(log.c).toBe(1)
  })

  it('切成跟随全局后，是否发消息由全局开关决定', async () => {
    const { getDb, one, run } = await import('../src/db')
    const { scanOnce } = await import('../src/services/proactive-service')
    const db = getDb()

    // 清掉上一轮的配额与冷却，保留角色自己的 enabled=true，验证它不再起作用
    await run(db, 'DELETE FROM ai_proactive_log')
    await run(db, 'UPDATE ai_personas SET last_proactive_at = NULL WHERE id = ?', [personaId])

    const patched = await api<{ persona: { proactiveMode: string } }>(
      'PATCH',
      `/ai/personas/${personaId}`,
      { proactiveMode: 'global' },
    )
    expect(patched.json.persona.proactiveMode).toBe('global')

    // 全局默认关着：角色自己开着也不该发
    await scanOnce(db, silentLog)
    expect(((await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM ai_proactive_log'))!).c).toBe(0)

    await api('PATCH', '/ai/settings', {
      proactiveEnabled: true,
      minIdleHours: 0,
      maxPerDay: 1,
    })
    await scanOnce(db, silentLog)
    expect(((await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM ai_proactive_log'))!).c).toBe(1)
  })
})
