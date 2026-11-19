import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

/**
 * 一体化版免密码登录：验证握手令牌校验、owner 账号自动创建与重复登录复用同一账号。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-local-'))
const LOCAL_TOKEN = 'local-handshake-token-0123456789abcdef'
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.LOG_LEVEL = 'fatal'
process.env.REGISTRATION_MODE = 'closed'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'
process.env.LOCAL_MODE = 'true'
process.env.LOCAL_AUTH_TOKEN = LOCAL_TOKEN
process.env.LAN_ENABLED = 'true'

let app: FastifyInstance

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function localLogin(
  token: string | null,
  deviceId = 'dev-local',
): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/local',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-local-token': token }),
    },
    payload: JSON.stringify({ device: device(deviceId) }),
  })
  return { status: res.statusCode, json: res.json() }
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  // 先关掉 SQLite 连接，否则 Windows 上文件仍被占用无法清理
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响测试结果 */
  }
})

describe('本地模式登录', () => {
  it('令牌正确时自动建号并返回会话', async () => {
    const res = await localLogin(LOCAL_TOKEN)
    expect(res.status).toBe(200)
    expect(res.json.user.username).toBe('owner')
    expect(res.json.user.isAdmin).toBe(true)
    expect(res.json.tokens.accessToken).toEqual(expect.any(String))
    expect(res.json.tokens.refreshToken).toEqual(expect.any(String))
  })

  it('再次登录复用同一账号', async () => {
    const first = await localLogin(LOCAL_TOKEN, 'dev-a')
    const second = await localLogin(LOCAL_TOKEN, 'dev-b')
    expect(second.status).toBe(200)
    expect(second.json.user.id).toBe(first.json.user.id)
  })

  it('令牌错误或缺失一律拒绝', async () => {
    expect((await localLogin('wrong-token-wrong-token-wrong-token')).status).toBe(401)
    expect((await localLogin(null)).status).toBe(401)
  })

  it('换来的 access token 能正常访问受保护接口', async () => {
    const session = await localLogin(LOCAL_TOKEN)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${session.json.tokens.accessToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.username).toBe('owner')
  })

  it('注册关闭时也能直接进入，且不能再用密码登录该账号', async () => {
    const session = await localLogin(LOCAL_TOKEN)
    expect(session.status).toBe(200)

    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        username: 'someone',
        password: 'pass12345',
        displayName: '路人',
        device: device('dev-x'),
      }),
    })
    expect(register.statusCode).toBe(403)

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'owner', password: 'pass12345', device: device('dev-x') }),
    })
    expect(login.statusCode).toBe(401)
  })
})

describe('手机扫码配对', () => {
  async function issueCode(): Promise<string> {
    const session = await localLogin(LOCAL_TOKEN)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pair/code',
      headers: { authorization: `Bearer ${session.json.tokens.accessToken}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json().code as string
  }

  async function pair(code: string, deviceId = 'phone'): Promise<{ status: number; json: any }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pair',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ code, device: device(deviceId) }),
    })
    return { status: res.statusCode, json: res.json() }
  }

  it('未登录拿不到配对码', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/pair/code' })
    expect(res.statusCode).toBe(401)
  })

  it('配对码换到的会话属于电脑端同一个账号', async () => {
    const code = await issueCode()
    const local = await localLogin(LOCAL_TOKEN)
    const paired = await pair(code)

    expect(paired.status).toBe(200)
    expect(paired.json.user.id).toBe(local.json.user.id)
    expect(paired.json.user.username).toBe('owner')
  })

  it('配对码一次性，用过即失效', async () => {
    const code = await issueCode()
    expect((await pair(code, 'phone-a')).status).toBe(200)
    expect((await pair(code, 'phone-b')).status).toBe(401)
  })

  it('不存在的配对码一律拒绝', async () => {
    expect((await pair('ZZZZZZ')).status).toBe(401)
    // 长度不合法的码在参数校验阶段就被挡掉
    expect((await pair('abc')).status).toBe(400)
  })
})
