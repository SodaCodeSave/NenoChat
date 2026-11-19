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
import { callUpstream, resolveServerApiKey } from './ai-service'
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

export function getSchedule(db: DB, personaId: string, dayKey: string): AiSchedule | null {
  const row = scheduleRepo.findSchedule(db, personaId, dayKey)
  if (!row) return null
  const schedule = scheduleRepo.mapSchedule(row)
  return schedule.items.length > 0 ? schedule : null
}

/** 给提示词用：只读当天已生成的日程，不触发生成 */
export function scheduleForPrompt(db: DB, personaId: string, ts = Date.now()): AiSchedule | null {
  return getSchedule(db, personaId, todayKey(ts))
}

export function saveSchedule(
  db: DB,
  input: {
    ownerId: string
    personaId: string
    dayKey: string
    items: AiScheduleItem[]
    source: AiScheduleSource
  },
): AiSchedule {
  return scheduleRepo.mapSchedule(scheduleRepo.upsertSchedule(db, input))
}

/**
 * 角色当前实际使用的服务商。
 * 与客户端的 providerOf 保持一致：角色指定的服务商可能已被删除，
 * 这时要回退到默认服务商，再回退到最早创建的那个。
 */
function resolveProvider(db: DB, persona: aiRepo.PersonaRow) {
  if (persona.provider_id) {
    const explicit = aiRepo.findProvider(db, persona.provider_id)
    if (explicit) return explicit
  }
  return (
    aiRepo.defaultProvider(db, persona.owner_id) ??
    aiRepo.listProviders(db, persona.owner_id)[0]
  )
}

/** 用服务端托管的密钥调用上游，生成并保存某天的日程 */
export async function generateScheduleOnServer(
  db: DB,
  persona: aiRepo.PersonaRow,
  dayKey: string,
): Promise<AiSchedule> {
  const provider = resolveProvider(db, persona)
  if (!provider) throw err.validation('请先配置 AI 服务商')

  const result = await callUpstream({
    baseUrl: provider.base_url,
    apiKey: resolveServerApiKey(provider),
    model: persona.model_override ?? provider.model,
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
  const existing = getSchedule(db, persona.id, dayKey)
  if (existing) return existing
  return generateScheduleOnServer(db, persona, dayKey).catch(() => null)
}

/** 强制重新生成：保留已有日程直到新结果成功写入 */
export async function regenerateSchedule(
  db: DB,
  persona: aiRepo.PersonaRow,
  dayKey = todayKey(),
): Promise<AiSchedule | null> {
  const existing = getSchedule(db, persona.id, dayKey)
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
