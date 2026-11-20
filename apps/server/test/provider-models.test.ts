import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-providermodels-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''

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
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: {
      username: 'pmodels_user',
      password: 'pass12345',
      displayName: '模型列表测试',
      device: device('dev-pmodels'),
    },
  })
  token = reg.json.tokens.accessToken
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

describe('供应商 AI 列表与价格', () => {
  it('创建时带上 AI 列表，回读能拿到开关与价格', async () => {
    const created = await api<{ provider: { id: string; models: any[] } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '带列表上游',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test',
        models: [
          { model: 'gpt-4o-mini', enabled: false, priceInput: 0.15, priceOutput: 0.6 },
          { model: 'gpt-4o' },
        ],
      },
    })
    expect(created.status).toBe(200)
    expect(created.json.provider.models).toHaveLength(2)
    expect(created.json.provider.models[0]).toMatchObject({
      model: 'gpt-4o-mini',
      enabled: false,
      priceInput: 0.15,
      priceOutput: 0.6,
    })
    // 没传 enabled 的条目按启用处理
    expect(created.json.provider.models[1]).toMatchObject({
      model: 'gpt-4o',
      enabled: true,
      priceInput: null,
      priceOutput: null,
    })
  })

  it('PATCH 整体替换列表；不带 models 字段时不改动', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '替换上游',
        baseUrl: 'https://api.example.com/v1',
        model: 'glm-4-flash',
        models: [{ model: 'glm-4-flash', enabled: true }],
      },
    })
    const id = created.json.provider.id

    const replaced = await api<{ provider: { models: any[] } }>('PATCH', `/ai/providers/${id}`, {
      token,
      body: { models: [{ model: 'glm-4-plus', enabled: false, priceOutput: 1 }] },
    })
    expect(replaced.status).toBe(200)
    expect(replaced.json.provider.models).toEqual([
      { model: 'glm-4-plus', enabled: false, priceInput: null, priceOutput: 1 },
    ])

    const untouched = await api<{ provider: { models: any[] } }>('PATCH', `/ai/providers/${id}`, {
      token,
      body: { name: '改名不碰列表' },
    })
    expect(untouched.status).toBe(200)
    expect(untouched.json.provider.models).toEqual([
      { model: 'glm-4-plus', enabled: false, priceInput: null, priceOutput: 1 },
    ])
  })

  it('空列表表示清空，列表条目缺模型名时返回 400', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '清空上游',
        baseUrl: 'https://api.example.com/v1',
        model: 'deepseek-chat',
        models: [{ model: 'deepseek-chat' }],
      },
    })
    const id = created.json.provider.id

    const cleared = await api<{ provider: { models: any[] } }>('PATCH', `/ai/providers/${id}`, {
      token,
      body: { models: [] },
    })
    expect(cleared.status).toBe(200)
    expect(cleared.json.provider.models).toEqual([])

    const invalid = await api('PATCH', `/ai/providers/${id}`, {
      token,
      body: { models: [{ enabled: true }] },
    })
    expect(invalid.status).toBe(400)
  })
})
