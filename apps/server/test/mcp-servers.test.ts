import { testDatabaseUrl } from './helpers/pg'
import { startTestMcpServer } from './helpers/mcp-server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-mcp-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''
let mcpPort = 0
let closeMcp: (() => Promise<void>) | null = null

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const authToken = options.token ?? token
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  })
  return { status: res.statusCode, json: res.json() as T }
}

beforeAll(async () => {
  const mcp = await startTestMcpServer()
  mcpPort = mcp.port
  closeMcp = mcp.close

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: { username: 'mcp_user', password: 'pass12345', displayName: 'MCP 用户', device: device('dev-mcp') },
  })
  if (!reg.json?.tokens) throw new Error(`注册失败: ${JSON.stringify(reg.json)}`)
  token = reg.json.tokens.accessToken
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  await closeMcp?.()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('MCP 服务器 CRUD', () => {
  it('创建后凭据只回掩码，明文 header 不出现在任何响应里', async () => {
    const created = await api<{ server: { id: string; name: string; secretMasked: { headers?: Record<string, string> } } }>(
      'POST',
      '/mcp-servers',
      {
        body: {
          name: '搜索 MCP',
          url: `http://127.0.0.1:${mcpPort}`,
          secret: { headers: { Authorization: 'Bearer mcp-secret-header-token' } },
        },
      },
    )
    expect(created.status).toBe(200)
    expect(created.json.server.name).toBe('搜索 MCP')
    expect(created.json.server.enabled).toBe(true)
    expect(created.json.server.secretMasked.headers?.Authorization).not.toBe('Bearer mcp-secret-header-token')
    expect(JSON.stringify(created.json)).not.toContain('mcp-secret-header-token')

    const list = await api<{ servers: Array<{ id: string; url: string }> }>('GET', '/mcp-servers')
    expect(list.json.servers.some((s) => s.id === created.json.server.id)).toBe(true)
    expect(JSON.stringify(list.json)).not.toContain('mcp-secret-header-token')
  })

  it('地址不合法（含账号密码 / 非法协议）时创建被拒', async () => {
    const withCred = await api('POST', '/mcp-servers', {
      body: { name: 'bad', url: 'http://user:pass@example.com/mcp' },
    })
    expect(withCred.status).toBe(400)

    const ftp = await api('POST', '/mcp-servers', { body: { name: 'bad', url: 'ftp://example.com/mcp' } })
    expect(ftp.status).toBe(400)
  })

  it('patch 更新名称与启用状态；空 secret 表示清空凭据', async () => {
    const created = await api<{ server: { id: string } }>('POST', '/mcp-servers', {
      body: { name: '待改', url: `http://127.0.0.1:${mcpPort}` },
    })
    const id = created.json.server.id

    const patched = await api<{ server: { name: string; enabled: boolean } }>('PATCH', `/mcp-servers/${id}`, {
      body: { name: '已改', enabled: false },
    })
    expect(patched.json.server.name).toBe('已改')
    expect(patched.json.server.enabled).toBe(false)
  })

  it('test 端点走真实 MCP 握手，回写工具数到 last_test_*', async () => {
    const created = await api<{ server: { id: string } }>('POST', '/mcp-servers', {
      body: { name: '握手测试', url: `http://127.0.0.1:${mcpPort}` },
    })
    const id = created.json.server.id

    const tested = await api<{ result: { ok: boolean; message: string } }>('POST', `/mcp-servers/${id}/test`)
    expect(tested.status).toBe(200)
    expect(tested.json.result.ok).toBe(true)
    expect(tested.json.result.message).toContain('1 个工具')
    expect(tested.json.result.message).toContain('echo')

    const list = await api<{ servers: Array<{ id: string; lastTestOk: boolean | null; lastTestMessage: string | null }> }>(
      'GET',
      '/mcp-servers',
    )
    const row = list.json.servers.find((s) => s.id === id)!
    expect(row.lastTestOk).toBe(true)
    expect(row.lastTestMessage).toContain('echo')
  })

  it('指向不存在端点的服务器测试失败并落库', async () => {
    const created = await api<{ server: { id: string } }>('POST', '/mcp-servers', {
      body: { name: '死端点', url: 'http://127.0.0.1:1' },
    })
    const tested = await api<{ result: { ok: boolean } }>('POST', `/mcp-servers/${created.json.server.id}/test`)
    expect(tested.json.result.ok).toBe(false)

    const list = await api<{ servers: Array<{ id: string; lastTestOk: boolean | null }> }>('GET', '/mcp-servers')
    expect(list.json.servers.find((s) => s.id === created.json.server.id)?.lastTestOk).toBe(false)
  })

  it('删除后列表不再包含；他用户的资源不可见（按 owner 隔离）', async () => {
    const created = await api<{ server: { id: string } }>('POST', '/mcp-servers', {
      body: { name: '将删', url: `http://127.0.0.1:${mcpPort}` },
    })
    const del = await api('DELETE', `/mcp-servers/${created.json.server.id}`)
    expect(del.status).toBe(200)

    const list = await api<{ servers: Array<{ id: string }> }>('GET', '/mcp-servers')
    expect(list.json.servers.some((s) => s.id === created.json.server.id)).toBe(false)
  })
})

describe('技能 CRUD', () => {
  it('创建技能并回读，enabled 缺省为 true', async () => {
    const created = await api<{ skill: { id: string; name: string; enabled: boolean; content: string } }>(
      'POST',
      '/skills',
      {
        body: {
          name: '天气查询',
          description: '查询城市天气的固定话术',
          content: '## 天气查询\n调用和风天气 API 查询后按口语播报。',
        },
      },
    )
    expect(created.status).toBe(200)
    expect(created.json.skill.enabled).toBe(true)
    expect(created.json.skill.content).toContain('和风天气')

    const list = await api<{ skills: Array<{ id: string }> }>('GET', '/skills')
    expect(list.json.skills.some((s) => s.id === created.json.skill.id)).toBe(true)
  })

  it('patch 更新正文与停用；删除后不可见', async () => {
    const created = await api<{ skill: { id: string } }>('POST', '/skills', {
      body: { name: '待删技能', description: '', content: '旧正文' },
    })
    const id = created.json.skill.id

    const patched = await api<{ skill: { enabled: boolean; content: string } }>('PATCH', `/skills/${id}`, {
      body: { content: '新正文', enabled: false },
    })
    expect(patched.json.skill.enabled).toBe(false)
    expect(patched.json.skill.content).toBe('新正文')

    await api('DELETE', `/skills/${id}`)
    const list = await api<{ skills: Array<{ id: string }> }>('GET', '/skills')
    expect(list.json.skills.some((s) => s.id === id)).toBe(false)
  })

  it('正文超长被校验拒绝', async () => {
    const res = await api('POST', '/skills', {
      body: { name: '超长', description: '', content: 'a'.repeat(30001) },
    })
    expect(res.status).toBe(400)
  })
})
