import {
  buildSchedulePrompt,
  parseScheduleItems,
  type AiSchedule,
  type AiScheduleItem,
  type AiScheduleSource,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as aiRepo from '../db/repo/ai'
import * as scheduleRepo from '../db/repo/schedule'
import { err } from '../util/errors'
import { callUpstream, resolveServerApiKey, isModelEnabled } from './ai-service'
import {
  formatLocalTime,
  localDayKey,
  minutesOfDay,
  serverTzOffsetMinutes,
} from './proactive-rules'

/** 与服务端其他定时逻辑保持同一套时区口径 */
const TZ_OFFSET_MIN = serverTzOffsetMinutes()

export function todayKey(ts = Date.now()): string {
  return localDayKey(ts, TZ_OFFSET_MIN)
}

/** 角色本地时区下当天已过去的分钟数 */
export function scheduleNowMinutes(ts = Date.now()): number {
  return minutesOfDay(ts, TZ_OFFSET_MIN)
}

export async function getSchedule(db: DB, personaId: string, dayKey: string): Promise<AiSchedule | null> {
  const row = await scheduleRepo.findSchedule(db, personaId, dayKey)
  if (!row) return null
  const schedule = scheduleRepo.mapSchedule(row)
  return schedule.items.length > 0 ? schedule : null
}

/** 给提示词用：只读当天已生成的日程，不触发生成 */
export async function scheduleForPrompt(db: DB, personaId: string, ts = Date.now()): Promise<AiSchedule | null> {
  return getSchedule(db, personaId, todayKey(ts))
}

export async function saveSchedule(
  db: DB,
  input: {
    ownerId: string
    personaId: string
    dayKey: string
    items: AiScheduleItem[]
    source: AiScheduleSource
  },
): Promise<AiSchedule> {
  return scheduleRepo.mapSchedule(await scheduleRepo.upsertSchedule(db, input))
}

/**
 * 角色当前实际使用的服务商。
 * 共享模式开启时一律服务器供应商；关闭时与客户端的 providerOf 保持一致：
 * 角色指定 → 默认服务商 → 最早创建的那个。
 */
async function resolveProvider(db: DB, persona: aiRepo.PersonaRow) {
  if (await aiRepo.isSharedModeEnabled(db)) {
    return await aiRepo.defaultProvider(db, aiRepo.SYSTEM_AI_OWNER_ID)
  }
  if (persona.provider_id) {
    const explicit = await aiRepo.findProvider(db, persona.provider_id)
    if (explicit) return explicit
  }
  return (
    (await aiRepo.defaultProvider(db, persona.owner_id)) ??
    (await aiRepo.listProviders(db, persona.owner_id))[0]
  )
}

/** 用服务端托管的密钥调用上游，生成并保存某天的日程 */
export async function generateScheduleOnServer(
  db: DB,
  persona: aiRepo.PersonaRow,
  dayKey: string,
): Promise<AiSchedule> {
  const provider = await resolveProvider(db, persona)
  if (!provider) throw err.validation('请先配置 AI 服务商')

  // 关闭的模型不可被选用：日程生成同样走主模型，停用就拒绝
  const model = persona.model_override ?? provider.model
  if (!isModelEnabled(provider, model)) {
    throw err.validation(`模型 ${model} 已在 AI 设置里停用，请改用其它模型`)
  }

  const result = await callUpstream({
    baseUrl: provider.base_url,
    apiKey: resolveServerApiKey(provider),
    model,
    temperature: persona.temperature ?? provider.temperature,
    maxTokens: Math.min(provider.max_tokens, 800),
    messages: buildSchedulePrompt({
      persona: aiRepo.mapPersona(persona),
      dayKey,
      localTime: formatLocalTime(Date.now(), TZ_OFFSET_MIN),
    }),
    record: {
      db,
      ownerId: persona.owner_id,
      personaId: persona.id,
      providerId: provider.id,
      kind: 'schedule',
    },
  })

  const items = parseScheduleItems(result.content)
  if (items.length === 0) throw err.upstreamAi('日程生成失败，请重试')

  return saveSchedule(db, {
    ownerId: persona.owner_id,
    personaId: persona.id,
    dayKey,
    items,
    source: 'ai',
  })
}

/** 有就返回；没有则生成当天日程 */
export async function ensureSchedule(
  db: DB,
  persona: aiRepo.PersonaRow,
  dayKey = todayKey(),
): Promise<AiSchedule | null> {
  const existing = await getSchedule(db, persona.id, dayKey)
  if (existing) return existing
  return generateScheduleOnServer(db, persona, dayKey).catch(() => null)
}

/** 强制重新生成：保留已有日程直到新结果成功写入 */
export async function regenerateSchedule(
  db: DB,
  persona: aiRepo.PersonaRow,
  dayKey = todayKey(),
): Promise<AiSchedule | null> {
  const existing = await getSchedule(db, persona.id, dayKey)
  const schedule = await generateScheduleOnServer(db, persona, dayKey)
  return schedule ?? existing
}

/** 后台路径使用：生成失败只返回 null，不影响回复主流程 */
export async function ensureScheduleQuietly(
  db: DB,
  persona: aiRepo.PersonaRow,
  dayKey = todayKey(),
): Promise<AiSchedule | null> {
  try {
    return await ensureSchedule(db, persona, dayKey)
  } catch {
    return getSchedule(db, persona.id, dayKey)
  }
}
