import { Cron } from 'croner'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { PROACTIVE_DEFAULTS, buildProactivePrompt, splitSegments, ulid, type ProactiveConfig } from '@nenochat/shared'
import type { DB } from '../db'
import { all, one, run } from '../db'
import { withTx } from '../db/tx'
import * as aiRepo from '../db/repo/ai'
import * as conversationsRepo from '../db/repo/conversations'
import { buildMemoryDigest } from './ai-shared'
import { appendAiSegment, callUpstream, resolveServerApiKey, isModelEnabled } from './ai-service'
import { enabledConnectorOfType, fetchHeweather } from './connector-service'
import * as scheduleService from './schedule-service'
import {
  decideProactiveFire,
  formatLocalTime,
  localDayKey,
  minutesOfDay,
  serverTzOffsetMinutes,
  type ProactiveDecision,
} from './proactive-rules'
import { hub } from '../ws/hub'

/**
 * 主动消息调度。
 *
 * 判定与生成都在服务端完成，客户端只负责展示 —— 这样多端看到的是同一条，
 * 不会出现「手机发一条、电脑又发一条」。
 */

const STALE_PENDING_MS = 10 * 60_000
const SCAN_INTERVAL_CRON = PROACTIVE_DEFAULTS.scanIntervalCron
const KICKOFF_DELAY_MS = 30_000

/** 服务端时区偏移（分钟），默认取运行环境；东八区为 480 */
const TZ_OFFSET_MIN = serverTzOffsetMinutes()

interface CandidateRow {
  persona_id: string
  owner_id: string
  proactive_config: string | null
  proactive_enabled: number
  proactive_mode: string
  /** 主人那条全局设置，跟随全局的角色以它为准 */
  global_config: string | null
  global_enabled: number | null
  conversation_id: string
  conversation_created_at: number
  last_user_message_at: number | null
  last_proactive_at: number | null
  /** 最近一条日志（含失败/占位）的时间，chance 模式用它控制掷骰间隔 */
  last_log_at: number | null
  sent_today: number
}

function parsePersonaConfig(row: CandidateRow): ProactiveConfig {
  const fallback: ProactiveConfig = {
    enabled: row.proactive_enabled === 1,
    minIdleHours: PROACTIVE_DEFAULTS.minIdleHours,
    maxPerDay: PROACTIVE_DEFAULTS.maxPerDay,
  }
  if (!row.proactive_config) return fallback
  try {
    const parsed = JSON.parse(row.proactive_config) as Partial<ProactiveConfig>
    return {
      enabled: parsed.enabled ?? fallback.enabled,
      triggerMode: parsed.triggerMode,
      minIdleHours: parsed.minIdleHours ?? fallback.minIdleHours,
      maxPerDay: parsed.maxPerDay ?? fallback.maxPerDay,
      chanceUnit: parsed.chanceUnit,
      chanceProbability: parsed.chanceProbability,
      chanceCooldownMinutes: parsed.chanceCooldownMinutes,
      windowStart: parsed.windowStart,
      windowEnd: parsed.windowEnd,
    }
  } catch {
    return fallback
  }
}

function parseGlobalConfig(row: CandidateRow): ProactiveConfig {
  const fallback: ProactiveConfig = {
    enabled: row.global_enabled === 1,
    minIdleHours: PROACTIVE_DEFAULTS.minIdleHours,
    maxPerDay: PROACTIVE_DEFAULTS.maxPerDay,
  }
  if (!row.global_config) return fallback
  try {
    const parsed = JSON.parse(row.global_config) as Partial<ProactiveConfig>
    return {
      enabled: fallback.enabled,
      triggerMode: parsed.triggerMode,
      minIdleHours: parsed.minIdleHours ?? fallback.minIdleHours,
      maxPerDay: parsed.maxPerDay ?? fallback.maxPerDay,
      chanceUnit: parsed.chanceUnit,
      chanceProbability: parsed.chanceProbability,
      chanceCooldownMinutes: parsed.chanceCooldownMinutes,
      windowStart: parsed.windowStart,
      windowEnd: parsed.windowEnd,
    }
  } catch {
    return fallback
  }
}

/** 角色自己配就用自己那份，跟随全局就用主人那条总设置 */
function resolveConfig(row: CandidateRow): ProactiveConfig {
  return row.proactive_mode === 'custom' ? parsePersonaConfig(row) : parseGlobalConfig(row)
}

