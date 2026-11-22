import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
// 这两个插件模块不读 env，静态导入不会抢在 env 设置之前初始化
import { resetForTests as resetIpLimit } from '../src/http/plugins/rate-limit'
import { resetForTests as resetLoginThrottle } from '../src/http/plugins/login-throttle'

/**
 * 登录安全加固：
 * - 改密吊销其他设备的 refresh token（保留改密发起端）
 * - 登录失败按账号维度限流（403 禁用不计入，成功清零）
 * - 管理员登录（成功/失败）写审计日志，普通用户不写
 *
 * 本文件共用一个数据库，文件级 beforeAll 先注册 sec_root 独占「首个用户=管理员」，
 * 其余用例一律使用普通账号，避免互相争夺首个用户身份。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-auth-sec-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.REGISTRATION_MODE = 'open'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance

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

interface AuthUser {
  id: string
  username: string
  isAdmin?: boolean
}

interface AuthBody {
  user: AuthUser
  tokens: { accessToken: string; refreshToken: string; expiresIn: number }
}

interface Session {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

/** 登录接口的原始返回：tokens 在 tokens 字段里，不与 register 的扁平 Session 混用 */
async function login(
  username: string,
  password: string,
  deviceId: string,
): Promise<{ status: number; json: AuthBody & { error?: { code: string; message: string } } }> {
  return await api('POST', '/auth/login', { body: { username, password, device: device(deviceId) } })
}

async function register(username: string, deviceId: string): Promise<Session> {
  const res = await api<AuthBody>('POST', '/auth/register', {
    body: { username, password: 'pass12345', displayName: username, device: device(deviceId) },
  })
  if (res.status !== 200) throw new Error(`注册失败: ${JSON.stringify(res.json)}`)
  return { ...res.json.tokens, user: res.json.user }
}

/** 文件级管理员：本文件第一个注册的用户，供禁用/启用与审计用例使用 */
let admin: Session

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()
  admin = await register('sec_root', 'dev-root')
  expect(admin.user.isAdmin).toBe(true)
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  await closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响测试结果 */
  }
})

describe('改密吊销其他设备会话', () => {
  it('其他设备的 refresh token 失效，改密发起端保留登录态', async () => {
    const main = await register('sec_alice', 'dev-main')
    const other = await login('sec_alice', 'pass12345', 'dev-other')
    expect(other.status).toBe(200)

    const change = await api('POST', '/users/me/password', {
      token: main.accessToken,
      body: { oldPassword: 'pass12345', newPassword: 'newpass12345' },
    })
    expect(change.status).toBe(200)

    // 其他设备：旧 refresh token 已被吊销
    const stale = await api('POST', '/auth/refresh', {
      body: { refreshToken: other.json.tokens.refreshToken, device: device('dev-other') },
    })
    expect(stale.status).toBe(401)

    // 发起改密的设备：会话保留
    const kept = await api<AuthBody>('POST', '/auth/refresh', {
      body: { refreshToken: main.refreshToken, device: device('dev-main') },
    })
    expect(kept.status).toBe(200)

    // 旧密码失效，新密码可登录
    expect((await login('sec_alice', 'pass12345', 'dev-x')).status).toBe(401)
    expect((await login('sec_alice', 'newpass12345', 'dev-x')).status).toBe(200)
  })
})

