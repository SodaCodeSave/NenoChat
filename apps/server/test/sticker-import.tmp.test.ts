import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-sticker-import-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''

function pngBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 0x02),
  ])
}

function manifest(): string {
  return JSON.stringify({
    name: '永雏塔菲表情包',
    id: 'yctf-taffy',
    categories: {
      angry: { description: '塔菲生气、叉腰的场合，例如被惹到、佯装发火、表达不满时使用。' },
      happy: { description: '塔菲开心、笑、吃喝享受的场合，强调正反馈。' },
    },
  })
}

function buildZip(): Uint8Array {
  const png = pngBuffer()
  return zipSync({
    'yctf-taffy-meme-pack-main/manifest.json': new Uint8Array(Buffer.from(manifest())),
    'yctf-taffy-meme-pack-main/memes/angry/angry_01.png': new Uint8Array(png),
    'yctf-taffy-meme-pack-main/memes/happy/happy_01.png': new Uint8Array(png.subarray(0, 16)),
    'yctf-taffy-meme-pack-main/previews/cover.png': new Uint8Array(png),
  })
}

async function importZip(payload: Uint8Array) {
  const boundary = '----nenochatPackBoundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="pack.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return app.inject({
    method: 'POST',
    url: '/api/v1/stickers/import',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([head, Buffer.from(payload), tail]),
  })
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      username: 'pack_importer',
      password: 'pass12345',
      displayName: '导入者',
      device: { id: 'dev-pack', name: '设备', platform: 'win32', appVersion: '0.1.0' },
    }),
  })
  token = (res.json() as { tokens: { accessToken: string } }).tokens.accessToken
})

afterAll(async () => {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('AstrBot 表情包导入', () => {
  it('按 manifest 建分组并把分类写进关键词', async () => {
    const res = await importZip(buildZip())
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      pack: { id: string; name: string }
      imported: number
      skipped: number
    }
    expect(body.imported).toBe(2)
    expect(body.skipped).toBe(0)
    expect(body.pack.name).toBe('永雏塔菲表情包')

    const packs = await app.inject({
      method: 'GET',
      url: '/api/v1/stickers/packs',
      headers: { authorization: `Bearer ${token}` },
    })
    const list = (packs.json() as { packs: Array<{ pack: { id: string; name: string }; stickers: Array<{ keywords: string[] }> }> })
      .packs
    const imported = list.find((entry) => entry.pack.id === body.pack.id)!
    expect(imported.stickers).toHaveLength(2)
    expect(imported.stickers[0]!.keywords).toContain('angry')
    expect(imported.stickers[0]!.keywords).toContain('叉腰')
    expect(imported.stickers[1]!.keywords).toContain('happy')
  })

  it('同名分组自动加后缀，不覆盖已有包', async () => {
    const res = await importZip(buildZip())
    expect(res.statusCode).toBe(200)
    expect((res.json() as { pack: { name: string } }).pack.name).toBe('永雏塔菲表情包 (2)')
  })

  it('不是表情包时给出可读错误', async () => {
    const res = await importZip(zipSync({ 'a.txt': new Uint8Array(Buffer.from('hello')) }))
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { message: string } }).error.message).toContain('manifest.json')
  })

  it('真实 Compress-Archive 生成的 zip 也能导入', async () => {
    const zipPath = process.env.PACK_ZIP
    if (!zipPath) return
    const raw = readFileSync(zipPath)
    const res = await importZip(new Uint8Array(raw))
    expect(res.statusCode).toBe(200)
    const body = res.json() as { imported: number; skipped: number; pack: { name: string } }
    expect(body.pack.name).toBe('永雏塔菲表情包')
    expect(body.imported).toBe(3)
    expect(body.skipped).toBe(0)

    const packs = await app.inject({
      method: 'GET',
      url: '/api/v1/stickers/packs',
      headers: { authorization: `Bearer ${token}` },
    })
    const list = (packs.json() as { packs: Array<{ pack: { name: string }; stickers: Array<{ kind: string; keywords: string[] }> }> })
      .packs
    const imported = list.find((entry) => entry.pack.name === '永雏塔菲表情包')!
    expect(imported.stickers.every((s) => s.kind === 'gif')).toBe(true)
    expect(imported.stickers[0]!.keywords).toContain('angry')
  })
})
