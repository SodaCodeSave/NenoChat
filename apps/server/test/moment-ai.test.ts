import { testDatabaseUrl } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-moment-ai-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let upstream: Server
let upstreamPort = 0
let token = ''
let personaId = ''
let ownerPostId = ''

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
  level: 'fatal',
} as never

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  })
  return { status: res.statusCode, json: res.json() as T }
}

beforeAll(async () => {
  // 假的 OpenAI 兼容上游：评论与发帖都返回这一句
  upstream = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '这天气配这首曲子刚刚好。' } }],
          usage: { prompt_tokens: 10, completion_tokens: 12 },
        }),
      )
    })
  })

  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      const address = upstream.address()
      upstreamPort = typeof address === 'object' && address ? address.port : 0
      resolve()
    })
  })

  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      username: 'moment_user',
      password: 'pass12345',
      displayName: '广场用户',
      device: device('dev-moment'),
    }),
  })
  token = (reg.json() as { tokens: { accessToken: string } }).tokens.accessToken

  // 密钥托管在服务端，服务端才有能力自己跑动态互动
  const provider = await api<{ provider: { id: string } }>('POST', '/ai/providers', {
    name: 'mock',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    model: 'mock-model',
    apiKey: 'sk-mock-key-123456',
    keyLocation: 'server',
  })
  expect(provider.status).toBe(200)

  const persona = await api<{ persona: { id: string } }>('POST', '/ai/personas', {
    name: '小禾',
    systemPrompt: '你是朋友。',
    interests: ['独立音乐'],
    card: '你住在一间临街旧书店的楼上。',
    providerId: provider.json.provider.id,
  })
  personaId = persona.json.persona.id

  const post = await api<{ post: { id: string } }>('POST', '/posts', {
    content: '今天路过一家旧书店，闻到纸的味道。',
    attachmentIds: [],
  })
  ownerPostId = post.json.post.id
})

afterAll(async () => {
  await app.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  const { closeDb } = await import('../src/db')
  await closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

describe('角色在动态广场的自动互动', () => {
  it('关掉全局开关时什么都不做', async () => {
    const { getDb, one } = await import('../src/db')
    const { scanMomentsOnce } = await import('../src/services/moment-ai-service')
    const db = getDb()

    await scanMomentsOnce(db, silentLog, { random: () => 0 })

    const actions = (await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM ai_moment_actions'))!
    expect(actions.c).toBe(0)
  })

  it('打开后角色会点赞、评论并自己发一条动态', async () => {
    const { getDb, all } = await import('../src/db')
    const { scanMomentsOnce } = await import('../src/services/moment-ai-service')
    const db = getDb()

    const settings = await api<{ settings: { momentsEnabled: boolean } }>(
      'PATCH',
      '/ai/settings',
      { momentsEnabled: true, momentsPostsPerDay: 1, momentsCommentsPerDay: 2, momentsLikesPerDay: 2 },
    )
    expect(settings.json.settings.momentsEnabled).toBe(true)

    // random 恒为 0：所有概率判定都通过，pick 也稳定落在第一个候选。
    // 发动态只在本地 9~23 点的活跃时段进行；把扫描固定在中午，避免深夜跑测试时发帖被时段挡掉
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    await scanMomentsOnce(db, silentLog, { random: () => 0, now: noon.getTime() })

    const kinds = await all<{ kind: string; status: string }>(
      db,
      'SELECT kind, status FROM ai_moment_actions ORDER BY kind',
    )
    expect(kinds.map((row) => row.kind).sort()).toEqual(['comment', 'like', 'post'])
    expect(kinds.every((row) => row.status === 'done')).toBe(true)

    const commentResult = await api<{ comments: Array<{ personaId: string | null; content: string }> }>(
      'GET',
      `/posts/${ownerPostId}/comments`,
    )
    expect(commentResult.json.comments.some((comment) => comment.personaId === personaId)).toBe(true)

    const feed = await api<{ posts: Array<{ personaId: string | null; author: { displayName: string } }> }>(
      'GET',
      '/posts',
    )
    const personaPost = feed.json.posts.find((post) => post.personaId === personaId)
    expect(personaPost).toBeTruthy()
    expect(personaPost!.author.displayName).toBe('小禾')

    // 角色的赞算在动态上，但不该让主人以为是自己点的
    const detail = await api<{ post: { likeCount: number; likedByMe: boolean } }>(
      'GET',
      `/posts/${ownerPostId}`,
    )
    expect(detail.json.post.likeCount).toBeGreaterThanOrEqual(1)
    expect(detail.json.post.likedByMe).toBe(false)
  })

  it('同一角色不会对同一条动态重复评论，日额度用完后也不再动手', async () => {
    const { getDb, one, all } = await import('../src/db')
    const { scanMomentsOnce } = await import('../src/services/moment-ai-service')
    const db = getDb()

    const before = (await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM ai_moment_actions'))!
    await scanMomentsOnce(db, silentLog, { random: () => 0 })
    const after = (await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM ai_moment_actions'))!

    // 发动态与评论的日额度都是 1 / 2，已用满；点赞额度 2 条里还能再点一次现存的另一条
    expect(after.c - before.c).toBeLessThanOrEqual(1)

    const dupe = await all<{ c: number }>(
      db,
      `SELECT persona_id, post_id, COUNT(*) AS c FROM ai_moment_actions
         WHERE kind = 'comment' AND post_id <> ''
         GROUP BY persona_id, post_id HAVING COUNT(*) > 1`,
    )
    expect(dupe).toHaveLength(0)
  })

  it('角色可以在自己的动态下被 @ 之外的地方正常署名评论', async () => {
    const commentResult = await api<{ comments: Array<{ author: { displayName: string } }> }>(
      'GET',
      `/posts/${ownerPostId}/comments`,
    )
    const mine = commentResult.json.comments.find((comment) => comment.author.displayName === '小禾')
    expect(mine).toBeTruthy()
  })
})
