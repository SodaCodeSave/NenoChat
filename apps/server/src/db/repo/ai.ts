import type {
  AiGlobalSettings,
  AiMemoryFact,
  AiPersona,
  AiProvider,
  AiSession,
  MemoryFactSubject,
  ProactiveConfig,
  ProactiveMode,
  ReplyStyle,
} from '@nenochat/shared'
import { GROUP_AI_DEFAULTS, MOMENT_AI_DEFAULTS, PROACTIVE_DEFAULTS, SEGMENT_REPLY_DEFAULTS, ulid } from '@nenochat/shared'
import type { DB } from '../index'
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

export function mapProvider(row: ProviderRow, apiKeyMasked: string | null = null): AiProvider {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    baseUrl: row.base_url,
    apiKeyMasked,
    keyLocation: row.key_location as AiProvider['keyLocation'],
    model: row.model,
    visionModel: row.vision_model,
    contextWindow: row.context_window,
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

export function listProviders(db: DB, ownerId: string): ProviderRow[] {
  return db
    .prepare('SELECT * FROM ai_providers WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(ownerId) as ProviderRow[]
}

export function findProvider(db: DB, id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM ai_providers WHERE id = ? AND deleted_at IS NULL').get(id) as
    | ProviderRow
    | undefined
}

export interface CreateProviderInput {
  ownerId: string
  name: string
  baseUrl: string
  apiKeyEnc: string | null
  keyLocation: 'local' | 'server'
  model: string
  visionModel?: string | null
  contextWindow?: number | null
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
}

export function createProvider(db: DB, input: CreateProviderInput): ProviderRow {
  const ts = now()
  const id = ulid()
  db.prepare(
    `INSERT INTO ai_providers
       (id, owner_id, name, base_url, api_key_enc, key_location, model, vision_model, context_window,
        temperature, max_tokens, extra_headers, is_default, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.ownerId,
    input.name,
    input.baseUrl,
    input.apiKeyEnc,
    input.keyLocation,
    input.model,
    input.visionModel ?? null,
    input.contextWindow ?? null,
    input.temperature ?? 0.8,
    input.maxTokens ?? 2048,
    input.isDefault ? 1 : 0,
    ts,
    ts,
  )
  const row = findProvider(db, id)
  if (!row) throw new Error('创建服务商后回读失败')
  return row
}

export function updateProvider(db: DB, id: string, patch: Partial<CreateProviderInput> & { apiKeyEnc?: string | null; name?: string; baseUrl?: string; model?: string }): ProviderRow {
  const current = findProvider(db, id)
  if (!current) throw new Error('服务商不存在')

  db.prepare(
    `UPDATE ai_providers
     SET name = ?, base_url = ?, api_key_enc = ?, key_location = ?, model = ?, vision_model = ?,
         context_window = ?, temperature = ?, max_tokens = ?, is_default = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.baseUrl ?? current.base_url,
    patch.apiKeyEnc === undefined ? current.api_key_enc : patch.apiKeyEnc,
    patch.keyLocation ?? current.key_location,
    patch.model ?? current.model,
    patch.visionModel === undefined ? current.vision_model : patch.visionModel || null,
    patch.contextWindow === undefined ? current.context_window : patch.contextWindow,
    patch.temperature ?? current.temperature,
    patch.maxTokens ?? current.max_tokens,
    patch.isDefault === undefined ? current.is_default : patch.isDefault ? 1 : 0,
    now(),
    id,
  )
  const row = findProvider(db, id)
  if (!row) throw new Error('更新服务商后回读失败')
  return row
}

export function softDeleteProvider(db: DB, id: string): void {
  db.prepare('UPDATE ai_providers SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/** 只写余额缓存，不碰 updated_at，避免触发同步 */
export function saveProviderBalance(
  db: DB,
  id: string,
  balance: { amount: string; currency: string } | null,
): void {
  db.prepare(
    'UPDATE ai_providers SET balance = ?, balance_currency = ?, balance_checked_at = ? WHERE id = ?',
  ).run(balance?.amount ?? null, balance?.currency ?? null, now(), id)
}

/* ----------------------------- 图片描述缓存 ----------------------------- */

/** 同一张图（sha256 相同）只识图一次，命中直接返回缓存的描述 */
export function findImageDescription(db: DB, sha256: string): string | null {
  const row = db
    .prepare('SELECT description FROM ai_image_descriptions WHERE sha256 = ?')
    .get(sha256) as { description: string } | undefined
  return row?.description ?? null
}

export function saveImageDescription(
  db: DB,
  sha256: string,
  description: string,
  model: string | null,
): void {
  const ts = now()
  db.prepare(
    `INSERT INTO ai_image_descriptions (sha256, description, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at`,
  ).run(sha256, description, model, ts, ts)
}

export function defaultProvider(db: DB, ownerId: string): ProviderRow | undefined {
  return db
    .prepare(
      `SELECT * FROM ai_providers WHERE owner_id = ? AND deleted_at IS NULL
       ORDER BY is_default DESC, created_at LIMIT 1`,
    )
    .get(ownerId) as ProviderRow | undefined
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
    proactive: parseProactive(row),
    proactiveMode: row.proactive_mode === 'custom' ? 'custom' : 'global',
    lastProactiveAt: row.last_proactive_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listPersonas(db: DB, ownerId: string): PersonaRow[] {
  return db
    .prepare('SELECT * FROM ai_personas WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(ownerId) as PersonaRow[]
}

export function findPersona(db: DB, id: string): PersonaRow | undefined {
  return db.prepare('SELECT * FROM ai_personas WHERE id = ? AND deleted_at IS NULL').get(id) as
    | PersonaRow
    | undefined
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
  proactive?: Partial<ProactiveConfig>
  proactiveMode?: ProactiveMode
}

export function createPersona(db: DB, input: CreatePersonaInput): PersonaRow {
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

  db.prepare(
    `INSERT INTO ai_personas
       (id, owner_id, name, avatar_url, system_prompt, greeting, interests, card, card_url,
        card_filename, in_contacts, provider_id, model_override, temperature, reply_style,
        proactive_enabled, proactive_config, proactive_mode, last_proactive_at, created_at,
        updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
  ).run(
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
    proactive.enabled ? 1 : 0,
    JSON.stringify(proactive),
    mode,
    ts,
    ts,
  )
  const row = findPersona(db, id)
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
  proactive?: Partial<ProactiveConfig>
  proactiveMode?: ProactiveMode
}

export function updatePersona(db: DB, id: string, patch: UpdatePersonaInput): PersonaRow {
  const current = findPersona(db, id)
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

  db.prepare(
    `UPDATE ai_personas
     SET name = ?, avatar_url = ?, system_prompt = ?, greeting = ?, interests = ?, card = ?,
         card_url = ?, card_filename = ?, in_contacts = ?, provider_id = ?,
         model_override = ?, temperature = ?, reply_style = ?, proactive_enabled = ?,
         proactive_config = ?, proactive_mode = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
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
    nextProactive.enabled ? 1 : 0,
    JSON.stringify(nextProactive),
    nextMode,
    now(),
    id,
  )
  const row = findPersona(db, id)
  if (!row) throw new Error('更新角色后回读失败')
  return row
}

export function softDeletePersona(db: DB, id: string): void {
  db.prepare('UPDATE ai_personas SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/** 建角色时先插 persona 再补影子账号，两边 id 一一对应 */
export function setPersonaUserId(db: DB, id: string, userId: string): void {
  db.prepare('UPDATE ai_personas SET user_id = ?, updated_at = ? WHERE id = ?').run(userId, now(), id)
}

/** 按影子账号反查角色：群成员里哪些是 AI 靠它判断 */
export function findPersonaByUserId(db: DB, userId: string): PersonaRow | undefined {
  return db
    .prepare('SELECT * FROM ai_personas WHERE user_id = ? AND deleted_at IS NULL')
    .get(userId) as PersonaRow | undefined
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
  group_reply_probability: number | null
  group_reply_cooldown_minutes: number | null
  group_autonomy_per_day: number
  segment_enabled: number
  segment_pattern: string
  stream_enabled: number
  debug_mode: number
  updated_at: number
}

export function findGlobalSettings(db: DB, userId: string): GlobalSettingsRow | undefined {
  return db.prepare('SELECT * FROM ai_global_settings WHERE user_id = ?').get(userId) as
    | GlobalSettingsRow
    | undefined
}

/**
 * 读设置：没有记录时返回默认值而不是 undefined，
 * 调用方（调度器、设置页）都不需要再写一套兜底。
 */
export function readGlobalSettings(db: DB, userId: string): AiGlobalSettings {
  const row = findGlobalSettings(db, userId)
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
    groupReplyProbability: null,
    groupReplyCooldownMinutes: null,
    groupAutonomyPerDay: GROUP_AI_DEFAULTS.autonomyPerDay,
    segmentEnabled: SEGMENT_REPLY_DEFAULTS.enabled,
    segmentPattern: SEGMENT_REPLY_DEFAULTS.pattern,
    streamEnabled: false,
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
    groupReplyProbability: row.group_reply_probability ?? null,
    groupReplyCooldownMinutes: row.group_reply_cooldown_minutes ?? null,
    groupAutonomyPerDay: row.group_autonomy_per_day,
    segmentEnabled: row.segment_enabled === 1,
    segmentPattern: row.segment_pattern || fallback.segmentPattern,
    streamEnabled: row.stream_enabled === 1,
    debugMode: row.debug_mode === 1,
    updatedAt: row.updated_at,
  }
}

export function writeGlobalSettings(
  db: DB,
  userId: string,
  patch: Partial<Omit<AiGlobalSettings, 'updatedAt'>>,
): AiGlobalSettings {
  const current = readGlobalSettings(db, userId)
  const next = { ...current, ...patch }
  const ts = now()

  db.prepare(
    `INSERT INTO ai_global_settings
       (user_id, proactive_enabled, proactive_config, moments_enabled, moments_posts_per_day,
        moments_comments_per_day, moments_likes_per_day, group_enabled, group_replies_per_day,
        group_reply_probability, group_reply_cooldown_minutes, group_autonomy_per_day,
        segment_enabled, segment_pattern, stream_enabled, debug_mode, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       proactive_enabled = excluded.proactive_enabled,
       proactive_config = excluded.proactive_config,
       moments_enabled = excluded.moments_enabled,
       moments_posts_per_day = excluded.moments_posts_per_day,
       moments_comments_per_day = excluded.moments_comments_per_day,
       moments_likes_per_day = excluded.moments_likes_per_day,
       group_enabled = excluded.group_enabled,
       group_replies_per_day = excluded.group_replies_per_day,
       group_reply_probability = excluded.group_reply_probability,
       group_reply_cooldown_minutes = excluded.group_reply_cooldown_minutes,
       group_autonomy_per_day = excluded.group_autonomy_per_day,
       segment_enabled = excluded.segment_enabled,
       segment_pattern = excluded.segment_pattern,
       stream_enabled = excluded.stream_enabled,
       debug_mode = excluded.debug_mode,
       updated_at = excluded.updated_at`,
  ).run(
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
    next.groupReplyProbability ?? null,
    next.groupReplyCooldownMinutes ?? null,
    next.groupAutonomyPerDay,
    next.segmentEnabled ? 1 : 0,
    next.segmentPattern,
    next.streamEnabled ? 1 : 0,
    next.debugMode ? 1 : 0,
    ts,
  )

  return { ...next, updatedAt: ts }
}

/** 打开了动态互动的用户，供调度器逐个扫描 */
export function listUsersWithMomentsEnabled(db: DB): string[] {
  return (
    db.prepare('SELECT user_id FROM ai_global_settings WHERE moments_enabled = 1').all() as Array<{
      user_id: string
    }>
  ).map((row) => row.user_id)
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

export function findSession(db: DB, conversationId: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM ai_sessions WHERE conversation_id = ?').get(conversationId) as
    | SessionRow
    | undefined
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

export function createSession(
  db: DB,
  input: { conversationId: string; personaId: string; providerId: string },
): SessionRow {
  const ts = now()
  db.prepare(
    `INSERT INTO ai_sessions
       (conversation_id, persona_id, provider_id, memory_enabled, last_compacted_seq,
        messages_since_compact, token_estimate, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?)`,
  ).run(input.conversationId, input.personaId, input.providerId, ts, ts)
  const row = findSession(db, input.conversationId)
  if (!row) throw new Error('创建 AI 会话扩展失败')
  return row
}

export function bumpSessionProgress(db: DB, conversationId: string, messageCount: number, tokens: number): void {
  db.prepare(
    `UPDATE ai_sessions
     SET messages_since_compact = messages_since_compact + ?,
         token_estimate = token_estimate + ?,
         updated_at = ?
     WHERE conversation_id = ?`,
  ).run(messageCount, tokens, now(), conversationId)
}

export function markCompacted(db: DB, conversationId: string, upToSeq: number): void {
  db.prepare(
    `UPDATE ai_sessions
     SET last_compacted_seq = ?, messages_since_compact = 0, updated_at = ?
     WHERE conversation_id = ?`,
  ).run(upToSeq, now(), conversationId)
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
export function listSummaries(db: DB, conversationId: string) {
  const rows = db
    .prepare(
      `SELECT * FROM ai_memory_summaries
       WHERE conversation_id = ? AND superseded_by IS NULL
       ORDER BY to_seq DESC LIMIT 10`,
    )
    .all(conversationId) as SummaryRow[]
  return rows.map(mapSummary)
}

export function latestSummary(db: DB, conversationId: string) {
  const rows = db
    .prepare(
      `SELECT * FROM ai_memory_summaries
       WHERE conversation_id = ? AND superseded_by IS NULL
       ORDER BY to_seq DESC LIMIT 1`,
    )
    .all(conversationId) as SummaryRow[]
  const row = rows[0]
  return row ? mapSummary(row) : null
}

export function insertSummary(
  db: DB,
  input: { conversationId: string; fromSeq: number; toSeq: number; summary: string; tokenEstimate: number; model?: string | null },
): string {
  const id = ulid()
  const superseded = db
    .prepare(
      'SELECT id FROM ai_memory_summaries WHERE conversation_id = ? AND superseded_by IS NULL',
    )
    .all(input.conversationId) as Array<{ id: string }>

  db.prepare(
    `INSERT INTO ai_memory_summaries
       (id, conversation_id, from_seq, to_seq, summary, token_estimate, model, superseded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.conversationId,
    input.fromSeq,
    input.toSeq,
    input.summary,
    input.tokenEstimate,
    input.model ?? null,
    now(),
  )

  const update = db.prepare('UPDATE ai_memory_summaries SET superseded_by = ? WHERE id = ?')
  for (const row of superseded) update.run(id, row.id)

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

export function listFacts(db: DB, conversationId: string): FactRow[] {
  return db
    .prepare(
      `SELECT * FROM ai_memory_facts
       WHERE conversation_id = ? AND status = 'active'
       ORDER BY subject, key`,
    )
    .all(conversationId) as FactRow[]
}

/**
 * 写入事实：同 (subject, key) 已有 active 值时，
 * 把旧值标记为 superseded 再插入新值，形成可追溯的覆盖链。
 */
export function upsertFact(
  db: DB,
  input: {
    conversationId: string
    subject: string
    key: string
    value: string
    confidence: number
    sourceMessageId?: string | null
  },
): string {
  const existing = db
    .prepare(
      `SELECT * FROM ai_memory_facts
       WHERE conversation_id = ? AND subject = ? AND key = ? AND status = 'active'`,
    )
    .get(input.conversationId, input.subject, input.key) as FactRow | undefined

  const id = ulid()
  const ts = now()

  if (existing && existing.value === input.value) {
    db.prepare('UPDATE ai_memory_facts SET confidence = ?, updated_at = ? WHERE id = ?').run(
      Math.max(existing.confidence, input.confidence),
      ts,
      existing.id,
    )
    return existing.id
  }

  if (existing) {
    db.prepare("UPDATE ai_memory_facts SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(
      id,
      ts,
      existing.id,
    )
  }

  db.prepare(
    `INSERT INTO ai_memory_facts
       (id, conversation_id, subject, key, value, confidence, source_message_id, status,
        superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.subject,
    input.key,
    input.value,
    input.confidence,
    input.sourceMessageId ?? null,
    ts,
    ts,
  )
  return id
}

export function rejectFact(db: DB, conversationId: string, factId: string): void {
  db.prepare(
    "UPDATE ai_memory_facts SET status = 'rejected', updated_at = ? WHERE conversation_id = ? AND id = ?",
  ).run(now(), conversationId, factId)
}

/* ------------------------------ 生成记录 ------------------------------ */

export function createGeneration(
  db: DB,
  input: {
    conversationId: string
    userId: string
    userMessageId: string | null
    providerId: string
    personaId: string
    runLocation: 'local' | 'server'
    model: string
  },
): string {
  const id = ulid()
  db.prepare(
    `INSERT INTO ai_generations
       (id, conversation_id, user_id, user_message_id, provider_id, persona_id, run_location,
        model, status, error, prompt_tokens, completion_tokens, message_ids, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'streaming', NULL, NULL, NULL, NULL, ?, NULL)`,
  ).run(
    id,
    input.conversationId,
    input.userId,
    input.userMessageId,
    input.providerId,
    input.personaId,
    input.runLocation,
    input.model,
    now(),
  )
  return id
}

export function finishGeneration(
  db: DB,
  id: string,
  patch: {
    status: 'done' | 'error' | 'cancelled'
    error?: string | null
    messageIds?: string[]
    promptTokens?: number | null
    completionTokens?: number | null
  },
): void {
  db.prepare(
    `UPDATE ai_generations
     SET status = ?, error = ?, message_ids = ?, prompt_tokens = ?, completion_tokens = ?, finished_at = ?
     WHERE id = ?`,
  ).run(
    patch.status,
    patch.error ?? null,
    patch.messageIds ? JSON.stringify(patch.messageIds) : null,
    patch.promptTokens ?? null,
    patch.completionTokens ?? null,
    now(),
    id,
  )
}
