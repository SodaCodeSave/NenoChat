import type {
  AiGlobalSettings,
  AiMemoryFact,
  AiPersona,
  AiProvider,
  AiProviderModel,
  AiSession,
  MemoryFactSubject,
  PersonaRelationship,
  ProactiveConfig,
  ProactiveMode,
  RelationshipStage,
  ReplyStyle,
} from '@nenochat/shared'
import {
  GROUP_AI_DEFAULTS,
  MOMENT_AI_DEFAULTS,
  PROACTIVE_DEFAULTS,
  RELATIONSHIP_STAGE_LABELS,
  SEGMENT_REPLY_DEFAULTS,
  ulid,
} from '@nenochat/shared'
import { all, one, run, type Executor } from '../index'
import { now } from '../../util/clock'

/* ------------------------------- 服务商 ------------------------------- */

export interface ProviderRow {
  id: string
  owner_id: string
  name: string
  base_url: string
  api_key_enc: string | null
  key_location: string
  model: string
  vision_model: string | null
  context_window: number | null
  models_json: string | null
  temperature: number
  max_tokens: number
  extra_headers: string | null
  is_default: number
  balance: string | null
  balance_currency: string | null
  balance_checked_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** models_json 解析失败或不是数组时按空列表处理，坏数据不影响服务商正常使用 */
export function parseProviderModels(raw: string | null): AiProviderModel[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is AiProviderModel =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as AiProviderModel).model === 'string' &&
          (item as AiProviderModel).model.length > 0,
      )
      // 旧数据没有 priceCached 字段，规范成 null，避免透传 undefined
      .map((item) => ({ ...item, priceCached: item.priceCached ?? null }))
  } catch {
    return []
  }
}

