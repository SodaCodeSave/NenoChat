import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { one, type DB } from '../src/db'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-user-settings-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''
let db: DB

/** 最小 PNG：只需要前 8 字节通过魔数校验 */
function pngBuffer(padding = 32): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([header, Buffer.alloc(padding, 0x01)])
}

function multipartBody(buffer: Buffer, filename: string, mime: string): { body: Buffer; boundary: string } {
  const boundary = '----nenochatSettingsBoundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, buffer, tail]), boundary }
}

async function upload(
  buffer: Buffer,
  filename: string,
  mime: string,
  kind: string,
): Promise<{ status: number; json: any }> {
  const { body, boundary } = multipartBody(buffer, filename, mime)
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/files?kind=${kind}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  })
  return { status: res.statusCode, json: res.json() }
}

async function patchSettings(
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })
  return { status: res.statusCode, json: res.json() }
}

async function meSettings(): Promise<any> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { settings: any }).settings
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const { getDb } = await import('../src/db')
  db = getDb()

  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      username: 'settings_user',
      password: 'pass12345',
      displayName: '设置用户',
      device: { id: 'dev-settings', name: '设备', platform: 'win32', appVersion: '0.1.0' },
    }),
  })
  token = (reg.json() as { tokens: { accessToken: string } }).tokens.accessToken
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  await closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('用户设置 PATCH /settings', () => {
  it('设置聊天背景与主色后生效', async () => {
    const res = await patchSettings({ chatBgUrl: '/files/bg/x/y/hash.png', chatBgAccent: '#7c5cff' })
    expect(res.status).toBe(200)
    expect(res.json.settings.chatBgUrl).toBe('/files/bg/x/y/hash.png')
    expect(res.json.settings.chatBgAccent).toBe('#7c5cff')
  })

  it('GET /auth/me 回读背景设置', async () => {
    const settings = await meSettings()
    expect(settings.chatBgUrl).toBe('/files/bg/x/y/hash.png')
    expect(settings.chatBgAccent).toBe('#7c5cff')
  })

  it('未传字段保持原值', async () => {
    const res = await patchSettings({ chatBgAccent: '#16a34a' })
    expect(res.status).toBe(200)
    expect(res.json.settings.chatBgUrl).toBe('/files/bg/x/y/hash.png')
    expect(res.json.settings.chatBgAccent).toBe('#16a34a')
  })

  it('传 null 清除背景', async () => {
    const res = await patchSettings({ chatBgUrl: null, chatBgAccent: null })
    expect(res.status).toBe(200)
    expect(res.json.settings.chatBgUrl).toBeNull()
    expect(res.json.settings.chatBgAccent).toBeNull()
  })

  it('非法主色被拒绝', async () => {
    const res = await patchSettings({ chatBgAccent: 'red' })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('VALIDATION')
  })

  it('超长 URL 被拒绝', async () => {
    const res = await patchSettings({ chatBgUrl: '/files/' + 'x'.repeat(600) })
    expect(res.status).toBe(400)
  })

  it('未登录被拒绝', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ chatBgAccent: '#7c5cff' }),
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('背景图上传 kind=background', () => {
  it('图片上传成功且落在 backgrounds 目录', async () => {
    const res = await upload(pngBuffer(), 'bg.png', 'image/png', 'background')
    expect(res.status).toBe(200)
    expect(res.json.attachment.kind).toBe('background')
    expect(res.json.attachment.url).toMatch(
      /^\/files\/backgrounds\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/,
    )
  })

  it('非图片内容被拒绝', async () => {
    const res = await upload(Buffer.from('plain text'), 'bg.txt', 'text/plain', 'background')
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('VALIDATION')
  })
})

describe('背景附件的 GC 引用保护', () => {
  it('背景被引用时不回收，清除后宽限期外回收', async () => {
    const up = await upload(pngBuffer(48), 'gc-bg.png', 'image/png', 'background')
    expect(up.status).toBe(200)
    const attachment = up.json.attachment as { id: string; url: string }
    await patchSettings({ chatBgUrl: attachment.url, chatBgAccent: '#2f6bff' })

    // 未来的时钟：宽限期（24h）已过。背景仍被 user_settings 引用，附件行必须保留
    //（上面其它测试上传、无人引用的附件会被正常回收，removedRows 不为 0 属预期）
    const { reclaimAttachments } = await import('../src/services/attachment-gc')
    const future = Date.now() + 25 * 60 * 60 * 1000
    await reclaimAttachments(db, { now: future })
    const stillThere = await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM attachments WHERE id = ?', [
      attachment.id,
    ])
    expect(stillThere?.c).toBe(1)

    // 清除背景引用后再跑：行与磁盘文件都应回收
    await patchSettings({ chatBgUrl: null, chatBgAccent: null })
    const reclaimed = await reclaimAttachments(db, { now: future + 1000 })
    const gone = await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM attachments WHERE id = ?', [
      attachment.id,
    ])
    expect(gone?.c).toBe(0)
    expect(reclaimed.removedRows).toBeGreaterThan(0)
    expect(reclaimed.freedBytes).toBeGreaterThan(0)
  })
})
