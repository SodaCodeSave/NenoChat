import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 管理面板·邀请码与服务器运行时设置。
 * 运行时设置改完必须立刻反映到注册流程与 /server/info（env 只是兜底）。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-admin-settings-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'
// env 初始值：open —— 面板没改过时应保持该行为
process.env.REGISTRATION_MODE = 'open'
process.env.SERVER_NAME = 'EnvName'

let app: FastifyInstance
let adminToken = ''

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

async function tryRegister(username: string, inviteCode?: string) {
  return await api('POST', '/auth/register', {
    body: {
      username,
      password: 'pass12345',
      displayName: username,
      device: device(`dev-${username}`),
      ...(inviteCode ? { inviteCode } : {}),
    },
  })
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const admin = await tryRegister('root_admin')
  expect(admin.status).toBe(200)
  adminToken = admin.json.tokens.accessToken
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

describe('管理面板·服务器运行时设置', () => {
  it('未修改时回落 env 值', async () => {
    const settings = await api('GET', '/admin/settings', { token: adminToken })
    expect(settings.status).toBe(200)
    expect(settings.json.serverName).toBe('EnvName')
    expect(settings.json.registrationMode).toBe('open')
    expect(settings.json.env.registrationMode).toBe('open')

    const info = await api('GET', '/server/info')
    expect(info.json.name).toBe('EnvName')
    expect(info.json.registration.inviteRequired).toBe(false)
  })

  it('改名与改注册模式立即生效到 /server/info 与注册流程', async () => {
    const patch = await api('PATCH', '/admin/settings', {
      token: adminToken,
      body: { serverName: '面板命名', registrationMode: 'closed' },
    })
    expect(patch.status).toBe(200)
    expect(patch.json.serverName).toBe('面板命名')
    expect(patch.json.registrationMode).toBe('closed')

    const info = await api('GET', '/server/info')
    expect(info.json.name).toBe('面板命名')
    expect(info.json.registration.open).toBe(false)

    const refused = await tryRegister('late_user_1')
    expect(refused.status).toBe(403)
    expect(refused.json.error.message).toContain('关闭注册')
  })

  it('invite 模式：无邀请码拒注、有效邀请码放行并计数', async () => {
    const switchMode = await api('PATCH', '/admin/settings', {
      token: adminToken,
      body: { registrationMode: 'invite' },
    })
    expect(switchMode.status).toBe(200)

    const noCode = await tryRegister('late_user_2')
    expect(noCode.status).toBe(400)

    const created = await api('POST', '/admin/invites', {
      token: adminToken,
      body: { maxUses: 2 },
    })
    expect(created.status).toBe(200)
    const code = created.json.invite.code as string
    expect(code.length).toBeGreaterThanOrEqual(8)

    const withCode = await tryRegister('late_user_3', code)
    expect(withCode.status).toBe(200)

    const list = await api('GET', '/admin/invites', { token: adminToken })
    const row = list.json.invites.find((i: any) => i.code === code)
    expect(row.uses).toBe(1)
    expect(row.maxUses).toBe(2)
    expect(row.createdByName).toBe('root_admin')
  })

  it('邀请码用尽后拒绝注册；删除邀请码后同样拒绝', async () => {
    const created = await api('POST', '/admin/invites', {
      token: adminToken,
      body: { maxUses: 1, expiresInDays: 7 },
    })
    const code = created.json.invite.code as string
    expect(created.json.invite.expiresAt).toBeGreaterThan(Date.now() - 1000)

    await expect(tryRegister('late_user_4', code)).resolves.toMatchObject({ status: 200 })
    const exhausted = await tryRegister('late_user_5', code)
    expect(exhausted.status).toBe(400)

    const del = await api('DELETE', `/admin/invites/${code}`, { token: adminToken })
    expect(del.status).toBe(200)
    const gone = await tryRegister('late_user_6', code)
    expect(gone.status).toBe(400)
  })

  it('参数校验：空服务器名与非法注册模式被拒', async () => {
    const emptyName = await api('PATCH', '/admin/settings', {
      token: adminToken,
      body: { serverName: '   ' },
    })
    expect(emptyName.status).toBe(400)

    const badMode = await api('PATCH', '/admin/settings', {
      token: adminToken,
      body: { registrationMode: 'chaos' },
    })
    expect(badMode.status).toBe(400)
  })

  it('设置变更写入审计日志', async () => {
    const audit = await api('GET', '/admin/audit', { token: adminToken })
    const actions = audit.json.items.map((a: any) => a.action)
    expect(actions).toContain('settings.update')
    expect(actions).toContain('invite.create')
    expect(actions).toContain('invite.delete')
  })
})
