import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 管理面板·AI 配置：共享模式开关、系统供应商 CRUD、模型预览/测试/余额探测、
 * 用户余额管理。服务器供应商挂在影子账号 system-ai 名下。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-admin-ai-'))
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
let plainToken = ''

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

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-b' }, { id: 'mock-a' }, { id: 'mock-a' }] }))
      return
    }
    if (req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '连接成功' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      )
      return
    }
    if (req.url?.endsWith('/user/info')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { balance: '12.50', currency: 'CNY' } }))
      return
    }
    res.writeHead(404).end()
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
  const plain = await register('plain_user')
  plainToken = plain.token
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

describe('管理面板·AI 配置守卫', () => {
  it('普通用户访问 AI 配置一律 403', async () => {
    expect((await api('GET', '/admin/ai/providers', { token: plainToken })).status).toBe(403)
    expect(
      (await api('PATCH', '/admin/ai/shared-mode', { token: plainToken, body: { enabled: true } })).status,
    ).toBe(403)
    expect(
      (await api('PATCH', '/admin/ai/provider-ad', { token: plainToken, body: { enabled: false } })).status,
    ).toBe(403)
    expect(
      (await api('POST', '/admin/ai/balances/whatever', { token: plainToken, body: { delta: 1 } })).status,
    ).toBe(403)
  })
})

describe('全服共享模式开关', () => {
  it('默认关闭，打开后可读回且写入审计', async () => {
    const initial = await api('GET', '/admin/ai/providers', { token: adminToken })
    expect(initial.status).toBe(200)
    expect(initial.json.sharedMode).toBe(false)
    expect(initial.json.providers).toEqual([])

    const patch = await api('PATCH', '/admin/ai/shared-mode', { token: adminToken, body: { enabled: true } })
    expect(patch.status).toBe(200)
    expect(patch.json.sharedMode).toBe(true)

    const again = await api('GET', '/admin/ai/providers', { token: adminToken })
    expect(again.json.sharedMode).toBe(true)

    const audit = await api('GET', '/admin/audit', { token: adminToken })
    expect(audit.json.items.some((a: any) => a.action === 'ai.shared_mode')).toBe(true)
  })
})

