import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { one, type DB } from '../src/db'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-files-'))
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
  const boundary = '----nenochatTestBoundary'
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
  kind: 'avatar' | 'file' = 'avatar',
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
      username: 'files_user',
      password: 'pass12345',
      displayName: '上传用户',
      device: { id: 'dev-files', name: '设备', platform: 'win32', appVersion: '0.1.0' },
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

describe('文件上传', () => {
  it('头像上传成功并返回相对路径', async () => {
    const res = await upload(pngBuffer(), 'a.png', 'image/png')
    expect(res.status).toBe(200)
    expect(res.json.attachment.url).toMatch(/^\/files\/avatars\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
    expect(res.json.attachment.kind).toBe('avatar')

    // 静态目录可直接读回
    const fetched = await app.inject({ method: 'GET', url: res.json.attachment.url })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.headers['content-type']).toContain('image/png')
  })

  it('同一用户重复上传同一文件返回同一附件', async () => {
    const buffer = pngBuffer(64)
    const first = await upload(buffer, 'dup.png', 'image/png')
    const second = await upload(buffer, 'dup2.png', 'image/png')
    expect(second.json.attachment.id).toBe(first.json.attachment.id)
  })

  it('去重命中但文件丢失时重新补盘，不再返回 404', async () => {
    const { dataDir: dataDirOf } = await import('../src/db')
    const buffer = pngBuffer(96)
    const first = await upload(buffer, 'heal.png', 'image/png')
    expect(first.status).toBe(200)
    const url = first.json.attachment.url as string

    // 模拟容器重建丢盘：把已入库的文件从磁盘删掉
    const diskPath = path.join(dataDirOf(), 'files', url.slice('/files/'.length))
    rmSync(diskPath)
    const broken = await app.inject({ method: 'GET', url })
    expect(broken.statusCode).toBe(404)

    // 同一内容重新上传：去重命中已入库行，但必须把文件补写回来
    const again = await upload(buffer, 'heal.png', 'image/png')
    expect(again.status).toBe(200)
    expect(again.json.attachment.id).toBe(first.json.attachment.id)

    const fetched = await app.inject({ method: 'GET', url })
    expect(fetched.statusCode).toBe(200)
  })

  it('内容与类型不符的头像被拒绝', async () => {
    const res = await upload(Buffer.from('not an image at all'), 'fake.png', 'image/png')
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('VALIDATION')
  })

  it('不支持的 mime 被拒绝', async () => {
    const res = await upload(Buffer.from('<svg/>'), 'a.svg', 'image/svg+xml')
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('VALIDATION')
  })

  it('超过 10MB 的头像被拒绝', async () => {
    const big = Buffer.concat([pngBuffer(0), Buffer.alloc(10 * 1024 * 1024, 0x02)])
    const res = await upload(big, 'big.png', 'image/png')
    expect(res.status).toBe(413)
  })

  it('角色卡文本可上传为普通文件', async () => {
    const res = await upload(Buffer.from('# 角色卡\n你住在旧书店楼上。'), 'card.md', 'text/markdown', 'file')
    expect(res.status).toBe(200)
    expect(res.json.attachment.kind).toBe('file')
    expect(res.json.attachment.mime).toBe('text/markdown')
  })

  it('attachments 表落了一条可追溯记录', async () => {
    const row = (await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM attachments'))!
    expect(row.c).toBeGreaterThan(0)
  })
})
