import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-provider-patch-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''
let otherToken = ''

interface ProviderView {
  id: string
  name: string
  baseUrl: string
  model: string
  keyLocation: string
  apiKeyMasked: string | null
  visionModel: string | null
  contextWindow: number | null
}

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

async function createProvider(
  name: string,
  keyLocation: 'local' | 'server',
  apiKey: string,
): Promise<ProviderView> {
  const res = await api<{ provider: ProviderView }>('POST', '/ai/providers', {
    token,
    body: {
      name,
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
      apiKey,
      keyLocation,
    },
  })
  expect(res.status).toBe(200)
  return res.json.provider
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: {
      username: 'patch_user',
      password: 'pass12345',
      displayName: '修改测试',
      device: device('dev-patch'),
    },
  })
  token = reg.json.tokens.accessToken

  const other = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: {
      username: 'patch_other',
      password: 'pass12345',
      displayName: '其他用户',
      device: device('dev-patch-other'),
    },
  })
  otherToken = other.json.tokens.accessToken
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

describe('修改已有 AI 服务商', () => {
  it('局部修改不会把云端密钥位置改成本机', async () => {
    const provider = await createProvider('云端中转', 'server', 'sk-server-original-key')
    const res = await api<{ provider: ProviderView }>('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: { visionModel: 'qwen-vl-plus' },
    })

    expect(res.status).toBe(200)
    expect(res.json.provider.keyLocation).toBe('server')
    expect(res.json.provider.visionModel).toBe('qwen-vl-plus')
    expect(res.json.provider.apiKeyMasked).toMatch(/^sk-s\*/)
    expect(JSON.stringify(res.json)).not.toContain('sk-server-original-key')
  })

  it('云端密钥可更新或清空，明文不回显', async () => {
    const provider = await createProvider('云端可改', 'server', 'sk-server-original-key')
    const changed = await api<{ provider: ProviderView }>('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: { apiKey: 'sk-server-replaced-key' },
    })
    expect(changed.status).toBe(200)
    expect(changed.json.provider.apiKeyMasked).toMatch(/^sk-s\*/)
    expect(JSON.stringify(changed.json)).not.toContain('sk-server-replaced-key')

    const cleared = await api<{ provider: ProviderView }>('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: { apiKey: '' },
    })
    expect(cleared.status).toBe(200)
    expect(cleared.json.provider.apiKeyMasked).toBeNull()
  })

  it('本机密钥模式不把明文写进服务端', async () => {
    const provider = await createProvider('本机中转', 'local', 'sk-local-only-key')
    const res = await api<{ provider: ProviderView }>('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: { name: '改名本机中转', apiKey: 'sk-local-updated-key' },
    })
    expect(res.status).toBe(200)
    expect(res.json.provider.name).toBe('改名本机中转')
    expect(res.json.provider.apiKeyMasked).toBeNull()

    const { getDb } = await import('../src/db')
    const row = getDb()
      .prepare('SELECT api_key_enc FROM ai_providers WHERE id = ?')
      .get(provider.id) as { api_key_enc: string | null }
    expect(row.api_key_enc).toBeNull()
  })

  it('切到本机模式会清掉服务端密文，切回云端模式再写入', async () => {
    const provider = await createProvider('迁移密钥', 'server', 'sk-migration-key')
    const toLocal = await api<{ provider: ProviderView }>('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: { keyLocation: 'local' },
    })
    expect(toLocal.status).toBe(200)
    expect(toLocal.json.provider.keyLocation).toBe('local')
    expect(toLocal.json.provider.apiKeyMasked).toBeNull()

    const toServer = await api<{ provider: ProviderView }>('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: { keyLocation: 'server', apiKey: 'sk-migrated-back' },
    })
    expect(toServer.status).toBe(200)
    expect(toServer.json.provider.keyLocation).toBe('server')
    expect(toServer.json.provider.apiKeyMasked).toMatch(/^sk-m\*/)
  })

  it('常规字段与上下文窗口都能通过局部修改更新', async () => {
    const provider = await createProvider('常规字段', 'local', '')
    const res = await api<{ provider: ProviderView }>('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: {
        name: '新名称',
        baseUrl: 'https://new.example.com/v1',
        model: 'gpt-4.1-mini',
        contextWindow: 128000,
      },
    })
    expect(res.status).toBe(200)
    expect(res.json.provider.name).toBe('新名称')
    expect(res.json.provider.baseUrl).toBe('https://new.example.com/v1')
    expect(res.json.provider.model).toBe('gpt-4.1-mini')
    expect(res.json.provider.contextWindow).toBe(128000)
  })

  it('不能修改其他用户的服务商', async () => {
    const provider = await createProvider('他人不可改', 'local', '')
    const res = await api('PATCH', `/ai/providers/${provider.id}`, {
      token: otherToken,
      body: { name: '被篡改' },
    })
    expect(res.status).toBe(404)
  })

  it('非法字段仍然被拒绝', async () => {
    const provider = await createProvider('校验仍在', 'local', '')
    const res = await api('PATCH', `/ai/providers/${provider.id}`, {
      token,
      body: { baseUrl: 'x' },
    })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('VALIDATION')
  })
})