/** 一条 SQL 把所有候选与其判定所需的计数带出来，避免每个角色查五次 */
async function listCandidates(db: DB, dayKey: string): Promise<CandidateRow[]> {
  return all<CandidateRow>(
    db,
    `SELECT p.id                AS persona_id,
            p.owner_id          AS owner_id,
            p.proactive_config  AS proactive_config,
            p.proactive_enabled AS proactive_enabled,
            p.proactive_mode    AS proactive_mode,
            g.proactive_config  AS global_config,
            g.proactive_enabled AS global_enabled,
            c.id                AS conversation_id,
            c.created_at        AS conversation_created_at,
            (SELECT MAX(m.created_at) FROM messages m
              WHERE m.conversation_id = c.id
                AND m.sender_id = p.owner_id
                AND m.deleted_at IS NULL)                              AS last_user_message_at,
            (SELECT MAX(l.fired_at) FROM ai_proactive_log l
              WHERE l.conversation_id = c.id
                AND l.status IN ('sent', 'dispatched'))                 AS last_proactive_at,
            (SELECT MAX(l.fired_at) FROM ai_proactive_log l
              WHERE l.conversation_id = c.id)                            AS last_log_at,
            (SELECT COUNT(*) FROM ai_proactive_log l2
              WHERE l2.conversation_id = c.id
                AND l2.day_key = ?
                AND l2.status IN ('pending', 'dispatched', 'sent'))      AS sent_today
       FROM ai_personas p
       JOIN conversations c
         ON c.type = 'ai' AND c.ai_persona_id = p.id AND c.deleted_at IS NULL
       LEFT JOIN ai_global_settings g ON g.user_id = p.owner_id
       WHERE p.deleted_at IS NULL
         AND p.in_contacts = 1
         AND (
           (p.proactive_mode = 'custom' AND p.proactive_enabled = 1)
           OR (p.proactive_mode <> 'custom' AND g.proactive_enabled = 1)
         )`,
    [dayKey],
  )
}

/**
 * 先占位再生成：唯一索引 (conversation_id, day_key, slot) 保证
 * 多实例同时扫描时只有一个能抢到这一格。
 */
