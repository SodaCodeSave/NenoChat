import type { AiSchedule, AiScheduleItem, AiScheduleSource } from '@nenochat/shared'
import { normalizeScheduleItems, ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface ScheduleRow {
  id: string
  owner_id: string
  persona_id: string
  day_key: string
  items: string
  source: string
  created_at: number
  updated_at: number
}

export function parseItems(raw: string): AiScheduleItem[] {
  try {
    return normalizeScheduleItems(JSON.parse(raw))
  } catch {
    return []
  }
}

export function mapSchedule(row: ScheduleRow): AiSchedule {
  return {
    personaId: row.persona_id,
    dayKey: row.day_key,
    items: parseItems(row.items),
    source: row.source === 'manual' ? 'manual' : 'ai',
    updatedAt: row.updated_at,
  }
}

export function findSchedule(db: DB, personaId: string, dayKey: string): ScheduleRow | undefined {
  return db
    .prepare('SELECT * FROM ai_persona_schedules WHERE persona_id = ? AND day_key = ?')
    .get(personaId, dayKey) as ScheduleRow | undefined
}

export interface UpsertScheduleInput {
  ownerId: string
  personaId: string
  dayKey: string
  items: AiScheduleItem[]
  source: AiScheduleSource
}

export function upsertSchedule(db: DB, input: UpsertScheduleInput): ScheduleRow {
  const ts = now()
  db.prepare(
    `INSERT INTO ai_persona_schedules
       (id, owner_id, persona_id, day_key, items, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(persona_id, day_key) DO UPDATE SET
       items = excluded.items,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(
    ulid(),
    input.ownerId,
    input.personaId,
    input.dayKey,
    JSON.stringify(input.items),
    input.source,
    ts,
    ts,
  )

  const row = findSchedule(db, input.personaId, input.dayKey)
  if (!row) throw new Error('保存日程后回读失败')
  return row
}
