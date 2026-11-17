import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DB } from '../src/db'

const DAY = 24 * 60 * 60 * 1000

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-gc-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let db: DB
let token = ''
let userId = ''
const filesRoot = path.join(dataDir, 'files')

function pngBuffer(padding: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([header, Buffer.alloc(padding, padding % 200 || 1)])
}

function multipartBody(buffer: Buffer, filename: string, mime: string): { body: Buffer; boundary: string } {
  const boundary = '----nenochatGcBoundary'
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
): Promise<{ id: string; url: string; storageKey: string }> {
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
  const attachment = (res.json() as { attachment: { id: string; url: string } }).attachment
  return {
    id: attachment.id,
    url: attachment.url,
    storageKey: attachment.url.replace(/^\/files\//, ''),
  }
}

function fileExists(storageKey: string): boolean {
  return fs.existsSync(path.join(filesRoot, storageKey))
}

function ageFile(storageKey: string, at: number): void {
  const date = new Date(at)
  fs.utimesSync(path.join(filesRoot, storageKey), date, date)
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
      username: 'gc_user',
      password: 'pass12345',
      displayName: '回收用户',
      device: { id: 'dev-gc', name: '设备', platform: 'win32', appVersion: '0.1.0' },
    }),
  })
  const registered = reg.json() as { user: { id: string }; tokens: { accessToken: string } }
  userId = registered.user.id
  token = registered.tokens.accessToken
})

afterAll(async () => {
  await app.close()
  const { closeDb } = await import('../src/db')
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('提取附件引用', () => {
  it('从相对或绝对 URL 中取出 storage_key', async () => {
    const { extractStorageKey } = await import('../src/services/attachment-gc')
    expect(extractStorageKey('/files/files/ab/cd/x.png')).toBe('files/ab/cd/x.png')
    expect(extractStorageKey('http://localhost:8787/files/avatars/aa/bb/y.png?v=1')).toBe(
      'avatars/aa/bb/y.png',
    )
    expect(extractStorageKey('https://example.com/image.png')).toBeNull()
    expect(extractStorageKey(null)).toBeNull()
  })

  it('解析消息 meta 里的附件与缩略图', async () => {
    const { extractMessageAttachmentKeys } = await import('../src/services/attachment-gc')
    const keys = extractMessageAttachmentKeys(
      JSON.stringify({
        attachments: [
          { url: '/files/files/ab/cd/a.png', thumbUrl: '/files/files/ab/cd/a_thumb.png' },
          { url: 'https://cdn.example.com/b.png' },
        ],
      }),
    )
    expect(keys).toEqual(['files/ab/cd/a.png', 'files/ab/cd/a_thumb.png'])
    expect(extractMessageAttachmentKeys('not json')).toEqual([])
    expect(extractMessageAttachmentKeys(null)).toEqual([])
  })

  it('孤儿文件需要同时满足无引用与超过宽限期', async () => {
    const { findOrphanFiles } = await import('../src/services/attachment-gc')
    const now = 10 * DAY
    const files = [
      { storageKey: 'a', size: 1, mtimeMs: now - 2 * DAY },
      { storageKey: 'b', size: 1, mtimeMs: now - 2 * DAY },
      { storageKey: 'fresh', size: 1, mtimeMs: now },
    ]
    const orphans = findOrphanFiles(files, new Set(['a']), { now, minAgeMs: DAY })
    expect(orphans.map((file) => file.storageKey)).toEqual(['b'])
  })
})

describe('附件回收', () => {
  it('保留被引用的附件，回收无人引用与磁盘孤儿文件', async () => {
    const now = Date.now()

    // 头像：被 users.avatar_url 引用
    const avatar = await upload(pngBuffer(16), 'avatar.png', 'image/png')
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatar.url, userId)

    // 消息附件：被 meta.attachments 引用
    const messageFile = await upload(Buffer.from('# 角色卡正文'), 'card.md', 'text/markdown', 'file')
    db.prepare(
      `INSERT INTO conversations (id, type, created_at, updated_at) VALUES ('gc-conv', 'direct', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, sender_type, type, content, meta, seq, created_at, updated_at)
       VALUES ('gc-msg', 'gc-conv', 'user', 'file', '', ?, 1, ?, ?)`,
    ).run(
      JSON.stringify({
        attachments: [
          { id: 'x', kind: 'file', filename: 'card.md', mime: 'text/markdown', size: 1, url: messageFile.url },
        ],
      }),
      now,
      now,
    )

    // 宽限期内的无引用附件：这次不能删
    const fresh = await upload(pngBuffer(32), 'fresh.png', 'image/png')

    // 超过宽限期的无引用附件：行与文件都该被回收
    const stale = await upload(pngBuffer(48), 'stale.png', 'image/png')
    const old = now - 3 * DAY
    db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?').run(old, stale.id)
    ageFile(stale.storageKey, old)

    // 磁盘孤儿：库里没有对应行
    const orphanKey = 'files/zz/yy/orphan.png'
    fs.mkdirSync(path.dirname(path.join(filesRoot, orphanKey)), { recursive: true })
    fs.writeFileSync(path.join(filesRoot, orphanKey), pngBuffer(8))
    ageFile(orphanKey, old)

    // 新写入但未被库引用的磁盘文件：宽限期内保留
    const youngKey = 'files/zz/yy/young.png'
    fs.writeFileSync(path.join(filesRoot, youngKey), pngBuffer(9))

    const { reclaimAttachments } = await import('../src/services/attachment-gc')
    const result = reclaimAttachments(db, { filesRoot, now, minAgeMs: DAY })

    expect(result.removedRows).toBe(1)
    expect(fileExists(avatar.storageKey)).toBe(true)
    expect(fileExists(messageFile.storageKey)).toBe(true)
    expect(fileExists(fresh.storageKey)).toBe(true)
    expect(fileExists(stale.storageKey)).toBe(false)
    expect(fileExists(orphanKey)).toBe(false)
    expect(fileExists(youngKey)).toBe(true)

    const staleRow = db.prepare('SELECT id FROM attachments WHERE id = ?').get(stale.id)
    expect(staleRow).toBeUndefined()
    expect(result.freedBytes).toBeGreaterThan(0)
  })

  it('没有孤儿时重复执行是幂等的', async () => {
    const { reclaimAttachments } = await import('../src/services/attachment-gc')
    const first = reclaimAttachments(db, { filesRoot })
    const second = reclaimAttachments(db, { filesRoot })
    expect(first.removedRows).toBe(0)
    expect(first.removedFiles).toBe(0)
    expect(second.removedRows).toBe(0)
    expect(second.removedFiles).toBe(0)
  })
})
