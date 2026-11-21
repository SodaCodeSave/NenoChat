import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 管理面板守卫：requireAdmin 的认证与授权边界。
 * 首个注册用户自动成为管理员；普通用户与未登录一律拒绝；
 * 管理员被停用后立即失去管理权限（守卫回库核对，不依赖 token 缓存）。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-admin-auth-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let adminToken = ''
let adminId = ''
let plainToken = ''
let plainId = ''

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

async function register(username: string): Promise<{ id: string; token: string }> {
  const res = await api('POST', '/auth/register', {
    body: { username, password: 'pass12345', displayName: username, device: device(`dev-${username}`) },
  })
  expect(res.status).toBe(200)
  return { id: res.json.user.id, token: res.json.tokens.accessToken }
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const admin = await register('root_admin')
  adminToken = admin.token
  adminId = admin.id
  const plain = await register('plain_user')
  plainToken = plain.token
  plainId = plain.id
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

describe('管理面板守卫', () => {
  it('首个注册用户自动成为管理员，能访问管理接口', async () => {
    const me = await api('GET', '/auth/me', { token: adminToken })
    expect(me.json.user.isAdmin).toBe(true)

    const stats = await api('GET', '/admin/stats', { token: adminToken })
    expect(stats.status).toBe(200)
    expect(stats.json.users.total).toBe(2)
  })

  it('未登录访问管理接口一律 401', async () => {
    const res = await api('GET', '/admin/stats')
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('UNAUTHENTICATED')
  })

  it('普通用户访问管理接口一律 403', async () => {
    const res = await api('GET', '/admin/stats', { token: plainToken })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('FORBIDDEN')
    expect(res.json.error.message).toContain('管理员')
  })

  it('普通用户自己不是管理员，也不能把自己提成管理员', async () => {
    const res = await api('POST', `/admin/users/${plainId}/set-admin`, {
      token: plainToken,
      body: { isAdmin: true },
    })
    expect(res.status).toBe(403)
  })

  it('管理员被停用后管理接口立即失效', async () => {
    // 提拔普通用户为第二管理员，再用第一管理员停用他
    const promote = await api('POST', `/admin/users/${plainId}/set-admin`, {
      token: adminToken,
      body: { isAdmin: true },
    })
    expect(promote.status).toBe(200)
    expect(promote.json.user.isAdmin).toBe(true)

    const before = await api('GET', '/admin/stats', { token: plainToken })
    expect(before.status).toBe(200)

    const disable = await api('POST', `/admin/users/${plainId}/disable`, { token: adminToken })
    expect(disable.status).toBe(200)

    // token 还在 15 分钟有效期内，但 status 已不是 active → 401
    const after = await api('GET', '/admin/stats', { token: plainToken })
    expect(after.status).toBe(401)

    // 恢复后重新可用
    const reEnable = await api('POST', `/admin/users/${plainId}/enable`, { token: adminToken })
    expect(reEnable.status).toBe(200)
    const restored = await api('GET', '/admin/stats', { token: plainToken })
    expect(restored.status).toBe(200)
  })

  it('管理员撤销普通用户的管理员身份后其 403', async () => {
    const revoke = await api('POST', `/admin/users/${plainId}/set-admin`, {
      token: adminToken,
      body: { isAdmin: false },
    })
    expect(revoke.status).toBe(200)
    const res = await api('GET', '/admin/stats', { token: plainToken })
    expect(res.status).toBe(403)
  })
})
