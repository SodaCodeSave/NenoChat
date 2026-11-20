import { testDatabaseUrl } from './helpers/pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ProactiveConfig } from '@nenochat/shared'
import {
  decideProactiveFire,
  inQuietWindow,
  localDayKey,
  minutesOfDay,
} from '../src/services/proactive-rules'

const dataDir = mkdtempSync(path.join(tmpdir(), 'nenochat-proactive-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = testDatabaseUrl(import.meta.url)
process.env.LOG_LEVEL = 'fatal'
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars'
process.env.SECRET_KEY = 'test-aes-secret-at-least-16-chars'

let app: FastifyInstance
let token = ''
let conversationId = ''

function device(id: string) {
  return { id, name: `设备-${id}`, platform: 'win32', appVersion: '0.1.0' }
}

beforeAll(async () => {
  const { buildApp } = await import('../src/app')
  app = await buildApp()
  await app.ready()

  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      username: 'proactive_user',
      password: 'pass12345',
      displayName: '主动消息用户',
      device: device('dev-pro'),
    }),
  })
  token = (reg.json() as { tokens: { accessToken: string } }).tokens.accessToken

  // 建角色会自动生成 AI 会话，正好当作占位用的会话
  const persona = await app.inject({
    method: 'POST',
    url: '/api/v1/ai/personas',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: JSON.stringify({ name: '占位角色', systemPrompt: '你是朋友。' }),
  })
  const personaId = (persona.json() as { persona: { id: string } }).persona.id

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/conversations',
    headers: { authorization: `Bearer ${token}` },
  })
  const conversations = (list.json() as { conversations: Array<{ id: string; aiPersonaId: string | null }> })
    .conversations
  conversationId = conversations.find((c) => c.aiPersonaId === personaId)!.id
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

const CONFIG: ProactiveConfig = { enabled: true, minIdleHours: 6, maxPerDay: 2 }

const CHANCE_CONFIG: ProactiveConfig = {
  enabled: true,
  minIdleHours: 6,
  maxPerDay: 2,
  triggerMode: 'chance',
  chanceUnit: 'hour',
  chanceProbability: 0.5,
  chanceCooldownMinutes: 60,
}

function baseInput(overrides: Partial<Parameters<typeof decideProactiveFire>[0]> = {}) {
  const now = Date.UTC(2026, 10, 16, 4, 0) // +08:00 → 12:00
  return {
    now,
    conversationCreatedAt: now - 72 * 3_600_000,
    lastUserMessageAt: now - 8 * 3_600_000,
    lastProactiveAt: null,
    sentToday: 0,
    config: CONFIG,
    tzOffsetMinutes: 480,
    serverCanRun: true,
    ownerOnline: true,
    ...overrides,
  }
}

describe('proactive 时间规则', () => {
  it('按东八区算本地日', () => {
    // UTC 2026-11-16 17:00 → 东八区 11-17 01:00
    expect(localDayKey(Date.UTC(2026, 10, 16, 17, 0), 480)).toBe('2026-11-17')
    expect(localDayKey(Date.UTC(2026, 10, 16, 4, 0), 480)).toBe('2026-11-16')
  })

  it('分钟数按本地时区偏移', () => {
    expect(minutesOfDay(Date.UTC(2026, 10, 16, 4, 30), 480)).toBe(12 * 60 + 30)
  })

  it('跨零点的免打扰窗口', () => {
    // 东八区 23:30
    expect(inQuietWindow(Date.UTC(2026, 10, 16, 15, 30), '23:00', '08:00', 480)).toBe(true)
    // 东八区 07:30
    expect(inQuietWindow(Date.UTC(2026, 10, 15, 23, 30), '23:00', '08:00', 480)).toBe(true)
    // 东八区 10:30
    expect(inQuietWindow(Date.UTC(2026, 10, 16, 2, 30), '23:00', '08:00', 480)).toBe(false)
  })

  it('普通窗口与未配置窗口', () => {
    // 东八区 12:00
    expect(inQuietWindow(Date.UTC(2026, 10, 16, 4, 0), '11:00', '13:00', 480)).toBe(true)
    expect(inQuietWindow(Date.UTC(2026, 10, 16, 4, 0), undefined, undefined, 480)).toBe(false)
    expect(inQuietWindow(Date.UTC(2026, 10, 16, 4, 0), '12:00', '12:00', 480)).toBe(false)
  })
})

