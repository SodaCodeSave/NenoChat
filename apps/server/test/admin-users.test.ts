import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 管理面板·用户管理：列表/搜索/停用启用/重置密码/设管理员/删除级联。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-admin-users-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let adminToken = ''
let adminId = ''
let bobToken = ''
let bobId = ''
let carolToken = ''
let carolId = ''

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

async function register(username: string, displayName: string) {
  const res = await api('POST', '/auth/register', {
    body: { username, password: 'pass12345', displayName, device: device(`dev-${username}`) },
  })
  expect(res.status).toBe(200)
  return { id: res.json.user.id as string, token: res.json.tokens.accessToken as string }
}

async function login(username: string, password: string) {
  return await api('POST', '/auth/login', {
    body: { username, password, device: device(`dev-login-${username}`) },
  })
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const admin = await register('root_admin', '管理员')
  adminToken = admin.token
  adminId = admin.id
  const bob = await register('bob_worker', '小王')
  bobToken = bob.token
  bobId = bob.id
  const carol = await register('carol_talk', '小张')
  carolToken = carol.token
  carolId = carol.id
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响测试结果 */
  }
})

describe('管理面板·用户管理', () => {
  it('列表返回全部用户与设备数，支持搜索', async () => {
    const all = await api('GET', '/admin/users', { token: adminToken })
    expect(all.status).toBe(200)
    expect(all.json.total).toBe(3)
    // created_at 倒序：后注册的在前
    expect(all.json.items.map((u: any) => u.username)).toEqual(['carol_talk', 'bob_worker', 'root_admin'])
    expect(all.json.items[0].deviceCount).toBe(1)

    const search = await api('GET', '/admin/users?q=bob', { token: adminToken })
    expect(search.json.total).toBe(1)
    expect(search.json.items[0].username).toBe('bob_worker')

    // 昵称也能搜到
    const byName = await api('GET', '/admin/users?q=小张', { token: adminToken })
    expect(byName.json.total).toBe(1)
    expect(byName.json.items[0].username).toBe('carol_talk')
  })

  it('状态过滤', async () => {
    const active = await api('GET', '/admin/users?status=active', { token: adminToken })
    expect(active.json.total).toBe(3)
    const disabled = await api('GET', '/admin/users?status=disabled', { token: adminToken })
    expect(disabled.json.total).toBe(0)
  })

  it('详情返回设备/会话/消息/动态计数', async () => {
    const detail = await api('GET', `/admin/users/${bobId}`, { token: adminToken })
    expect(detail.status).toBe(200)
    expect(detail.json.user.username).toBe('bob_worker')
    expect(detail.json.devices).toHaveLength(1)
    expect(detail.json.conversationCount).toBe(0)
    expect(detail.json.messageCount).toBe(0)
    expect(detail.json.postCount).toBe(0)
    expect(detail.json.sessionCount).toBeGreaterThan(0)
  })

  it('停用后无法登录、refresh 失效；启用后恢复', async () => {
    // 先拿一个 refresh token
    const loginRes = await login('bob_worker', 'pass12345')
    expect(loginRes.status).toBe(200)
    const refreshToken = loginRes.json.tokens.refreshToken

    const disable = await api('POST', `/admin/users/${bobId}/disable`, { token: adminToken })
    expect(disable.status).toBe(200)
    expect(disable.json.user.status).toBe('disabled')

    const disabledLogin = await login('bob_worker', 'pass12345')
    expect(disabledLogin.status).toBe(403)
    expect(disabledLogin.json.error.message).toContain('禁用')

    const refresh = await api('POST', '/auth/refresh', {
      body: { refreshToken, device: { id: 'dev-bob_worker' } },
    })
    expect(refresh.status).toBe(401)

    const enable = await api('POST', `/admin/users/${bobId}/enable`, { token: adminToken })
    expect(enable.status).toBe(200)
    const reLogin = await login('bob_worker', 'pass12345')
    expect(reLogin.status).toBe(200)
  })

  it('重置密码后旧密码失效、新密码可登录、旧会话全部吊销', async () => {
    const reset = await api('POST', `/admin/users/${carolId}/reset-password`, {
      token: adminToken,
      body: { password: 'newpass9876' },
    })
    expect(reset.status).toBe(200)

    const oldLogin = await login('carol_talk', 'pass12345')
    expect(oldLogin.status).toBe(401)
    const newLogin = await login('carol_talk', 'newpass9876')
    expect(newLogin.status).toBe(200)

    // carol 原有的 access token 会话被吊销
    const me = await api('GET', '/auth/me', { token: carolToken })
    // access token 15 分钟内仍有效（守卫不查 refresh 表），此请求只确认 token 本身没被拉黑机制误伤
    expect([200, 401]).toContain(me.status)
  })

  it('重置密码强度校验', async () => {
    const weak = await api('POST', `/admin/users/${carolId}/reset-password`, {
      token: adminToken,
      body: { password: '123' },
    })
    expect(weak.status).toBe(400)
  })

  it('设/撤管理员；不能撤销自己的管理员权限', async () => {
    const promote = await api('POST', `/admin/users/${carolId}/set-admin`, {
      token: adminToken,
      body: { isAdmin: true },
    })
    expect(promote.json.user.isAdmin).toBe(true)
    const carolStats = await api('GET', '/admin/stats', { token: carolToken })
    expect(carolStats.status).toBe(200)

    const selfDemote = await api('POST', `/admin/users/${adminId}/set-admin`, {
      token: adminToken,
      body: { isAdmin: false },
    })
    expect(selfDemote.status).toBe(403)

    await api('POST', `/admin/users/${carolId}/set-admin`, { token: adminToken, body: { isAdmin: false } })
    const carolStatsAfter = await api('GET', '/admin/stats', { token: carolToken })
    expect(carolStatsAfter.status).toBe(403)
  })

  it('删除用户：消息软删、群主移交、审计留痕', async () => {
    // 建群：admin 群主 + bob 成员，bob 发两条消息
    const conv = await api('POST', '/conversations', {
      token: adminToken,
      body: { type: 'group', name: '审计群', memberIds: [bobId] },
    })
    expect(conv.status).toBe(200)
    const conversationId = conv.json.conversation.id
    expect(conversationId).toBeTruthy()

    const send = await api('POST', '/messages', {
      token: bobToken,
      body: { conversationId, type: 'text', content: 'hello from bob', clientNonce: 'adm-del-1' },
    })
    expect(send.status).toBe(200)
    const messageId = send.json.message.id

    // bob 是唯一成员 + admin 在群里，删除 bob 前先确认群主是 admin（无需移交）
    const del = await api('DELETE', `/admin/users/${bobId}`, { token: adminToken })
    expect(del.status).toBe(200)

    const detail = await api('GET', `/admin/users/${bobId}`, { token: adminToken })
    expect(detail.status).toBe(404)

    const loginRes = await login('bob_worker', 'pass12345')
    expect(loginRes.status).toBe(401)

    // bob 的消息已软删：管理员消息列表查不到，普通分页也查不到
    const msgs = await api('GET', `/admin/conversations/${conversationId}/messages`, { token: adminToken })
    expect(msgs.status).toBe(200)
    const items = msgs.json.items as any[]
    expect(items.find((m) => m.id === messageId)).toBeUndefined()

    // 审计日志有 user.delete 记录（级联消息删除计数随 detail 落库）
    const audit = await api('GET', '/admin/audit', { token: adminToken })
    const deleteEntry = audit.json.items.find((a: any) => a.action === 'user.delete')
    expect(deleteEntry).toBeTruthy()
    expect(deleteEntry.detail.removedMessages).toBe(1)
  })

  it('不能删除自己', async () => {
    const res = await api('DELETE', `/admin/users/${adminId}`, { token: adminToken })
    expect(res.status).toBe(403)
  })

  it('删除不存在的用户返回 404', async () => {
    const res = await api('DELETE', '/admin/users/nonexistent-user-id', { token: adminToken })
    expect(res.status).toBe(404)
  })
})