export async function reserveSlot(
  db: DB,
  input: {
    conversationId: string
    userId: string
    personaId: string
    dayKey: string
    maxPerDay: number
    now: number
  },
): Promise<number | null> {
  return withTx(db, async (tx) => {
    const usedRow = await one<{ c: number }>(
      tx,
      `SELECT COUNT(*) AS c FROM ai_proactive_log
         WHERE conversation_id = ? AND day_key = ?
           AND status IN ('pending', 'dispatched', 'sent')`,
      [input.conversationId, input.dayKey],
    )
    const used = usedRow?.c ?? 0

    // maxPerDay < 0 表示无上限，只受唯一索引约束
    if (input.maxPerDay >= 0 && used >= input.maxPerDay) return null
    const slot = used

    try {
      await run(
        tx,
        `INSERT INTO ai_proactive_log
           (id, conversation_id, user_id, persona_id, day_key, slot, fired_at, status, message_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
        [ulid(), input.conversationId, input.userId, input.personaId, input.dayKey, slot, input.now],
      )
      return slot
    } catch {
      // 唯一索引冲突：另一个实例已经抢到同一格
      return null
    }
  })
}

async function finishSlot(
  db: DB,
  input: {
    conversationId: string
    dayKey: string
    slot: number
    status: 'sent' | 'dispatched' | 'failed' | 'skipped'
    messageId?: string | null
    reason?: string | null
  },
): Promise<void> {
  await run(
    db,
    `UPDATE ai_proactive_log SET status = ?, message_id = ?, reason = ?
       WHERE conversation_id = ? AND day_key = ? AND slot = ?`,
    [
      input.status,
      input.messageId ?? null,
      input.reason ?? null,
      input.conversationId,
      input.dayKey,
      input.slot,
    ],
  )
}

/**
 * chance 模式掷骰未中：留一条 skipped 标记推进掷骰间隔，不占每日配额。
 * 标记只保留两天，太旧的在扫描时清掉。
 */
async function recordChanceMiss(
  db: DB,
  input: { conversationId: string; userId: string; personaId: string; dayKey: string; now: number },
): Promise<void> {
  try {
    await run(
      db,
      `INSERT INTO ai_proactive_log
         (id, conversation_id, user_id, persona_id, day_key, slot, fired_at, status, message_id, reason)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'skipped', NULL, 'chance_miss')`,
      [ulid(), input.conversationId, input.userId, input.personaId, input.dayKey, input.now],
    )
  } catch {
    // 并发下另一个实例已经标记过本轮，忽略
  }
}

/** 服务端密钥：直接生成并落库（离线也能发） */
async function fireOnServer(
  db: DB,
  candidate: CandidateRow,
  persona: aiRepo.PersonaRow,
  decision: ProactiveDecision,
  dayKey: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const config = resolveConfig(candidate)
  const slot = await reserveSlot(db, {
    conversationId: candidate.conversation_id,
    userId: candidate.owner_id,
    personaId: persona.id,
    dayKey,
    maxPerDay: config.maxPerDay,
    now: Date.now(),
  })
  if (slot === null) return

  const session = await aiRepo.findSession(db, candidate.conversation_id)
  const provider = session ? await aiRepo.findProvider(db, session.provider_id) : undefined
  if (!provider) {
    await finishSlot(db, {
      conversationId: candidate.conversation_id,
      dayKey,
      slot,
      status: 'skipped',
      reason: 'no_provider',
    })
    return
  }

  // 关闭的模型不可被选用：不消耗当天额度，跳过本轮主动消息
  if (!isModelEnabled(provider, persona.model_override ?? provider.model)) {
    await finishSlot(db, {
      conversationId: candidate.conversation_id,
      dayKey,
      slot,
      status: 'skipped',
      reason: 'model_disabled',
    })
    return
  }

  const mapped = aiRepo.mapPersona(persona)
  const schedule = await scheduleService.ensureScheduleQuietly(db, persona)
  let weatherContext: string | null = null
  const weather = await enabledConnectorOfType(db, candidate.owner_id, 'heweather')
  if (weather) {
    try {
      const weatherConfig = JSON.parse(weather.config || '{}') as Record<string, unknown>
      if (weatherConfig.weatherOnUserMessage) weatherContext = await fetchHeweather(weather)
    } catch { /* weather is optional context */ }
  }
  const messages = buildProactivePrompt({
    persona: mapped,
    memoryDigest: await buildMemoryDigest(db, candidate.conversation_id),
    idleHours: decision.idleHours,
    localTime: formatLocalTime(Date.now(), TZ_OFFSET_MIN),
    schedule,
    scheduleNowMinutes: minutesOfDay(Date.now(), TZ_OFFSET_MIN),
    // 天气是每轮都变的内容，走 user 尾行；拼进 system 会让每次主动调用的前缀缓存失效
    weather: weatherContext,
  })

  let reply: string
  try {
    reply = (
      await callUpstream({
        baseUrl: provider.base_url,
        apiKey: resolveServerApiKey(provider),
        model: persona.model_override ?? provider.model,
        temperature: persona.temperature ?? provider.temperature,
        maxTokens: Math.min(provider.max_tokens, 400),
        messages,
        record: {
          db,
          ownerId: candidate.owner_id,
          conversationId: candidate.conversation_id,
          personaId: persona.id,
          providerId: provider.id,
          kind: 'proactive',
        },
      })
    )
      .content
      .trim()
  } catch (e) {
    log.warn({ err: e, personaId: persona.id }, '主动消息生成失败')
    await finishSlot(db, {
      conversationId: candidate.conversation_id,
      dayKey,
      slot,
      status: 'failed',
      reason: e instanceof Error ? e.message.slice(0, 200) : 'generate_failed',
    })
    return
  }

  // 主动搭话最多两条，多了像刷屏
  const settings = await aiRepo.readGlobalSettings(db, candidate.owner_id)
  const segments = splitSegments(reply, {
    enabled: settings.segmentEnabled,
    pattern: settings.segmentPattern,
  }).slice(0, 2)
  if (segments.length === 0) {
    await finishSlot(db, {
      conversationId: candidate.conversation_id,
      dayKey,
      slot,
      status: 'skipped',
      reason: 'empty_reply',
    })
    return
  }

  const generationId = `proactive-${candidate.conversation_id}-${dayKey}-${slot}`
  const messageIds: string[] = []
  for (let index = 0; index < segments.length; index++) {
    const message = await appendAiSegment(db, candidate.conversation_id, {
      generationId,
      index,
      content: segments[index]!,
      clientNonce: `${generationId}-${index}`,
      model: persona.model_override ?? provider.model,
      totalSegments: segments.length,
      personaId: persona.id,
      proactive: true,
    })
    messageIds.push(message.id)
  }

  await run(db, 'UPDATE ai_personas SET last_proactive_at = ? WHERE id = ?', [Date.now(), persona.id])
  await finishSlot(db, {
    conversationId: candidate.conversation_id,
    dayKey,
    slot,
    status: 'sent',
    messageId: messageIds[0] ?? null,
  })
}

/** 跑一轮扫描。导出以便测试与手动触发。 */
export async function scanOnce(db: DB, log: FastifyBaseLogger): Promise<void> {
  const now = Date.now()
  const dayKey = localDayKey(now, TZ_OFFSET_MIN)

  // 上次进程崩溃留下的 pending 会一直占着配额，先释放
  await run(
    db,
    `UPDATE ai_proactive_log SET status = 'failed', reason = 'stale_pending'
       WHERE status = 'pending' AND fired_at < ?`,
    [now - STALE_PENDING_MS],
  )

  // 掷骰标记只用来推进间隔，两天前的可以直接清掉
  await run(
    db,
    `DELETE FROM ai_proactive_log
       WHERE status = 'skipped' AND reason = 'chance_miss' AND fired_at < ?`,
    [now - 2 * 24 * 60 * 60_000],
  )

  const candidates = await listCandidates(db, dayKey)
  if (candidates.length === 0) return

  for (const candidate of candidates) {
    const persona = await aiRepo.findPersona(db, candidate.persona_id)
    if (!persona) continue

    const config = resolveConfig(candidate)
    const ownerOnline = hub().isOnline(candidate.owner_id)

    const decision = decideProactiveFire({
      now,
      conversationCreatedAt: candidate.conversation_created_at,
      lastUserMessageAt: candidate.last_user_message_at,
      lastProactiveAt: candidate.last_proactive_at,
      lastRollAt: candidate.last_log_at,
      sentToday: candidate.sent_today,
      config,
      tzOffsetMinutes: TZ_OFFSET_MIN,
      serverCanRun: true,
      ownerOnline,
    })

    if (!decision.fire) {
      // 掷骰未中也要留痕，否则下一轮扫描会立刻重掷，概率语义就变了
      if (decision.reason === 'chance_miss') {
        await recordChanceMiss(db, {
          conversationId: candidate.conversation_id,
          userId: candidate.owner_id,
          personaId: candidate.persona_id,
          dayKey,
          now,
        })
      }
      continue
    }

    try {
      await fireOnServer(db, candidate, persona, decision, dayKey, log)
    } catch (e) {
      log.error({ err: e, personaId: persona.id }, '主动消息派发异常')
    }
  }
}

/**
 * 启动调度器，返回停止函数。
 * 测试环境不启动（否则定时器会拖住 vitest 进程）。
 */
export function startProactiveScheduler(app: FastifyInstance, db: DB): () => void {
  if (process.env.NODE_ENV === 'test') return () => {}

  // protect: 上一轮没跑完就跳过这一轮，避免长耗时生成叠加
  const job = new Cron(SCAN_INTERVAL_CRON, { protect: true }, () => {
    void scanOnce(db, app.log).catch((e) => {
      app.log.error({ err: e }, '主动消息扫描失败')
    })
  })

  // 刚启动时不必等下一个扫描窗口
  const kickoff = setTimeout(() => {
    void scanOnce(db, app.log).catch(() => undefined)
  }, KICKOFF_DELAY_MS)

  return () => {
    job.stop()
    clearTimeout(kickoff)
  }
}

/** 供测试直接调用：不经过定时器判断当前角色是否该发 */
export async function evaluateCandidate(
  db: DB,
  conversationId: string,
  now = Date.now(),
): Promise<{ decision: ProactiveDecision; persona: aiRepo.PersonaRow | null } | null> {
  const conversation = await conversationsRepo.findById(db, conversationId)
  if (!conversation?.ai_persona_id) return null
  const persona = await aiRepo.findPersona(db, conversation.ai_persona_id)
  if (!persona) return null

  const dayKey = localDayKey(now, TZ_OFFSET_MIN)
  const row = (await listCandidates(db, dayKey)).find((c) => c.conversation_id === conversationId)
  if (!row) return null

  const config = resolveConfig(row)
  const decision = decideProactiveFire({
    now,
    conversationCreatedAt: row.conversation_created_at,
    lastUserMessageAt: row.last_user_message_at,
    lastProactiveAt: row.last_proactive_at,
    lastRollAt: row.last_log_at,
    sentToday: row.sent_today,
    config,
    tzOffsetMinutes: TZ_OFFSET_MIN,
    serverCanRun: true,
    ownerOnline: hub().isOnline(row.owner_id),
  })
  return { decision, persona }
}
