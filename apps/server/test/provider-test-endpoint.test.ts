import { testDatabaseUrl } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-providertest-'))
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

/** 上游记录到的最近一次请求，供断言密钥与地址是否传对 */
let lastSeen = { url: '', authorization: '' }

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

beforeAll(async () => {
  upstream = createServer((req, res) => {
    lastSeen = {
      url: req.url ?? '',
      authorization: String(req.headers.authorization ?? ''),
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '连接成功' } }],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  upstreamPort = typeof address === 'object' && address ? address.port : 0

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: {
      username: 'ptest_user',
      password: 'pass12345',
      displayName: '连接测试',
      device: device('dev-ptest'),
    },
  })
  token = reg.json.tokens.accessToken
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  await closeDb()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('用托管密钥测试连接', () => {
  it('表单不传密钥也能用服务端托管的密钥测通', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '托管上游',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'gpt-4o-mini',
        apiKey: 'sk-stored-secret',
      },
    })
    expect(created.status).toBe(200)
    const id = created.json.provider.id

    const res = await api<{ ok: boolean; sample: string }>(
      'POST',
      `/ai/providers/${id}/test`,
      { token, body: {} },
    )
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.sample).toContain('连接成功')
    expect(lastSeen.authorization).toBe('Bearer sk-stored-secret')
    expect(lastSeen.url).toBe('/v1/chat/completions')
  })

  it('表单里的地址与模型覆盖存储值，密钥仍走托管', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '覆盖上游',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'old-model',
        apiKey: 'sk-other-secret',
      },
    })
    expect(created.status).toBe(200)
    const id = created.json.provider.id

    const res = await api<{ ok: boolean }>('POST', `/ai/providers/${id}/test`, {
      token,
      body: { model: 'new-model' },
    })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(lastSeen.authorization).toBe('Bearer sk-other-secret')
    expect(JSON.stringify(lastSeen).length).toBeGreaterThan(0)
  })

  it('没配密钥的服务商给出 400 提示而不是空 Bearer 打上游', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '无密钥上游',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'gpt-4o-mini',
      },
    })
    expect(created.status).toBe(200)

    const res = await api('POST', `/ai/providers/${created.json.provider.id}/test`, {
      token,
      body: {},
    })
    expect(res.status).toBe(400)
  })

  it('上游连不上返回 502 上游错误而不是 500', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '不可达上游',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-stored-secret',
      },
    })
    expect(created.status).toBe(200)

    const res = await api('POST', `/ai/providers/${created.json.provider.id}/test`, {
      token,
      body: {},
    })
    expect(res.status).toBe(502)
    expect(res.json.error?.code).toBe('UPSTREAM_AI_ERROR')
  })

  it('密文解密失败时列表回显为未配置，测试连接给出 400 重填提示', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '密文损坏',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'gpt-4o-mini',
        apiKey: 'sk-will-corrupt',
      },
    })
    expect(created.status).toBe(200)
    const id = created.json.provider.id

    // 直接把密文改坏，模拟 SECRET_KEY 变动后的解密失败
    const { getDb, run } = await import('../src/db')
    await run(getDb(), 'UPDATE ai_providers SET api_key_enc = ? WHERE id = ?', ['broken-cipher', id])

    const list = await api<{ providers: Array<{ id: string; apiKeyMasked: string | null }> }>(
      'GET',
      '/ai/providers',
      { token },
    )
    const broken = list.json.providers.find((p) => p.id === id)
    expect(broken?.apiKeyMasked).toBeNull()

    const res = await api('POST', `/ai/providers/${id}/test`, { token, body: {} })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toContain('重新保存')
  })
})