describe('decideProactiveFire', () => {
  it('正常情况可以发', () => {
    const decision = decideProactiveFire(baseInput())
    expect(decision.fire).toBe(true)
    expect(decision.reason).toBe('ok')
    expect(decision.idleHours).toBe(8)
  })

  it('开关关闭时不发', () => {
    const decision = decideProactiveFire(baseInput({ config: { ...CONFIG, enabled: false } }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('disabled')
  })

  it('每日上限用尽不发', () => {
    const decision = decideProactiveFire(baseInput({ sentToday: 2 }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('quota_exhausted')
  })

  it('免打扰时段不发', () => {
    const now = Date.UTC(2026, 10, 16, 16, 0) // 东八区 00:00
    const decision = decideProactiveFire(
      baseInput({
        now,
        lastUserMessageAt: now - 8 * 3_600_000,
        config: { ...CONFIG, windowStart: '23:00', windowEnd: '08:00' },
      }),
    )
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('quiet_window')
  })

  it('从未聊过不发', () => {
    const decision = decideProactiveFire(baseInput({ lastUserMessageAt: null }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('no_user_message')
  })

  it('空闲时长不足不发', () => {
    const input = baseInput()
    const decision = decideProactiveFire({
      ...input,
      lastUserMessageAt: input.now - 3_600_000,
    })
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('not_idle_enough')
  })

  it('刚发过还在冷却期不发', () => {
    const input = baseInput()
    const decision = decideProactiveFire({
      ...input,
      lastProactiveAt: input.now - 3_600_000,
    })
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('本机密钥且用户离线时不发', () => {
    const decision = decideProactiveFire(baseInput({ serverCanRun: false, ownerOnline: false }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('local_key_offline')
  })
})

describe('decideProactiveFire 概率模式', () => {
  it('间隔到了且掷中就发，从未聊过也允许', () => {
    const decision = decideProactiveFire(
      baseInput({
        config: CHANCE_CONFIG,
        lastUserMessageAt: null,
        lastRollAt: null,
        random: () => 0.1,
      }),
    )
    expect(decision.fire).toBe(true)
    expect(decision.reason).toBe('ok')
  })

  it('掷骰间隔内不重掷', () => {
    const now = baseInput().now
    const decision = decideProactiveFire(
      baseInput({
        config: CHANCE_CONFIG,
        lastUserMessageAt: null,
        lastRollAt: now - 30 * 60_000,
        random: () => 0.1,
      }),
    )
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('chance_interval')
  })

  it('掷骰未中不发', () => {
    const now = baseInput().now
    const decision = decideProactiveFire(
      baseInput({
        config: CHANCE_CONFIG,
        lastUserMessageAt: null,
        lastRollAt: now - 2 * 3_600_000,
        random: () => 0.9,
      }),
    )
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('chance_miss')
  })

  it('冷却期内不发', () => {
    const now = baseInput().now
    const decision = decideProactiveFire(
      baseInput({
        config: CHANCE_CONFIG,
        lastUserMessageAt: null,
        lastProactiveAt: now - 10 * 60_000,
        lastRollAt: now - 10 * 60_000,
        random: () => 0.1,
      }),
    )
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('每分钟掷骰时一分钟前掷过就算间隔已到', () => {
    const now = baseInput().now
    const decision = decideProactiveFire(
      baseInput({
        config: { ...CHANCE_CONFIG, chanceUnit: 'minute' },
        lastUserMessageAt: null,
        lastRollAt: now - 90_000,
        random: () => 0.1,
      }),
    )
    expect(decision.fire).toBe(true)
  })

  it('免打扰与配额优先于概率', () => {
    const now = Date.UTC(2026, 10, 16, 16, 0) // 东八区 00:00
    const decision = decideProactiveFire(
      baseInput({
        now,
        config: { ...CHANCE_CONFIG, windowStart: '23:00', windowEnd: '08:00' },
        lastUserMessageAt: null,
        random: () => 0.1,
      }),
    )
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('quiet_window')
  })
})

describe('decideProactiveFire 无上限配额', () => {
  it('maxPerDay = -1 时发了很多条也继续发', () => {
    const decision = decideProactiveFire(baseInput({ config: { ...CONFIG, maxPerDay: -1 }, sentToday: 500 }))
    expect(decision.fire).toBe(true)
  })

  it('maxPerDay = 0 仍然不发', () => {
    const decision = decideProactiveFire(baseInput({ config: { ...CONFIG, maxPerDay: 0 } }))
    expect(decision.fire).toBe(false)
    expect(decision.reason).toBe('quota_zero')
  })
})

describe('reserveSlot 配额占位', () => {
  it('同日同会话按 maxPerDay 顺序占位，用尽后返回 null', async () => {
    const { getDb, one } = await import('../src/db')
    const { reserveSlot } = await import('../src/services/proactive-service')
    const db = getDb()

    const userId = (await one<{ id: string }>(db, 'SELECT id FROM users WHERE username = ?', [
      'proactive_user',
    ]))!.id
    const personaId = (await one<{ id: string }>(
      db,
      'SELECT id FROM ai_personas ORDER BY created_at LIMIT 1',
    ))!.id

    const args = {
      conversationId,
      userId,
      personaId,
      dayKey: '2026-11-16',
      maxPerDay: 2,
      now: Date.now(),
    }

    expect(await reserveSlot(db, args)).toBe(0)
    expect(await reserveSlot(db, args)).toBe(1)
    expect(await reserveSlot(db, args)).toBeNull()
  })

  it('maxPerDay 为负数时无上限，slot 一直递增', async () => {
    const { getDb, one } = await import('../src/db')
    const { reserveSlot } = await import('../src/services/proactive-service')
    const db = getDb()

    const userId = (await one<{ id: string }>(db, 'SELECT id FROM users WHERE username = ?', [
      'proactive_user',
    ]))!.id
    const personaId = (await one<{ id: string }>(
      db,
      'SELECT id FROM ai_personas ORDER BY created_at LIMIT 1',
    ))!.id

    const args = {
      conversationId,
      userId,
      personaId,
      dayKey: '2026-11-17',
      maxPerDay: -1,
      now: Date.now(),
    }

    for (let i = 0; i < 5; i++) {
      expect(await reserveSlot(db, args)).toBe(i)
    }
  })

  it('chance 掷骰标记复用 slot，不影响真实消息占位', async () => {
    const { getDb, one, run } = await import('../src/db')
    const { reserveSlot } = await import('../src/services/proactive-service')
    const db = getDb()

    const userId = (await one<{ id: string }>(db, 'SELECT id FROM users WHERE username = ?', [
      'proactive_user',
    ]))!.id
    const personaId = (await one<{ id: string }>(
      db,
      'SELECT id FROM ai_personas ORDER BY created_at LIMIT 1',
    ))!.id

    const dayKey = '2026-11-18'
    // 先留两条掷骰未中的标记（slot 0）
    for (let i = 0; i < 2; i++) {
      await run(
        db,
        `INSERT INTO ai_proactive_log
           (id, conversation_id, user_id, persona_id, day_key, slot, fired_at, status, message_id, reason)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'skipped', NULL, 'chance_miss')`,
        [`miss-${dayKey}-${i}`, conversationId, userId, personaId, dayKey, Date.now()],
      )
    }

    // 真实消息仍然从 slot 0 开始占位，不受标记影响
    const reserveArgs = {
      conversationId,
      userId,
      personaId,
      dayKey,
      maxPerDay: 1,
      now: Date.now(),
    }
    expect(await reserveSlot(db, reserveArgs)).toBe(0)
    expect(await reserveSlot(db, reserveArgs)).toBeNull()
  })
})
