import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ulid } from '@nenochat/shared'
import type { AiUsageStats } from '@nenochat/shared'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-usagestats-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

const HOUR = 3_600_000
const DAY = 86_400_000
const TZ_OFFSET = 480 // UTC+8

let app: FastifyInstance
let token = ''
let userId = ''
let db: import('pg').Pool

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

/** 直插一条 usage 记录，时间可控（insertUsage 固定用 now()，这里绕开） */
async function seedUsage(input: {
  ownerId: string
  kind: string
  model?: string | null
  personaId?: string | null
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  createdAt: number
}): Promise<void> {
  const { run } = await import('../src/db')
  await run(
    db,
    `INSERT INTO ai_usage_log
       (id, owner_id, conversation_id, persona_id, provider_id, kind, ref_id, model,
        prompt_tokens, completion_tokens, cached_tokens, created_at)
     VALUES (?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      input.ownerId,
      input.personaId ?? null,
      input.kind,
      input.model ?? null,
      input.promptTokens,
      input.completionTokens,
      input.cachedTokens ?? 0,
      input.createdAt,
    ],
  )
}

function decodeSub(tokenValue: string): string {
  const payload = JSON.parse(Buffer.from(tokenValue.split('.')[1], 'base64url').toString())
  return payload.sub as string
}

/** 与 repo 同公式：把种子记录按桶聚合，得到期望的 series */
function expectedSeries(
  seeds: Array<{ createdAt: number; promptTokens: number; completionTokens: number; cachedTokens?: number }>,
  from: number,
  bucketMs: number,
  offsetMs: number,
): Array<{ bucketStart: number; calls: number; promptTokens: number; completionTokens: number; cachedTokens: number }> {
  const buckets = new Map<number, { calls: number; promptTokens: number; completionTokens: number; cachedTokens: number }>()
  for (const seed of seeds) {
    if (seed.createdAt < from) continue
    const bucketStart = Math.floor((seed.createdAt + offsetMs) / bucketMs) * bucketMs - offsetMs
    const acc = buckets.get(bucketStart) ?? { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
    acc.calls += 1
    acc.promptTokens += seed.promptTokens
    acc.completionTokens += seed.completionTokens
    acc.cachedTokens += seed.cachedTokens ?? 0
    buckets.set(bucketStart, acc)
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, acc]) => ({ bucketStart, ...acc }))
}

interface SeedRow {
  createdAt: number
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
}

/** 7d 窗口内的种子记录（时间在播种时固定，断言直接复用） */
const inWindowSeeds: SeedRow[] = []

let personaId = ''
let deletedPersonaId = ''

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: {
      username: 'usagestats_user',
      password: 'pass12345',
      displayName: '用量统计测试',
      device: device('dev-usagestats'),
    },
  })
  token = reg.json.tokens.accessToken
  userId = decodeSub(token)

  const { getDb } = await import('../src/db')
  db = getDb()

  // 两个角色：一个保留、一个软删（行还在，join 仍能取到名字）
  personaId = (
    await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '统计酱', systemPrompt: '你是测试角色' },
    })
  ).json.persona.id
  deletedPersonaId = (
    await api<{ persona: { id: string } }>('POST', '/ai/personas', {
      token,
      body: { name: '被删酱', systemPrompt: '你也是测试角色' },
    })
  ).json.persona.id
  await api('DELETE', `/ai/personas/${deletedPersonaId}`, { token })

  const now = Date.now()
  // 7d 窗口内的记录：两个模型、四种功能、角色归属 + 一条无角色归属
  const seeds = [
    { kind: 'chat', model: 'm-big', personaId, promptTokens: 1000, completionTokens: 500, cachedTokens: 300, offset: 2 * HOUR },
    { kind: 'chat', model: 'm-big', personaId: deletedPersonaId, promptTokens: 600, completionTokens: 400, offset: 3 * HOUR },
    { kind: 'summary', model: 'm-small', personaId, promptTokens: 100, completionTokens: 50, offset: 1 * DAY },
    { kind: 'vision', model: 'm-small', personaId: null, promptTokens: 80, completionTokens: 20, offset: 3 * DAY },
    { kind: 'proactive', model: null, personaId: null, promptTokens: 10, completionTokens: 5, offset: 3 * DAY + HOUR },
  ]
  for (const seed of seeds) {
    const createdAt = now - seed.offset
    inWindowSeeds.push({
      createdAt,
      promptTokens: seed.promptTokens,
      completionTokens: seed.completionTokens,
      cachedTokens: seed.cachedTokens,
    })
    await seedUsage({
      ownerId: userId,
      kind: seed.kind,
      model: seed.model,
      personaId: seed.personaId,
      promptTokens: seed.promptTokens,
      completionTokens: seed.completionTokens,
      cachedTokens: seed.cachedTokens,
      createdAt,
    })
  }
  // 7d 窗口外（9 天前），30d 窗口内
  await seedUsage({ ownerId: userId, kind: 'chat', model: 'm-old', promptTokens: 99999, completionTokens: 99999, createdAt: now - 9 * DAY })
  // 其他用户的记录，不得计入
  const other = await api<{ tokens: { accessToken: string } }>('POST', '/auth/register', {
    body: {
      username: 'usagestats_other',
      password: 'pass12345',
      displayName: '其他用户',
      device: device('dev-usagestats-other'),
    },
  })
  await seedUsage({ ownerId: decodeSub(other.json.tokens.accessToken), kind: 'chat', model: 'm-big', promptTokens: 77777, completionTokens: 77777, createdAt: now - HOUR })
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

describe('GET /ai/usage/stats', () => {
  it('未登录返回 401', async () => {
    const res = await api('GET', '/ai/usage/stats?window=7d')
    expect(res.status).toBe(401)
  })

  it('非法 window 返回 400', async () => {
    const res = await api('GET', '/ai/usage/stats?window=99d', { token })
    expect(res.status).toBe(400)
  })

  it('7d 窗口：总量、分桶、按模型/功能/角色聚合与排序正确', async () => {
    const res = await api<{ stats: AiUsageStats }>('GET', `/ai/usage/stats?window=7d&tzOffset=${TZ_OFFSET}`, { token })
    expect(res.status).toBe(200)
    const stats = res.json.stats

    expect(stats.window).toBe('7d')
    expect(stats.bucketMs).toBe(DAY)
    // 起点对齐到本地日的零点
    expect((stats.from + TZ_OFFSET * 60_000) % DAY).toBe(0)
    expect(stats.to).lessThanOrEqual(Date.now() + 1000)

    // 总量只含窗口内自己的记录（9 天前的与其他用户的被排除）
    expect(stats.totals).toEqual({
      calls: 5,
      promptTokens: 1000 + 600 + 100 + 80 + 10,
      completionTokens: 500 + 400 + 50 + 20 + 5,
      cachedTokens: 300,
    })

    // series 与按同公式重算的分桶一致，且求和等于总量
    expect(stats.series).toEqual(expectedSeries(inWindowSeeds, stats.from, DAY, TZ_OFFSET * 60_000))
    const seriesPrompt = stats.series.reduce((sum, b) => sum + b.promptTokens, 0)
    expect(seriesPrompt).toBe(stats.totals.promptTokens)

    // 按模型：按输入+输出降序，null 模型保留
    expect(stats.byModel.map((row) => [row.model, row.calls])).toEqual([
      ['m-big', 2],
      ['m-small', 2],
      [null, 1],
    ])
    expect(stats.byModel[0]).toMatchObject({ promptTokens: 1600, completionTokens: 900, cachedTokens: 300 })

    // 按功能：chat 2 次、summary/vision/proactive 各 1 次
    expect(stats.byKind.map((row) => [row.kind, row.calls])).toEqual([
      ['chat', 2],
      ['summary', 1],
      ['vision', 1],
      ['proactive', 1],
    ])

    // 按角色：软删角色仍显示名称；无角色归属的记录排除
    expect(stats.byPersona.map((row) => [row.personaName, row.calls])).toEqual([
      ['统计酱', 2],
      ['被删酱', 1],
    ])
  })

  it('24h 窗口：每小时一桶，起点对齐整点且不受时区偏移影响', async () => {
    const res = await api<{ stats: AiUsageStats }>('GET', `/ai/usage/stats?window=24h&tzOffset=${TZ_OFFSET}`, { token })
    expect(res.status).toBe(200)
    const stats = res.json.stats

    expect(stats.bucketMs).toBe(HOUR)
    expect(stats.from % HOUR).toBe(0)
    // 2-3 小时前的两条必在窗口内；「24h 前」那条恰好落在对齐后的窗口边缘，按 from 动态推导
    const inWindow = inWindowSeeds.filter((seed) => seed.createdAt >= stats.from)
    expect(inWindow.length).toBeGreaterThanOrEqual(2)
    expect(stats.totals.calls).toBe(inWindow.length)
    expect(stats.totals.promptTokens).toBe(inWindow.reduce((sum, seed) => sum + seed.promptTokens, 0))
    expect(stats.series).toEqual(expectedSeries(inWindowSeeds, stats.from, HOUR, TZ_OFFSET * 60_000))
  })

  it('30d 窗口：纳入 7d 之外更早的记录，仍排除其他用户', async () => {
    const now = Date.now()
    await seedUsage({ ownerId: userId, kind: 'moment', model: 'm-small', promptTokens: 40, completionTokens: 60, createdAt: now - 20 * DAY })

    const res = await api<{ stats: AiUsageStats }>('GET', `/ai/usage/stats?window=30d&tzOffset=${TZ_OFFSET}`, { token })
    expect(res.status).toBe(200)
    const stats = res.json.stats

    expect(stats.bucketMs).toBe(DAY)
    // 5 条近期 + 9 天前 1 条 + 20 天前 1 条；其他用户的 77777 不计入
    expect(stats.totals.calls).toBe(7)
    expect(stats.totals.promptTokens).toBe(1000 + 600 + 100 + 80 + 10 + 99999 + 40)
    expect(stats.byModel.find((row) => row.model === 'm-old')).toMatchObject({ calls: 1 })
    expect(stats.byModel.find((row) => row.model === 'm-big')).toMatchObject({ calls: 2 })
    expect(stats.byKind.find((row) => row.kind === 'moment')).toMatchObject({ calls: 1 })
  })

  it('不传 tzOffset 时退回服务端时区，分桶仍然覆盖全部记录', async () => {
    const res = await api<{ stats: AiUsageStats }>('GET', '/ai/usage/stats?window=7d', { token })
    expect(res.status).toBe(200)
    const stats = res.json.stats
    const seriesPrompt = stats.series.reduce((sum, b) => sum + b.promptTokens, 0)
    expect(seriesPrompt).toBe(stats.totals.promptTokens)
    expect(stats.totals.calls).toBe(5)
  })
})