export function mapProvider(row: ProviderRow, apiKeyMasked: string | null = null): AiProvider {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    baseUrl: row.base_url,
    apiKeyMasked,
    model: row.model,
    visionModel: row.vision_model,
    contextWindow: row.context_window,
    models: parseProviderModels(row.models_json),
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    isDefault: row.is_default === 1,
    balance: row.balance,
    balanceCurrency: row.balance_currency,
    balanceCheckedAt: row.balance_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listProviders(db: Executor, ownerId: string): Promise<ProviderRow[]> {
  return all<ProviderRow>(
    db,
    'SELECT * FROM ai_providers WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at',
    [ownerId],
  )
}

export async function findProvider(db: Executor, id: string): Promise<ProviderRow | undefined> {
  return one<ProviderRow>(db, 'SELECT * FROM ai_providers WHERE id = ? AND deleted_at IS NULL', [id])
}

export interface CreateProviderInput {
  ownerId: string
  name: string
  baseUrl: string
  apiKeyEnc: string | null
  model: string
  visionModel?: string | null
  contextWindow?: number | null
  models?: AiProviderModel[] | null
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
}

export async function createProvider(db: Executor, input: CreateProviderInput): Promise<ProviderRow> {
  const ts = now()
  const id = ulid()
  // RETURNING 一次拿到落库后的完整行，省去额外的回读查询
  const row = await one<ProviderRow>(
    db,
    `INSERT INTO ai_providers
       (id, owner_id, name, base_url, api_key_enc, key_location, model, vision_model, context_window,
        models_json, temperature, max_tokens, extra_headers, is_default, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
     RETURNING *`,
    [
      id,
      input.ownerId,
      input.name,
      input.baseUrl,
      input.apiKeyEnc,
      'server',
      input.model,
      input.visionModel ?? null,
      input.contextWindow ?? null,
      input.models?.length ? JSON.stringify(input.models) : null,
      input.temperature ?? 0.8,
      input.maxTokens ?? 2048,
      input.isDefault ? 1 : 0,
      ts,
      ts,
    ],
  )
  if (!row) throw new Error('创建服务商后回读失败')
  return row
}

export async function updateProvider(
  db: Executor,
  id: string,
  patch: Partial<CreateProviderInput> & { apiKeyEnc?: string | null; name?: string; baseUrl?: string; model?: string },
): Promise<ProviderRow> {
  const current = await findProvider(db, id)
  if (!current) throw new Error('服务商不存在')

  const row = await one<ProviderRow>(
    db,
    `UPDATE ai_providers
     SET name = ?, base_url = ?, api_key_enc = ?, key_location = ?, model = ?, vision_model = ?,
         context_window = ?, models_json = ?, temperature = ?, max_tokens = ?, is_default = ?, updated_at = ?
     WHERE id = ?
     RETURNING *`,
    [
      patch.name ?? current.name,
      patch.baseUrl ?? current.base_url,
      patch.apiKeyEnc === undefined ? current.api_key_enc : patch.apiKeyEnc,
      'server',
      patch.model ?? current.model,
      patch.visionModel === undefined ? current.vision_model : patch.visionModel || null,
      patch.contextWindow === undefined ? current.context_window : patch.contextWindow,
      // undefined = 不改动；数组（含空数组）= 整体替换，空数组即清空列表
      patch.models === undefined ? current.models_json : patch.models?.length ? JSON.stringify(patch.models) : null,
      patch.temperature ?? current.temperature,
      patch.maxTokens ?? current.max_tokens,
      patch.isDefault === undefined ? current.is_default : patch.isDefault ? 1 : 0,
      now(),
      id,
    ],
  )
  if (!row) throw new Error('更新服务商后回读失败')
  return row
}

export async function softDeleteProvider(db: Executor, id: string): Promise<void> {
  await run(db, 'UPDATE ai_providers SET deleted_at = ?, updated_at = ? WHERE id = ?', [now(), now(), id])
}

/** 只写余额缓存，不碰 updated_at，避免触发同步 */
export async function saveProviderBalance(
  db: Executor,
  id: string,
  balance: { amount: string; currency: string } | null,
): Promise<void> {
  await run(
    db,
    'UPDATE ai_providers SET balance = ?, balance_currency = ?, balance_checked_at = ? WHERE id = ?',
    [balance?.amount ?? null, balance?.currency ?? null, now(), id],
  )
}

/* ----------------------------- 图片描述缓存 ----------------------------- */

/** 同一张图（sha256 相同）只识图一次，命中直接返回缓存的描述 */
export async function findImageDescription(db: Executor, sha256: string): Promise<string | null> {
  const row = await one<{ description: string }>(
    db,
    'SELECT description FROM ai_image_descriptions WHERE sha256 = ?',
    [sha256],
  )
  return row?.description ?? null
}

export async function saveImageDescription(
  db: Executor,
  sha256: string,
  description: string,
  model: string | null,
): Promise<void> {
  const ts = now()
  await run(
    db,
    `INSERT INTO ai_image_descriptions (sha256, description, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at`,
    [sha256, description, model, ts, ts],
  )
}

export async function defaultProvider(db: Executor, ownerId: string): Promise<ProviderRow | undefined> {
  return one<ProviderRow>(
    db,
    `SELECT * FROM ai_providers WHERE owner_id = ? AND deleted_at IS NULL
     ORDER BY is_default DESC, created_at LIMIT 1`,
    [ownerId],
  )
}

/** 管理面板配置的服务器供应商统一挂在这个影子账号名下（0039 迁移种入） */
export const SYSTEM_AI_OWNER_ID = 'system-ai'

/** 共享开关存 server_settings（JSON 编码）；键没出现或解析失败一律视为关 */
export async function isSharedModeEnabled(db: Executor): Promise<boolean> {
  const row = await one<{ value: string }>(db, 'SELECT value FROM server_settings WHERE key = ?', [
    'ai_shared_mode',
  ])
  if (!row) return false
  try {
    return JSON.parse(row.value) === true
  } catch {
    return false
  }
}

/** 共享模式开启时返回服务器供应商列表，否则空数组（识图等按条件扫描的场景用） */
export async function listSharedProvidersIfEnabled(db: Executor): Promise<ProviderRow[]> {
  if (!(await isSharedModeEnabled(db))) return []
  return listProviders(db, SYSTEM_AI_OWNER_ID)
}

/**
 * 生成时的供应商解析。
 * 共享模式开启 = 自定义供应商整体禁用：无视角色/会话/客户端指定，一律服务器供应商；
 * 关闭时只认用户自己的。
 */
export async function defaultProviderWithShared(
  db: Executor,
  ownerId: string,
): Promise<ProviderRow | undefined> {
  if (await isSharedModeEnabled(db)) {
    return defaultProvider(db, SYSTEM_AI_OWNER_ID)
  }
  return defaultProvider(db, ownerId)
}

/* -------------------------------- 人设 -------------------------------- */

export interface PersonaRow {
  id: string
  owner_id: string
  /** 影子账号 id，角色进群/加好友时用它 */
  user_id: string | null
  name: string
  avatar_url: string | null
  system_prompt: string
  greeting: string | null
  interests: string
  card: string | null
  card_url: string | null
  card_filename: string | null
  in_contacts: number
  provider_id: string | null
  model_override: string | null
  temperature: number | null
  reply_style: string
  /** 角色级表情包白名单 JSON 数组；NULL = 跟随全局授权 */
  sticker_pack_ids: string | null
  /** 与用户的关系阶段；描述为空表示还没建立关系 */
  relationship_stage: string
  relationship_description: string
  proactive_enabled: number
  proactive_config: string | null
  proactive_mode: string
  last_proactive_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** interests 列存 JSON 数组字符串，解析失败一律当空数组（历史数据兼容） */
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

function parseProactive(row: PersonaRow): ProactiveConfig {
  if (row.proactive_config) {
    try {
      const parsed = JSON.parse(row.proactive_config) as Partial<ProactiveConfig>
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
 * 只有显式存了至少一个分组 id 才算白名单模式。
 */
export function parseStickerPackIds(raw: string | null): string[] | null {
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

/** relationship_stage 列的容错解析：没存过的旧值一律回退陌生 */
function parseRelationshipStage(raw: string): RelationshipStage {
  return (raw in RELATIONSHIP_STAGE_LABELS ? raw : 'stranger') as RelationshipStage
}

/** 描述为空表示还没建立关系，统一映射成 null */
function parseRelationship(row: PersonaRow): PersonaRelationship | null {
  const description = row.relationship_description?.trim() ?? ''
  if (!description) return null
  return { stage: parseRelationshipStage(row.relationship_stage), description }
}

export function mapPersona(row: PersonaRow): AiPersona {
  return {
    id: row.id,
    ownerId: row.owner_id,
    userId: row.user_id,
    name: row.name,
    avatarUrl: row.avatar_url,
    systemPrompt: row.system_prompt,
    greeting: row.greeting,
    interests: parseInterests(row.interests),
    card: row.card,
    cardUrl: row.card_url,
    cardFilename: row.card_filename,
    inContacts: row.in_contacts === 1,
    providerId: row.provider_id,
    modelOverride: row.model_override,
    temperature: row.temperature,
    replyStyle: row.reply_style as ReplyStyle,
    stickerPackIds: parseStickerPackIds(row.sticker_pack_ids),
    relationship: parseRelationship(row),
    proactive: parseProactive(row),
    proactiveMode: row.proactive_mode === 'custom' ? 'custom' : 'global',
    lastProactiveAt: row.last_proactive_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listPersonas(db: Executor, ownerId: string): Promise<PersonaRow[]> {
  return all<PersonaRow>(
    db,
    'SELECT * FROM ai_personas WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at',
    [ownerId],
  )
}

export async function findPersona(db: Executor, id: string): Promise<PersonaRow | undefined> {
  return one<PersonaRow>(db, 'SELECT * FROM ai_personas WHERE id = ? AND deleted_at IS NULL', [id])
}

export interface CreatePersonaInput {
  ownerId: string
  name: string
  systemPrompt: string
  avatarUrl?: string | null
  interests?: string[]
  card?: string | null
  cardUrl?: string | null
  cardFilename?: string | null
  inContacts?: boolean
  providerId?: string | null
  modelOverride?: string | null
  temperature?: number | null
  replyStyle?: ReplyStyle
  greeting?: string | null
  stickerPackIds?: string[] | null
  /** 初始关系；不传或 null 表示还没建立关系 */
  relationship?: PersonaRelationship | null
  proactive?: Partial<ProactiveConfig>
  proactiveMode?: ProactiveMode
}

export async function createPersona(db: Executor, input: CreatePersonaInput): Promise<PersonaRow> {
  const ts = now()
  const id = ulid()
  const proactive: ProactiveConfig = {
    enabled: input.proactive?.enabled ?? false,
    triggerMode: input.proactive?.triggerMode,
    minIdleHours: input.proactive?.minIdleHours ?? PROACTIVE_DEFAULTS.minIdleHours,
    maxPerDay: input.proactive?.maxPerDay ?? PROACTIVE_DEFAULTS.maxPerDay,
    chanceUnit: input.proactive?.chanceUnit,
    chanceProbability: input.proactive?.chanceProbability,
    chanceCooldownMinutes: input.proactive?.chanceCooldownMinutes,
    windowStart: input.proactive?.windowStart,
    windowEnd: input.proactive?.windowEnd,
  }
  // 显式开了主动消息却没说是哪种模式，按「没打算跟随全局」处理
  const mode: ProactiveMode = input.proactiveMode ?? (proactive.enabled ? 'custom' : 'global')
  const relationship = input.relationship?.description.trim()
    ? {
        stage: parseRelationshipStage(input.relationship.stage),
        description: input.relationship.description.trim(),
      }
    : null

  const row = await one<PersonaRow>(
    db,
    `INSERT INTO ai_personas
       (id, owner_id, name, avatar_url, system_prompt, greeting, interests, card, card_url,
        card_filename, in_contacts, provider_id, model_override, temperature, reply_style,
        sticker_pack_ids, relationship_stage, relationship_description,
        proactive_enabled, proactive_config, proactive_mode,
        last_proactive_at, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
     RETURNING *`,
    [
      id,
      input.ownerId,
      input.name,
      input.avatarUrl ?? null,
      input.systemPrompt,
      input.greeting ?? null,
      JSON.stringify(input.interests ?? []),
      input.card ?? null,
      input.cardUrl ?? null,
      input.cardFilename ?? null,
      input.inContacts === false ? 0 : 1,
      input.providerId ?? null,
      input.modelOverride ?? null,
      input.temperature ?? null,
      input.replyStyle ?? 'chatty',
      input.stickerPackIds?.length ? JSON.stringify(input.stickerPackIds) : null,
      relationship?.stage ?? 'stranger',
      relationship?.description ?? '',
      proactive.enabled ? 1 : 0,
      JSON.stringify(proactive),
      mode,
      ts,
      ts,
    ],
  )
  if (!row) throw new Error('创建角色后回读失败')
  return row
}

export interface UpdatePersonaInput {
  name?: string
  systemPrompt?: string
  avatarUrl?: string | null
  interests?: string[]
  card?: string | null
  cardUrl?: string | null
  cardFilename?: string | null
  inContacts?: boolean
  providerId?: string | null
  modelOverride?: string | null
  temperature?: number | null
  replyStyle?: ReplyStyle
  greeting?: string | null
  stickerPackIds?: string[] | null
  /** undefined = 不改；null = 清掉关系；对象 = 整体覆盖阶段与描述 */
  relationship?: PersonaRelationship | null
  proactive?: Partial<ProactiveConfig>
  proactiveMode?: ProactiveMode
}

export async function updatePersona(db: Executor, id: string, patch: UpdatePersonaInput): Promise<PersonaRow> {
  const current = await findPersona(db, id)
  if (!current) throw new Error('角色不存在')

  const nextProactive: ProactiveConfig = {
    ...parseProactive(current),
    ...patch.proactive,
  }
  // 单独打开主动消息的角色自动切成自定义模式，避免「勾了却没生效」
  const nextMode: ProactiveMode =
    patch.proactiveMode ??
    (patch.proactive?.enabled === true
      ? 'custom'
      : current.proactive_mode === 'custom'
        ? 'custom'
        : 'global')
  const nextRelationship = patch.relationship?.description.trim()
    ? {
        stage: parseRelationshipStage(patch.relationship.stage),
        description: patch.relationship.description.trim(),
      }
    : null

  const row = await one<PersonaRow>(
    db,
    `UPDATE ai_personas
     SET name = ?, avatar_url = ?, system_prompt = ?, greeting = ?, interests = ?, card = ?,
         card_url = ?, card_filename = ?, in_contacts = ?, provider_id = ?,
         model_override = ?, temperature = ?, reply_style = ?, sticker_pack_ids = ?,
         relationship_stage = ?, relationship_description = ?,
         proactive_enabled = ?, proactive_config = ?, proactive_mode = ?, updated_at = ?
     WHERE id = ?
     RETURNING *`,
    [
      patch.name ?? current.name,
      patch.avatarUrl === undefined ? current.avatar_url : patch.avatarUrl,
      patch.systemPrompt ?? current.system_prompt,
      patch.greeting === undefined ? current.greeting : patch.greeting,
      patch.interests === undefined ? current.interests : JSON.stringify(patch.interests),
      patch.card === undefined ? current.card : patch.card,
      patch.cardUrl === undefined ? current.card_url : patch.cardUrl,
      patch.cardFilename === undefined ? current.card_filename : patch.cardFilename,
      patch.inContacts === undefined ? current.in_contacts : patch.inContacts ? 1 : 0,
      patch.providerId === undefined ? current.provider_id : patch.providerId,
      patch.modelOverride === undefined ? current.model_override : patch.modelOverride,
      patch.temperature === undefined ? current.temperature : patch.temperature,
      patch.replyStyle ?? current.reply_style,
      // 空数组与 undefined 语义不同：undefined = 不改，[] / null = 清空白名单回到跟随全局
      patch.stickerPackIds === undefined
        ? current.sticker_pack_ids
        : patch.stickerPackIds?.length
          ? JSON.stringify(patch.stickerPackIds)
          : null,
      // undefined = 不改，null 或空描述 = 清掉关系回到「还没建立」
      patch.relationship === undefined ? current.relationship_stage : (nextRelationship?.stage ?? 'stranger'),
      patch.relationship === undefined ? current.relationship_description : (nextRelationship?.description ?? ''),
      nextProactive.enabled ? 1 : 0,
      JSON.stringify(nextProactive),
      nextMode,
      now(),
      id,
    ],
  )
  if (!row) throw new Error('更新角色后回读失败')
  return row
}

export async function softDeletePersona(db: Executor, id: string): Promise<void> {
  await run(db, 'UPDATE ai_personas SET deleted_at = ?, updated_at = ? WHERE id = ?', [now(), now(), id])
}

/** 建角色时先插 persona 再补影子账号，两边 id 一一对应 */
export async function setPersonaUserId(db: Executor, id: string, userId: string): Promise<void> {
  await run(db, 'UPDATE ai_personas SET user_id = ?, updated_at = ? WHERE id = ?', [userId, now(), id])
}

/** 按影子账号反查角色：群成员里哪些是 AI 靠它判断 */
export async function findPersonaByUserId(db: Executor, userId: string): Promise<PersonaRow | undefined> {
  return one<PersonaRow>(db, 'SELECT * FROM ai_personas WHERE user_id = ? AND deleted_at IS NULL', [userId])
}

/* ---------------------------- 自动互动全局设置 ---------------------------- */

export interface GlobalSettingsRow {
  user_id: string
  proactive_enabled: number
  proactive_config: string
  moments_enabled: number
  moments_posts_per_day: number
  moments_comments_per_day: number
  moments_likes_per_day: number
  group_enabled: number
  group_replies_per_day: number
  group_replies_per_message: number
  group_reply_probability: number | null
  group_reply_cooldown_minutes: number | null
  group_autonomy_per_day: number
  segment_enabled: number
  segment_pattern: string
  stream_enabled: number
  relationship_enabled: number
  debug_mode: number
  updated_at: number
}

export async function findGlobalSettings(db: Executor, userId: string): Promise<GlobalSettingsRow | undefined> {
  return one<GlobalSettingsRow>(db, 'SELECT * FROM ai_global_settings WHERE user_id = ?', [userId])
}

/**
 * 读设置：没有记录时返回默认值而不是 undefined，
 * 调用方（调度器、设置页）都不需要再写一套兜底。
 */
export async function readGlobalSettings(db: Executor, userId: string): Promise<AiGlobalSettings> {
  const row = await findGlobalSettings(db, userId)
  const fallback: AiGlobalSettings = {
    proactiveEnabled: false,
    minIdleHours: PROACTIVE_DEFAULTS.minIdleHours,
    maxPerDay: PROACTIVE_DEFAULTS.maxPerDay,
    triggerMode: PROACTIVE_DEFAULTS.triggerMode,
    chanceUnit: PROACTIVE_DEFAULTS.chanceUnit,
    chanceProbability: PROACTIVE_DEFAULTS.chanceProbability,
    chanceCooldownMinutes: PROACTIVE_DEFAULTS.chanceCooldownMinutes,
    windowStart: null,
    windowEnd: null,
    momentsEnabled: false,
    momentsPostsPerDay: MOMENT_AI_DEFAULTS.postsPerDay,
    momentsCommentsPerDay: MOMENT_AI_DEFAULTS.commentsPerDay,
    momentsLikesPerDay: MOMENT_AI_DEFAULTS.likesPerDay,
    groupEnabled: true,
    groupRepliesPerDay: GROUP_AI_DEFAULTS.repliesPerDay,
    groupRepliesPerMessage: GROUP_AI_DEFAULTS.repliesPerMessage,
    groupReplyProbability: null,
    groupReplyCooldownMinutes: null,
    groupAutonomyPerDay: GROUP_AI_DEFAULTS.autonomyPerDay,
    segmentEnabled: SEGMENT_REPLY_DEFAULTS.enabled,
    segmentPattern: SEGMENT_REPLY_DEFAULTS.pattern,
    streamEnabled: false,
    relationshipEnabled: true,
    debugMode: false,
    updatedAt: 0,
  }
  if (!row) return fallback

  let proactive: Partial<ProactiveConfig> = {}
  try {
    proactive = JSON.parse(row.proactive_config) as Partial<ProactiveConfig>
  } catch {
    proactive = {}
  }

  return {
    proactiveEnabled: row.proactive_enabled === 1,
    minIdleHours: proactive.minIdleHours ?? fallback.minIdleHours,
    maxPerDay: proactive.maxPerDay ?? fallback.maxPerDay,
    triggerMode: proactive.triggerMode ?? fallback.triggerMode,
    chanceUnit: proactive.chanceUnit ?? fallback.chanceUnit,
    chanceProbability: proactive.chanceProbability ?? fallback.chanceProbability,
    chanceCooldownMinutes: proactive.chanceCooldownMinutes ?? fallback.chanceCooldownMinutes,
    windowStart: proactive.windowStart ?? null,
    windowEnd: proactive.windowEnd ?? null,
    momentsEnabled: row.moments_enabled === 1,
    momentsPostsPerDay: row.moments_posts_per_day,
    momentsCommentsPerDay: row.moments_comments_per_day,
    momentsLikesPerDay: row.moments_likes_per_day,
    groupEnabled: row.group_enabled === 1,
    groupRepliesPerDay: row.group_replies_per_day,
    groupRepliesPerMessage: row.group_replies_per_message ?? GROUP_AI_DEFAULTS.repliesPerMessage,
    groupReplyProbability: row.group_reply_probability ?? null,
    groupReplyCooldownMinutes: row.group_reply_cooldown_minutes ?? null,
    groupAutonomyPerDay: row.group_autonomy_per_day,
    segmentEnabled: row.segment_enabled === 1,
    segmentPattern: row.segment_pattern || fallback.segmentPattern,
    streamEnabled: row.stream_enabled === 1,
    relationshipEnabled: row.relationship_enabled === 1,
    debugMode: row.debug_mode === 1,
    updatedAt: row.updated_at,
  }
}

export async function writeGlobalSettings(
  db: Executor,
  userId: string,
  patch: Partial<Omit<AiGlobalSettings, 'updatedAt'>>,
): Promise<AiGlobalSettings> {
  const current = await readGlobalSettings(db, userId)
  const next = { ...current, ...patch }
  const ts = now()

  await run(
    db,
    `INSERT INTO ai_global_settings
       (user_id, proactive_enabled, proactive_config, moments_enabled, moments_posts_per_day,
        moments_comments_per_day, moments_likes_per_day, group_enabled, group_replies_per_day,
        group_replies_per_message, group_reply_probability, group_reply_cooldown_minutes,
        group_autonomy_per_day, segment_enabled, segment_pattern, stream_enabled,
        relationship_enabled, debug_mode, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       proactive_enabled = excluded.proactive_enabled,
       proactive_config = excluded.proactive_config,
       moments_enabled = excluded.moments_enabled,
       moments_posts_per_day = excluded.moments_posts_per_day,
       moments_comments_per_day = excluded.moments_comments_per_day,
       moments_likes_per_day = excluded.moments_likes_per_day,
       group_enabled = excluded.group_enabled,
       group_replies_per_day = excluded.group_replies_per_day,
       group_replies_per_message = excluded.group_replies_per_message,
       group_reply_probability = excluded.group_reply_probability,
       group_reply_cooldown_minutes = excluded.group_reply_cooldown_minutes,
       group_autonomy_per_day = excluded.group_autonomy_per_day,
       segment_enabled = excluded.segment_enabled,
       segment_pattern = excluded.segment_pattern,
       stream_enabled = excluded.stream_enabled,
       relationship_enabled = excluded.relationship_enabled,
       debug_mode = excluded.debug_mode,
       updated_at = excluded.updated_at`,
    [
      userId,
      next.proactiveEnabled ? 1 : 0,
      JSON.stringify({
        minIdleHours: next.minIdleHours,
        maxPerDay: next.maxPerDay,
        triggerMode: next.triggerMode,
        chanceUnit: next.chanceUnit,
        chanceProbability: next.chanceProbability,
        chanceCooldownMinutes: next.chanceCooldownMinutes,
        windowStart: next.windowStart ?? undefined,
        windowEnd: next.windowEnd ?? undefined,
      }),
      next.momentsEnabled ? 1 : 0,
      next.momentsPostsPerDay,
      next.momentsCommentsPerDay,
      next.momentsLikesPerDay,
      next.groupEnabled ? 1 : 0,
      next.groupRepliesPerDay,
      next.groupRepliesPerMessage,
      next.groupReplyProbability ?? null,
      next.groupReplyCooldownMinutes ?? null,
      next.groupAutonomyPerDay,
      next.segmentEnabled ? 1 : 0,
      next.segmentPattern,
      next.streamEnabled ? 1 : 0,
      next.relationshipEnabled ? 1 : 0,
      next.debugMode ? 1 : 0,
      ts,
    ],
  )

  return { ...next, updatedAt: ts }
}

/** 打开了动态互动的用户，供调度器逐个扫描 */
export async function listUsersWithMomentsEnabled(db: Executor): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    db,
    'SELECT user_id FROM ai_global_settings WHERE moments_enabled = 1',
  )
  return rows.map((row) => row.user_id)
}

/* ------------------------------ 会话扩展 ------------------------------ */

export interface SessionRow {
  conversation_id: string
  persona_id: string
  provider_id: string
  memory_enabled: number
  last_compacted_seq: number
  messages_since_compact: number
  token_estimate: number
  created_at: number
  updated_at: number
}

export async function findSession(db: Executor, conversationId: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(db, 'SELECT * FROM ai_sessions WHERE conversation_id = ?', [conversationId])
}

export function mapSession(row: SessionRow): AiSession {
  return {
    conversationId: row.conversation_id,
    personaId: row.persona_id,
    providerId: row.provider_id,
    memoryEnabled: row.memory_enabled === 1,
    lastCompactedSeq: row.last_compacted_seq,
    messagesSinceCompact: row.messages_since_compact,
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createSession(
  db: Executor,
  input: { conversationId: string; personaId: string; providerId: string },
): Promise<SessionRow> {
  const ts = now()
  const row = await one<SessionRow>(
    db,
    `INSERT INTO ai_sessions
       (conversation_id, persona_id, provider_id, memory_enabled, last_compacted_seq,
        messages_since_compact, token_estimate, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?)
     RETURNING *`,
    [input.conversationId, input.personaId, input.providerId, ts, ts],
  )
  if (!row) throw new Error('创建 AI 会话扩展失败')
  return row
}

export async function bumpSessionProgress(db: Executor, conversationId: string, messageCount: number, tokens: number): Promise<void> {
  await run(
    db,
    `UPDATE ai_sessions
     SET messages_since_compact = messages_since_compact + ?,
         token_estimate = token_estimate + ?,
         updated_at = ?
     WHERE conversation_id = ?`,
    [messageCount, tokens, now(), conversationId],
  )
}

export async function markCompacted(db: Executor, conversationId: string, upToSeq: number): Promise<void> {
  await run(
    db,
    `UPDATE ai_sessions
     SET last_compacted_seq = ?, messages_since_compact = 0, updated_at = ?
     WHERE conversation_id = ?`,
    [upToSeq, now(), conversationId],
  )
}

/* -------------------------------- 记忆 -------------------------------- */

interface SummaryRow {
  id: string
  conversation_id: string
  from_seq: number
  to_seq: number
  summary: string
  token_estimate: number
  model: string | null
  superseded_by: string | null
  created_at: number
}

export function mapSummary(row: SummaryRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    fromSeq: row.from_seq,
    toSeq: row.to_seq,
    summary: row.summary,
    tokenEstimate: row.token_estimate,
    model: row.model,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  }
}

/** 只返回未被替代的摘要（滚动链的头部） */
export async function listSummaries(db: Executor, conversationId: string) {
  const rows = await all<SummaryRow>(
    db,
    `SELECT * FROM ai_memory_summaries
     WHERE conversation_id = ? AND superseded_by IS NULL
     ORDER BY to_seq DESC LIMIT 10`,
    [conversationId],
  )
  return rows.map(mapSummary)
}

export async function latestSummary(db: Executor, conversationId: string) {
  const row = await one<SummaryRow>(
    db,
    `SELECT * FROM ai_memory_summaries
     WHERE conversation_id = ? AND superseded_by IS NULL
     ORDER BY to_seq DESC LIMIT 1`,
    [conversationId],
  )
  return row ? mapSummary(row) : null
}

export async function insertSummary(
  db: Executor,
  input: { conversationId: string; fromSeq: number; toSeq: number; summary: string; tokenEstimate: number; model?: string | null },
): Promise<string> {
  const id = ulid()
  const superseded = await all<{ id: string }>(
    db,
    'SELECT id FROM ai_memory_summaries WHERE conversation_id = ? AND superseded_by IS NULL',
    [input.conversationId],
  )

  await run(
    db,
    `INSERT INTO ai_memory_summaries
       (id, conversation_id, from_seq, to_seq, summary, token_estimate, model, superseded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      id,
      input.conversationId,
      input.fromSeq,
      input.toSeq,
      input.summary,
      input.tokenEstimate,
      input.model ?? null,
      now(),
    ],
  )

  for (const row of superseded) {
    await run(db, 'UPDATE ai_memory_summaries SET superseded_by = ? WHERE id = ?', [id, row.id])
  }

  return id
}

interface FactRow {
  id: string
  conversation_id: string
  subject: string
  key: string
  value: string
  confidence: number
  source_message_id: string | null
  status: string
  superseded_by: string | null
  created_at: number
  updated_at: number
}

export function mapFact(row: FactRow): AiMemoryFact {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    subject: row.subject as MemoryFactSubject,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    sourceMessageId: row.source_message_id,
    status: row.status as AiMemoryFact['status'],
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listFacts(db: Executor, conversationId: string): Promise<FactRow[]> {
  return all<FactRow>(
    db,
    `SELECT * FROM ai_memory_facts
     WHERE conversation_id = ? AND status = 'active'
     ORDER BY subject, key`,
    [conversationId],
  )
}

/**
 * 写入事实：同 (subject, key) 已有 active 值时，
 * 把旧值标记为 superseded 再插入新值，形成可追溯的覆盖链。
 */
export async function upsertFact(
  db: Executor,
  input: {
    conversationId: string
    subject: string
    key: string
    value: string
    confidence: number
    sourceMessageId?: string | null
  },
): Promise<string> {
  const existing = await one<FactRow>(
    db,
    `SELECT * FROM ai_memory_facts
     WHERE conversation_id = ? AND subject = ? AND key = ? AND status = 'active'`,
    [input.conversationId, input.subject, input.key],
  )

  const id = ulid()
  const ts = now()

  if (existing && existing.value === input.value) {
    await run(db, 'UPDATE ai_memory_facts SET confidence = ?, updated_at = ? WHERE id = ?', [
      Math.max(existing.confidence, input.confidence),
      ts,
      existing.id,
    ])
    return existing.id
  }

  if (existing) {
    await run(
      db,
      "UPDATE ai_memory_facts SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
      [id, ts, existing.id],
    )
  }

  await run(
    db,
    `INSERT INTO ai_memory_facts
       (id, conversation_id, subject, key, value, confidence, source_message_id, status,
        superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    [
      id,
      input.conversationId,
      input.subject,
      input.key,
      input.value,
      input.confidence,
      input.sourceMessageId ?? null,
      ts,
      ts,
    ],
  )
  return id
}

export async function rejectFact(db: Executor, conversationId: string, factId: string): Promise<void> {
  await run(
    db,
    "UPDATE ai_memory_facts SET status = 'rejected', updated_at = ? WHERE conversation_id = ? AND id = ?",
    [now(), conversationId, factId],
  )
}

/* ------------------------------ 生成记录 ------------------------------ */

export async function createGeneration(
  db: Executor,
  input: {
    conversationId: string
    userId: string
    userMessageId: string | null
    providerId: string
    personaId: string
    runLocation: 'local' | 'server'
    model: string
  },
): Promise<string> {
  const id = ulid()
  await run(
    db,
    `INSERT INTO ai_generations
       (id, conversation_id, user_id, user_message_id, provider_id, persona_id, run_location,
        model, status, error, prompt_tokens, completion_tokens, message_ids, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'streaming', NULL, NULL, NULL, NULL, ?, NULL)`,
    [
      id,
      input.conversationId,
      input.userId,
      input.userMessageId,
      input.providerId,
      input.personaId,
      input.runLocation,
      input.model,
      now(),
    ],
  )
  return id
}

export async function finishGeneration(
  db: Executor,
  id: string,
  patch: {
    status: 'done' | 'error' | 'cancelled'
    error?: string | null
    messageIds?: string[]
    promptTokens?: number | null
    completionTokens?: number | null
  },
): Promise<void> {
  await run(
    db,
    `UPDATE ai_generations
     SET status = ?, error = ?, message_ids = ?, prompt_tokens = ?, completion_tokens = ?, finished_at = ?
     WHERE id = ?`,
    [
      patch.status,
      patch.error ?? null,
      patch.messageIds ? JSON.stringify(patch.messageIds) : null,
      patch.promptTokens ?? null,
      patch.completionTokens ?? null,
      now(),
      id,
    ],
  )
}

/** 延迟投递途中把已送达的分段先写进 message_ids：终态还没到，进程挂了也不丢进度 */
export async function trackGenerationMessages(db: Executor, id: string, messageIds: string[]): Promise<void> {
  await run(db, 'UPDATE ai_generations SET message_ids = ? WHERE id = ?', [
    JSON.stringify(messageIds),
    id,
  ])
}
