import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 全服共享 AI 模式的解析回退与计费：
 * - 共享关闭时无供应商报错（现状不变）
 * - 共享开启后没自配供应商的回退到服务器供应商并计费扣余额
 * - 自有供应商优先且不计费
 * - 余额耗尽拒绝调用
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-shared-billing-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let upstream: Server
let upstreamPort = 0
let adminToken = ''
let adminId = ''
let bobToken = ''
let bobId = ''

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  })
  return { status: res.statusCode, json: res.json() }
}

async function register(username: string) {
  const res = await api('POST', '/auth/register', {
    body: { username, password: 'pass12345', displayName: username, device: device(`dev-${username}`) },
  })
  expect(res.status).toBe(200)
  return { id: res.json.user.id as string, token: res.json.tokens.accessToken as string }
}

/** 一次完整的「开 AI 会话 + 发消息生成」流程；两个响应都原样返回给用例自行断言 */
async function generate(token: string, personaId: string, providerId?: string) {
  const conv = await api<{ conversation: { id: string } }>('POST', '/ai/conversations', {
    token,
    body: { personaId, ...(providerId ? { providerId } : {}) },
  })

  const conversationId = conv.json.conversation?.id
  const res = conversationId
    ? await api('POST', '/ai/generations', {
        token,
        body: {
          conversationId,
          content: '在吗',
          clientNonce: `nb-${Math.random()}`,
          ...(providerId ? { providerId } : {}),
        },
      })
    : null
  return { conv, res }
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '在的。' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }),
    )
  })
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as { port: number }).port
      resolve()
    })
  })

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const admin = await register('root_admin')
  adminToken = admin.token
  adminId = admin.id
  const bob = await register('bob_member')
  bobToken = bob.token
  bobId = bob.id
})

afterAll(async () => {
  await app.close()
  upstream.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('全服共享 AI 模式', () => {
  it('共享关闭：没配供应商的用户开 AI 会话被拒（现状不变）', async () => {
    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token: bobToken,
      body: { name: '共享前角色', systemPrompt: '你是朋友。' },
    })
    const { conv } = await generate(bobToken, persona.json.persona.id)
    expect(conv.status).toBe(400)
    expect(conv.json.error.message).toContain('AI 服务商')
  })

  it('共享开启 + 充值后，无自有供应商的用户走服务器供应商并计费', async () => {
    await api('PATCH', '/admin/ai/shared-mode', { token: adminToken, body: { enabled: true } })
    const created = await api('POST', '/admin/ai/providers', {
      token: adminToken,
      body: {
        name: '服务器主供应商',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'shared-model',
        apiKey: 'sk-shared',
        models: [{ model: 'shared-model', enabled: true, priceInput: 1.5, priceOutput: 3 }],
      },
    })
    expect(created.status).toBe(200)

    // 角色创建不 pin 系统供应商（保持 providerId 为空，由生成时解析）
    const persona = await api<{ persona: { id: string; providerId: string | null } }>('POST', '/ai/personas', {
      token: bobToken,
      body: { name: '共享角色', systemPrompt: '你是朋友。' },
    })
    expect(persona.json.persona.providerId).toBeNull()

    const charge = await api('POST', `/admin/ai/balances/${bobId}`, { token: adminToken, body: { delta: 5 } })
    expect(charge.json.balance).toBeCloseTo(5, 6)

    const { res } = await generate(bobToken, persona.json.persona.id)
    expect(res.status).toBe(200)

    // 1000/1e6×1.5 + 500/1e6×3 = 0.003 元
    const balance = await api('GET', '/ai/balance', { token: bobToken })
    expect(balance.json.sharedMode).toBe(true)
    expect(balance.json.balance).toBeCloseTo(4.997, 6)
  })

  it('余额耗尽后走服务器供应商被拒绝', async () => {
    await api('POST', `/admin/ai/balances/${bobId}`, { token: adminToken, body: { delta: -10 } })
    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token: bobToken,
      body: { name: '欠费角色', systemPrompt: '你是朋友。' },
    })
    const { res } = await generate(bobToken, persona.json.persona.id)
    expect(res.status).toBe(400)
    expect(res.json.error.message).toContain('额度')
  })

  it('自有供应商优先且不计费', async () => {
    const own = await api('POST', '/ai/providers', {
      token: bobToken,
      body: {
        name: 'bob 自有',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'own-model',
        apiKey: 'sk-bob',
      },
    })
    expect(own.status).toBe(200)
    const ownId = own.json.provider.id

    // 先回充到正数（上一轮扣到负值），再用自有供应商生成
    const charge = await api('POST', `/admin/ai/balances/${bobId}`, { token: adminToken, body: { delta: 10 } })
    expect(charge.json.balance).toBeCloseTo(4.997, 6)

    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token: bobToken,
      body: { name: '自有角色', systemPrompt: '你是朋友。' },
    })
    const { res } = await generate(bobToken, persona.json.persona.id, ownId)
    expect(res.status).toBe(200)

    const after = await api('GET', '/ai/balance', { token: bobToken })
    expect(after.json.balance).toBeCloseTo(4.997, 6)
  })

  it('共享关闭后回退链还原：无自有供应商的新用户开 AI 会话被拒', async () => {
    await api('PATCH', '/admin/ai/shared-mode', { token: adminToken, body: { enabled: false } })
    const carol = await register('carol_late')
    const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token: carol.token,
      body: { name: '关闭后角色', systemPrompt: '你是朋友。' },
    })
    const { conv } = await generate(carol.token, persona.json.persona.id)
    expect(conv.status).toBe(400)
    expect(conv.json.error.message).toContain('AI 服务商')
  })

  it('管理员用户详情携带余额字段', async () => {
    const detail = await api('GET', `/admin/users/${bobId}`, { token: adminToken })
    expect(detail.status).toBe(200)
    expect(detail.json.aiBalance).toBeCloseTo(4.997, 6)
  })
})