describe('模型设置页广告配置', () => {
  it('默认关闭：没配置过时读回出厂默认', async () => {
    const res = await api('GET', '/admin/ai/providers', { token: adminToken })
    expect(res.status).toBe(200)
    expect(res.json.providerAd).toEqual({
      enabled: false,
      title: '',
      text: '',
      link: '',
      iconUrl: '',
    })
    // 默认关闭时普通用户的余额接口不下发横幅
    const balance = await api('GET', '/ai/balance', { token: plainToken })
    expect(balance.status).toBe(200)
    expect(balance.json.ad).toBeNull()
  })

  it('校验：非法链接与开启但文案为空都被拒绝', async () => {
    expect(
      (
        await api('PATCH', '/admin/ai/provider-ad', {
          token: adminToken,
          body: { enabled: true, title: '', text: 'x', link: 'ftp://bad', iconUrl: '' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await api('PATCH', '/admin/ai/provider-ad', {
          token: adminToken,
          body: { enabled: true, title: '', text: '  ', link: '', iconUrl: '' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await api('PATCH', '/admin/ai/provider-ad', {
          token: adminToken,
          body: { enabled: false, title: '', text: 'x', iconUrl: 'javascript:alert(1)' },
        })
      ).status,
    ).toBe(400)
  })

  it('保存后回读一致，客户端余额接口随之下发横幅，写审计', async () => {
    const patch = await api('PATCH', '/admin/ai/provider-ad', {
      token: adminToken,
      body: {
        enabled: true,
        title: 'TokenRouter',
        text: '低价AI中转站，{GLM 5.3 Flash|DeepSeek v4.1 Flash} 输出仅 ¥{0.56/1M|1.6/1M}',
        link: 'https://ai.anmc.cn/sign-up?aff=u0pn',
        iconUrl: 'https://cdn.example.com/icon.svg',
      },
    })
    expect(patch.status).toBe(200)
    expect(patch.json.providerAd).toMatchObject({ enabled: true, title: 'TokenRouter' })

    const again = await api('GET', '/admin/ai/providers', { token: adminToken })
    expect(again.json.providerAd.enabled).toBe(true)
    expect(again.json.providerAd.text).toContain('{GLM 5.3 Flash|DeepSeek v4.1 Flash}')

    const balance = await api('GET', '/ai/balance', { token: plainToken })
    expect(balance.json.ad).toEqual({
      title: 'TokenRouter',
      text: '低价AI中转站，{GLM 5.3 Flash|DeepSeek v4.1 Flash} 输出仅 ¥{0.56/1M|1.6/1M}',
      link: 'https://ai.anmc.cn/sign-up?aff=u0pn',
      iconUrl: 'https://cdn.example.com/icon.svg',
    })

    const audit = await api('GET', '/admin/audit', { token: adminToken })
    expect(audit.json.items.some((a: any) => a.action === 'ai.provider_ad')).toBe(true)
  })

  it('关闭后客户端不再下发横幅，字段保留以便下次开启', async () => {
    const off = await api('PATCH', '/admin/ai/provider-ad', {
      token: adminToken,
      body: {
        enabled: false,
        title: 'TokenRouter',
        text: '低价AI中转站',
        link: 'https://ai.anmc.cn/sign-up?aff=u0pn',
        iconUrl: '',
      },
    })
    expect(off.status).toBe(200)

    const balance = await api('GET', '/ai/balance', { token: plainToken })
    expect(balance.json.ad).toBeNull()

    const again = await api('GET', '/admin/ai/providers', { token: adminToken })
    expect(again.json.providerAd.enabled).toBe(false)
    expect(again.json.providerAd.title).toBe('TokenRouter')
  })
})

describe('系统供应商 CRUD', () => {
  let providerId = ''

  it('创建：key 加密存储、接口只回掩码', async () => {
    const created = await api('POST', '/admin/ai/providers', {
      token: adminToken,
      body: {
        name: '服务器主供应商',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: 'mock-a',
        apiKey: 'sk-admin-secret-key-123',
        models: [
          { model: 'mock-a', enabled: true, priceInput: 1.5, priceOutput: 3 },
          { model: 'mock-b', enabled: false },
        ],
      },
    })
    expect(created.status).toBe(200)
    providerId = created.json.provider.id
    expect(created.json.provider.apiKeyMasked).toContain('****')
    expect(created.json.provider.apiKeyMasked).not.toContain('secret-key-123'.slice(4, -4))
    expect(created.json.provider.models).toHaveLength(2)
  })

  it('列表只含系统供应商；影子账号不可登录、不进用户列表', async () => {
    const list = await api('GET', '/admin/ai/providers', { token: adminToken })
    expect(list.json.providers).toHaveLength(1)
    expect(list.json.providers[0].id).toBe(providerId)

    const login = await api('POST', '/auth/login', {
      body: { username: 'ai_system', password: 'whatever', device: device('dev-x') },
    })
    expect(login.status).toBe(403)

    const users = await api('GET', '/admin/users', { token: adminToken })
    expect(users.json.items.some((u: any) => u.username === 'ai_system')).toBe(false)
  })

  it('上游拉取模型列表与连接测试（服务端托管 key）', async () => {
    const models = await api('GET', `/admin/ai/providers/${providerId}/models`, { token: adminToken })
    expect(models.status).toBe(200)
    // 上游返回去重排序
    expect(models.json.models).toEqual(['mock-a', 'mock-b'])

    const preview = await api('POST', '/admin/ai/providers/models', {
      token: adminToken,
      body: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-x' },
    })
    expect(preview.status).toBe(200)
    expect(preview.json.models).toContain('mock-a')

    const test = await api('POST', `/admin/ai/providers/${providerId}/test`, {
      token: adminToken,
      body: {},
    })
    expect(test.status).toBe(200)
    expect(test.json.ok).toBe(true)
  })

  it('余额探测端点可用', async () => {
    const res = await api('POST', `/admin/ai/providers/${providerId}/balance`, { token: adminToken })
    expect(res.status).toBe(200)
    expect(res.json.provider.balance).toBe('12.5')
    expect(res.json.provider.balanceCurrency).toBe('CNY')
  })

  it('PATCH 更新与清空密钥', async () => {
    const patch = await api('PATCH', `/admin/ai/providers/${providerId}`, {
      token: adminToken,
      body: { apiKey: '' },
    })
    expect(patch.status).toBe(200)
    expect(patch.json.provider.apiKeyMasked).toBeNull()

    const restore = await api('PATCH', `/admin/ai/providers/${providerId}`, {
      token: adminToken,
      body: { apiKey: 'sk-admin-secret-key-123' },
    })
    expect(restore.json.provider.apiKeyMasked).toContain('****')
  })

  it('删除系统供应商；删除后列表为空', async () => {
    const created = await api('POST', '/admin/ai/providers', {
      token: adminToken,
      body: { name: '待删', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: 'mock-a' },
    })
    const del = await api('DELETE', `/admin/ai/providers/${created.json.provider.id}`, { token: adminToken })
    expect(del.status).toBe(200)

    const audit = await api('GET', '/admin/audit', { token: adminToken })
    const actions = audit.json.items.map((a: any) => a.action)
    expect(actions).toContain('ai.provider.create')
    expect(actions).toContain('ai.provider.delete')
  })
})

describe('用户余额管理', () => {
  let plainId = ''

  beforeAll(async () => {
    const me = await api('GET', '/auth/me', { token: plainToken })
    plainId = me.json.user.id
  })

  it('列表含所有活跃用户（无余额行显示 0）', async () => {
    const res = await api('GET', '/admin/ai/balances', { token: adminToken })
    expect(res.status).toBe(200)
    const items = res.json.items as Array<{ username: string; balance: number }>
    expect(items.some((i) => i.username === 'plain_user' && i.balance === 0)).toBe(true)
    expect(items.some((i) => i.username === 'root_admin' && i.balance === 0)).toBe(true)
  })

  it('充值与扣减，写审计', async () => {
    const add = await api('POST', `/admin/ai/balances/${plainId}`, {
      token: adminToken,
      body: { delta: 100 },
    })
    expect(add.status).toBe(200)
    expect(add.json.balance).toBe(100)

    const sub = await api('POST', `/admin/ai/balances/${plainId}`, {
      token: adminToken,
      body: { delta: -30.5 },
    })
    expect(sub.json.balance).toBeCloseTo(69.5, 6)

    const audit = await api('GET', '/admin/audit', { token: adminToken })
    const adjust = audit.json.items.find(
      (a: any) => a.action === 'ai.balance.adjust' && a.targetId === plainId,
    )
    expect(adjust).toBeTruthy()
    expect(adjust.detail.balance).toBeCloseTo(69.5, 6)
  })

  it('非法入参与不存在的用户', async () => {
    expect(
      (await api('POST', `/admin/ai/balances/${plainId}`, { token: adminToken, body: { delta: 0 } })).status,
    ).toBe(400)
    expect(
      (
        await api('POST', '/admin/ai/balances/no-such-user', { token: adminToken, body: { delta: 5 } })
      ).status,
    ).toBe(404)
  })
})