describe('账号维度登录失败限流', () => {
  it('连续失败达到上限后，即使密码正确也拒绝', async () => {
    await register('sec_brute', 'dev-brute')
    resetLoginThrottle()
    resetIpLimit()

    // 前 10 次错误密码逐一放行（每次都真验 argon2），第 10 次失败后计数到顶
    for (let i = 0; i < 10; i += 1) {
      const res = await login('sec_brute', 'not-the-password', 'dev-brute')
      expect(res.status).toBe(401)
    }

    // IP 限流已重置，这里的 429 只能来自账号维度限流
    resetIpLimit()
    const blocked = await login('sec_brute', 'pass12345', 'dev-brute')
    expect(blocked.status).toBe(429)
    expect(blocked.json.error?.code).toBe('RATE_LIMITED')
    expect(blocked.json.error?.message).toContain('登录失败次数过多')

    // 别的账号不受该账号计数影响
    const innocent = await register('sec_innocent', 'dev-innocent')
    const ok = await login('sec_innocent', 'pass12345', 'dev-innocent')
    expect(ok.status).toBe(200)
    expect(ok.json.user.id).toBe(innocent.user.id)
  })

  it('禁用账号的 403 不计入失败，解锁后正常登录不被误伤', async () => {
    const victim = await register('sec_lock', 'dev-lock')
    resetLoginThrottle()
    resetIpLimit()

    for (let i = 0; i < 9; i += 1) {
      expect((await login('sec_lock', 'wrong-password', 'dev-lock')).status).toBe(401)
    }

    const disable = await api('POST', `/admin/users/${victim.user.id}/disable`, { token: admin.accessToken })
    expect(disable.status).toBe(200)
    // 403 是「账号被禁用」而非「密码没猜对」，不该累加失败计数
    expect((await login('sec_lock', 'wrong-password', 'dev-lock')).status).toBe(403)

    const enable = await api('POST', `/admin/users/${victim.user.id}/enable`, { token: admin.accessToken })
    expect(enable.status).toBe(200)
    // 若 403 被计入，这就是第 11 次尝试，会被账号限流 429 拦下；
    // 重置 IP 限流，确保 429（若有）只能来自账号维度
    resetIpLimit()
    expect((await login('sec_lock', 'pass12345', 'dev-lock')).status).toBe(200)
  })

  it('登录成功清零计数，偶失误操作不会被历史失败惩罚', async () => {
    await register('sec_slip', 'dev-slip')
    resetLoginThrottle()
    resetIpLimit()

    for (let i = 0; i < 5; i += 1) {
      expect((await login('sec_slip', 'wrong-password', 'dev-slip')).status).toBe(401)
    }
    expect((await login('sec_slip', 'pass12345', 'dev-slip')).status).toBe(200)

    // 成功已清零：再来 5 次失败 + 1 次成功仍在账号限额内；
    // 中途重置 IP 限流，排除「单文件一分钟内登录请求超 10 次」的干扰
    resetIpLimit()
    for (let i = 0; i < 5; i += 1) {
      expect((await login('sec_slip', 'wrong-password', 'dev-slip')).status).toBe(401)
    }
    expect((await login('sec_slip', 'pass12345', 'dev-slip')).status).toBe(200)
  })
})

describe('管理员登录审计', () => {
  async function auditEntries(): Promise<Array<{ actorId: string; targetId: string | null; detail: any }>> {
    const { getDb } = await import('../src/db')
    const audit = await import('../src/db/repo/admin-audit')
    const { items } = await audit.listPage(getDb(), 1, 100)
    return items
      .filter((e) => e.action === 'admin.login')
      .map((e) => ({ actorId: e.actorId, targetId: e.targetId, detail: e.detail as any }))
  }

  it('管理员登录成功与失败都写审计，普通用户与不存在用户不写', async () => {
    await register('sec_audit_user', 'dev-audit-user')
    resetIpLimit()

    // 文件级管理员 sec_root 的登录
    expect((await login('sec_root', 'pass12345', 'dev-root-audit')).status).toBe(200)
    expect((await login('sec_root', 'wrong-password', 'dev-root-audit')).status).toBe(401)
    expect((await login('sec_audit_user', 'pass12345', 'dev-audit-user')).status).toBe(200)
    // 不存在的用户名也走一遍哑校验：同样 401、同样文案
    const ghost = await login('sec_ghost', 'whatever-password', 'dev-x')
    expect(ghost.status).toBe(401)
    expect(ghost.json.error?.message).toContain('用户名或密码不正确')

    const entries = await auditEntries()
    const successes = entries.filter((e) => e.targetId === admin.user.id && e.detail?.ok === true)
    const failures = entries.filter((e) => e.targetId === admin.user.id && e.detail?.ok === false)
    expect(successes.length).toBe(1)
    expect(failures.length).toBe(1)
    expect(failures[0].detail.ip).toEqual(expect.any(String))

    // 普通用户的登录与失败尝试都不产生审计
    const all = await auditEntries()
    expect(all.every((e) => e.actorId !== 'sec_audit_user')).toBe(true)
  })
})
