import type { AiPersona, ReplyStyle } from '@nenochat/shared'
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
        minIdleHours: parsed.minIdleHours ?? 6,
        maxPerDay: parsed.maxPerDay ?? 1,
        windowStart: parsed.windowStart,
        windowEnd: parsed.windowEnd,
      }
    } catch {
      /* 落到默认值 */
    }
  }
  return {
    enabled: row.proactive_enabled === 1,
    minIdleHours: 6,
    maxPerDay: 1,
  }
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
        in_contacts, proactive_enabled, proactive_mode, last_proactive_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
      persona.lastProactiveAt ?? null,
    ],
  )
}

export async function deletePersona(serverId: string, id: string): Promise<void> {
  await dbExecute('DELETE FROM ai_personas WHERE server_id = $1 AND id = $2', [serverId, id])
}

export async function listPersonas(serverId: string): Promise<AiPersona[]> {
  const rows = await dbSelect<PersonaRow>(
    'SELECT * FROM ai_personas WHERE server_id = $1 ORDER BY updated_at DESC',
    [serverId],
  )
  return rows.map(mapPersona)
}
