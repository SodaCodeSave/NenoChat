import { testDatabaseUrl } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-aimodels-'))
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
    if (req.url === '/v1/models') {
      if (!req.headers.authorization) {
        res.writeHead(401)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'gpt-4o' },
            { id: 'gpt-4o-mini' },
            { id: 'gpt-4o' },
            { id: 42 },
            'plain-model',
          ],
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
      username: 'models_user',
      password: 'pass12345',
      displayName: '模型列表测试',
      device: device('dev-models'),
    },
  })
  token = reg.json.tokens.accessToken
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('服务商模型列表', () => {
  it('保存前可用表单参数预览模型，去重排序并过滤非法项', async () => {
    const res = await api<{ models: string[] }>(
      'POST',
      '/ai/providers/models',
      {
        token,
        body: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
      },
    )
    expect(res.status).toBe(200)
    expect(res.json.models).toEqual(['gpt-4o', 'gpt-4o-mini', 'plain-model'])
  })

  it('已保存服务商可读取托管密钥拉取模型列表', async () => {
    const created = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
      token,
      body: {
        name: '本地上游',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'gpt-4o-mini',
        apiKey: 'sk-stored-key',
      },
    })
    expect(created.status).toBe(200)

    const res = await api<{ models: string[] }>(
      'GET',
      `/ai/providers/${created.json.provider.id}/models`,
      { token },
    )
    expect(res.status).toBe(200)
    expect(res.json.models).toContain('gpt-4o')
  })

  it('拉取失败返回上游错误而不是空列表', async () => {
    const res = await api('POST', '/ai/providers/models', {
      token,
      body: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: '' },
    })
    expect(res.status).toBe(502)
  })
})
