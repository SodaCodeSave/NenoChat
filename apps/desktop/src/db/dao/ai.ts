import type { AiPersona, PersonaRelationship, RelationshipStage, ReplyStyle } from '@nenochat/shared'
import { PROACTIVE_DEFAULTS, RELATIONSHIP_STAGE_LABELS } from '@nenochat/shared'
import { dbExecute, dbSelect } from '@/platform/db'

/**
 * 角色在客户端本地的镜像。
 * 通讯录与「AI 角色」分区都读这里，断网时也能看到自己的角色。
 */
export interface PersonaRow {
  server_id: string
  id: string
  name: string
  avatar_url: string | null
  system_prompt: string
  greeting: string | null
  provider_id: string | null
  model_override: string | null
  reply_style: string
  proactive: string | null
  updated_at: number
  interests: string | null
  card: string | null
  card_url: string | null
  card_filename: string | null
  in_contacts: number | null
  proactive_enabled: number | null
  proactive_mode: string | null
  sticker_pack_ids: string | null
  relationship_stage: string | null
  relationship_description: string | null
  last_proactive_at: number | null
}

function parseInterests(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

function parseProactive(row: PersonaRow): AiPersona['proactive'] {
  if (row.proactive) {
    try {
      const parsed = JSON.parse(row.proactive) as Partial<AiPersona['proactive']>
      return {
        enabled: parsed.enabled ?? row.proactive_enabled === 1,
        triggerMode: parsed.triggerMode,
        minIdleHours: parsed.minIdleHours ?? PROACTIVE_DEFAULTS.minIdleHours,
        maxPerDay: parsed.maxPerDay ?? PROACTIVE_DEFAULTS.maxPerDay,
        chanceUnit: parsed.chanceUnit,
        chanceProbability: parsed.chanceProbability,
        chanceCooldownMinutes: parsed.chanceCooldownMinutes,
        windowStart: parsed.windowStart,
        windowEnd: parsed.windowEnd,
      }
    } catch {
      /* 落到默认值 */
    }
  }
  return {
    enabled: row.proactive_enabled === 1,
    minIdleHours: PROACTIVE_DEFAULTS.minIdleHours,
    maxPerDay: PROACTIVE_DEFAULTS.maxPerDay,
  }
}

/**
 * sticker_pack_ids 列存 JSON 数组字符串；解析失败或空数组一律当「跟随全局」（null）。
 * 与服务端 repo/ai.ts 的 parseStickerPackIds 保持同一口径。
 */
function parseStickerPackIds(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const ids = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

/** relationship_stage 列的容错解析：没存过的旧值一律回退陌生；描述为空表示还没建立关系 */
function parseRelationship(row: PersonaRow): PersonaRelationship | null {
  const description = row.relationship_description?.trim() ?? ''
  if (!description) return null
  const stage = (row.relationship_stage ?? 'stranger') in RELATIONSHIP_STAGE_LABELS
    ? (row.relationship_stage as RelationshipStage)
    : 'stranger'
  return { stage, description }
}

export function mapPersona(row: PersonaRow): AiPersona {
  const proactive = parseProactive(row)
  return {
    // ownerId 只用于服务端鉴权，本地镜像不落这一列
    ownerId: '',
    id: row.id,
    name: row.name,
    avatarUrl: row.avatar_url,
    systemPrompt: row.system_prompt,
    greeting: row.greeting,
    interests: parseInterests(row.interests),
    card: row.card,
    cardUrl: row.card_url,
    cardFilename: row.card_filename,
    inContacts: row.in_contacts !== 0,
    providerId: row.provider_id,
    modelOverride: row.model_override,
    temperature: null,
    replyStyle: row.reply_style as ReplyStyle,
    stickerPackIds: parseStickerPackIds(row.sticker_pack_ids),
    relationship: parseRelationship(row),
    proactive,
    proactiveMode: row.proactive_mode === 'custom' ? 'custom' : 'global',
    lastProactiveAt: row.last_proactive_at,
    createdAt: 0,
    updatedAt: row.updated_at,
  }
}

export async function upsertPersona(serverId: string, persona: AiPersona): Promise<void> {
  await dbExecute(
    `INSERT INTO ai_personas
       (server_id, id, name, avatar_url, system_prompt, greeting, provider_id, model_override,
        reply_style, proactive, updated_at, interests, card, card_url, card_filename,
        in_contacts, proactive_enabled, proactive_mode, sticker_pack_ids,
        relationship_stage, relationship_description, last_proactive_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT(server_id, id) DO UPDATE SET
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       system_prompt = excluded.system_prompt,
       greeting = excluded.greeting,
       provider_id = excluded.provider_id,
       model_override = excluded.model_override,
       reply_style = excluded.reply_style,
       proactive = excluded.proactive,
       updated_at = excluded.updated_at,
       interests = excluded.interests,
       card = excluded.card,
       card_url = excluded.card_url,
       card_filename = excluded.card_filename,
       in_contacts = excluded.in_contacts,
       proactive_enabled = excluded.proactive_enabled,
       proactive_mode = excluded.proactive_mode,
       sticker_pack_ids = excluded.sticker_pack_ids,
       relationship_stage = excluded.relationship_stage,
       relationship_description = excluded.relationship_description,
       last_proactive_at = excluded.last_proactive_at`,
    [
      serverId,
      persona.id,
      persona.name,
      persona.avatarUrl ?? null,
      persona.systemPrompt,
      persona.greeting ?? null,
      persona.providerId ?? null,
      persona.modelOverride ?? null,
      persona.replyStyle,
      JSON.stringify(persona.proactive),
      persona.updatedAt,
      JSON.stringify(persona.interests ?? []),
      persona.card ?? null,
      persona.cardUrl ?? null,
      persona.cardFilename ?? null,
      persona.inContacts ? 1 : 0,
      persona.proactive.enabled ? 1 : 0,
      persona.proactiveMode,
      persona.stickerPackIds?.length ? JSON.stringify(persona.stickerPackIds) : null,
      persona.relationship?.stage ?? 'stranger',
      persona.relationship?.description ?? '',
      persona.lastProactiveAt ?? null,
    ],
  )
}

export async function deletePersona(serverId: string, id: string): Promise<void> {
  await dbExecute('DELETE FROM ai_personas WHERE server_id = $1 AND id = $2', [serverId, id])
}

/**
 * 用服务端的角色列表对齐本地镜像：删掉该服务器下已经不存在的角色。
 * 只删本服务器的行，不碰其他服务器的镜像。
 */
export async function prunePersonas(serverId: string, keepIds: string[]): Promise<void> {
  if (keepIds.length === 0) {
    await dbExecute('DELETE FROM ai_personas WHERE server_id = $1', [serverId])
    return
  }
  const slots = keepIds.map((_, index) => `$${index + 2}`).join(',')
  await dbExecute(`DELETE FROM ai_personas WHERE server_id = $1 AND id NOT IN (${slots})`, [
    serverId,
    ...keepIds,
  ])
}

export async function listPersonas(serverId: string): Promise<AiPersona[]> {
  const rows = await dbSelect<PersonaRow>(
    'SELECT * FROM ai_personas WHERE server_id = $1 ORDER BY updated_at DESC',
    [serverId],
  )
  return rows.map(mapPersona)
}
