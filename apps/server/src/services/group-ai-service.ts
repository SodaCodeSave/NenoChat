import {
  GROUP_AI_DEFAULTS,
  buildGroupPrompt,
  extractStickerMarker,
  isSkipReply,
  splitSegments,
  ulid,
  type AiGlobalSettings,
  type Message,
  type MessageMeta,
  type SenderType,
} from '@nenochat/shared'
import { Cron } from 'croner'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { DB } from '../db'
import { all, one, run } from '../db'
import { withTx } from '../db/tx'
import * as aiRepo from '../db/repo/ai'
import * as conversationsRepo from '../db/repo/conversations'
import * as debugRepo from '../db/repo/debug'
import * as membersRepo from '../db/repo/members'
import * as messagesRepo from '../db/repo/messages'
import * as scheduleRepo from '../db/repo/schedule'
import * as stickersRepo from '../db/repo/stickers'
import * as usersRepo from '../db/repo/users'
import { err } from '../util/errors'
import { now } from '../util/clock'
import { aiStickerOptionsForPersona, aiEnabledStickerIds, callUpstream, appendStickerMessage, resolveServerApiKey, isModelEnabled } from './ai-service'
import { appendSystemMessage } from './message-service'
import * as scheduleService from './schedule-service'
import {
  decideGroupAutonomy,
  decideGroupReply,
  deriveMood,
  recoverEnergy,
  relevanceOf,
} from './group-ai-rules'
import {
  formatLocalTime,
  inQuietWindow,
  localDayKey,
  minutesOfDay,
  serverTzOffsetMinutes,
} from './proactive-rules'
import { hub } from '../ws/hub'

/**
 * 群聊里的 AI 成员。
 *
 * 规则判定、配额占位与生成都在服务端，保证多端只看到一条。
 */

const TZ_OFFSET_MIN = serverTzOffsetMinutes()
const STALE_PENDING_MS = 5 * 60_000
const RECENT_LIMIT = 30

/** 一轮发言的结局 */
type TurnOutcome = 'sent' | 'skipped' | 'failed' | 'no_provider'

/** 排队接话时，轮到下一个角色之前的随机歇口气区间 */
const CHAIN_GAP_MIN_MS = 1_000
const CHAIN_GAP_MAX_MS = 3_000

interface GroupPersonaMember {
  persona: aiRepo.PersonaRow
  botUserId: string
  provider: aiRepo.ProviderRow | null
}

interface GroupState {
  energy: number
  mood: string
  lastReplyAt: number | null
  lastAutonomyAt: number | null
  updatedAt: number
}

interface GroupTurnInput {
  conversationId: string
  member: GroupPersonaMember
  kind: 'reply' | 'autonomy'
  logId: string
  mood: string
  energy: number
  /** 主人的全局设置：调用方已经读过，传进来省得每轮再查一次 */
  settings: AiGlobalSettings
  /** 插话时引用的触发消息，只有第一条分条会挂上 */
  replyToId: string | null
  trigger: { messageId: string; speaker: string; content: string; mustReply: boolean } | null
}

function clampEnergy(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/* ------------------------------ 成员与状态 ------------------------------ */

/** 群里所有还在的 AI 成员（影子账号未被禁用、角色未删除） */
export async function listGroupPersonas(db: DB, conversationId: string): Promise<GroupPersonaMember[]> {
  const rows = await all<aiRepo.PersonaRow>(
    db,
    `SELECT p.* FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.type = 'group' AND c.deleted_at IS NULL
       JOIN ai_personas p ON p.user_id = cm.user_id AND p.deleted_at IS NULL
       JOIN users u ON u.id = cm.user_id AND u.status = 'active'
       WHERE cm.conversation_id = ? AND cm.left_at IS NULL
       ORDER BY cm.joined_at`,
    [conversationId],
  )

  const out: GroupPersonaMember[] = []
  for (const persona of rows) {
    out.push({
      persona,
      botUserId: persona.user_id!,
      provider: await resolvePersonaProvider(db, persona),
    })
  }
  return out
}

async function resolvePersonaProvider(db: DB, persona: aiRepo.PersonaRow): Promise<aiRepo.ProviderRow | null> {
  if (persona.provider_id) {
    const provider = await aiRepo.findProvider(db, persona.provider_id)
    if (provider) return provider
  }
  return (await aiRepo.defaultProviderWithShared(db, persona.owner_id)) ?? null
}

async function readState(db: DB, conversationId: string, personaId: string): Promise<GroupState> {
  const row = await one<{
    energy: number
    mood: string
    last_reply_at: number | null
    last_autonomy_at: number | null
    updated_at: number
  }>(db, 'SELECT * FROM ai_group_state WHERE conversation_id = ? AND persona_id = ?', [
    conversationId,
    personaId,
  ])

  const ts = now()
  if (!row) {
    return {
      energy: GROUP_AI_DEFAULTS.initialEnergy,
      mood: deriveMood(GROUP_AI_DEFAULTS.initialEnergy),
      lastReplyAt: null,
      lastAutonomyAt: null,
      updatedAt: ts,
    }
  }

  const energy = recoverEnergy(row.energy, ts - row.updated_at)
  return {
    energy,
    mood: deriveMood(energy),
    lastReplyAt: row.last_reply_at,
    lastAutonomyAt: row.last_autonomy_at,
    updatedAt: ts,
  }
}

async function writeState(db: DB, conversationId: string, personaId: string, state: GroupState): Promise<void> {
  await run(
    db,
    `INSERT INTO ai_group_state
       (conversation_id, persona_id, energy, mood, last_reply_at, last_autonomy_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, persona_id) DO UPDATE SET
       energy = excluded.energy,
       mood = excluded.mood,
       last_reply_at = excluded.last_reply_at,
       last_autonomy_at = excluded.last_autonomy_at,
       updated_at = excluded.updated_at`,
    [
      conversationId,
      personaId,
      state.energy,
      state.mood,
      state.lastReplyAt,
      state.lastAutonomyAt,
      state.updatedAt,
    ],
  )
}

async function countToday(
  db: DB,
  conversationId: string,
  personaId: string,
  dayKey: string,
  kind: 'reply' | 'autonomy',
): Promise<number> {
  const row = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM ai_group_log
       WHERE conversation_id = ? AND persona_id = ? AND day_key = ? AND kind = ?
         AND status IN ('pending', 'dispatched', 'sent')`,
    [conversationId, personaId, dayKey, kind],
  )
  return row?.c ?? 0
}

interface ReservedTurn {
  logId: string
  slot: number
  mood: string
  energy: number
}

/** 先占配额再生成：昨天遗留的 pending 不会卡住今天 */
async function reserveTurn(
  db: DB,
  input: {
    conversationId: string
    member: GroupPersonaMember
    kind: 'reply' | 'autonomy'
    dayKey: string
    maxPerDay: number
    state: GroupState
    replyToId?: string | null
  },
): Promise<ReservedTurn | null> {
  return withTx(db, async (tx) => {
    const used = await countToday(tx, input.conversationId, input.member.persona.id, input.dayKey, input.kind)
    if (input.maxPerDay >= 0 && used >= input.maxPerDay) return null

    const ts = now()
    const logId = ulid()
    try {
      await run(
        tx,
        `INSERT INTO ai_group_log
           (id, conversation_id, persona_id, user_id, kind, day_key, slot, status,
            message_id, reply_to_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
        [
          logId,
          input.conversationId,
          input.member.persona.id,
          input.member.persona.owner_id,
          input.kind,
          input.dayKey,
          used,
          input.replyToId ?? null,
          ts,
        ],
      )
    } catch {
      // 自主开口有唯一索引，多实例只有一个能抢到同一格
      return null
    }

    const spend = input.kind === 'autonomy' ? 20 : 10
    const energy = clampEnergy(input.state.energy - spend)
    await writeState(tx, input.conversationId, input.member.persona.id, {
      energy,
      mood: deriveMood(energy),
      lastReplyAt: input.kind === 'reply' ? ts : input.state.lastReplyAt,
      lastAutonomyAt: input.kind === 'autonomy' ? ts : input.state.lastAutonomyAt,
      updatedAt: ts,
    })

    return { logId, slot: used, mood: deriveMood(energy), energy }
  })
}

async function finishLog(
  db: DB,
  logId: string,
  status: 'sent' | 'skipped' | 'failed',
  extra: { messageId?: string | null; reason?: string | null } = {},
): Promise<void> {
  await run(db, 'UPDATE ai_group_log SET status = ?, message_id = ?, reason = ? WHERE id = ?', [
    status,
    extra.messageId ?? null,
    extra.reason ?? null,
    logId,
  ])
}

/** 决策落库后实时推给主人的在线客户端；客户端按 debugMode 决定是否显示 */
async function pushDecision(db: DB, ownerId: string, decision: debugRepo.InsertDecisionInput): Promise<void> {
  const row = await debugRepo.insertDecision(db, decision)
  hub().sendToUser(ownerId, 'ai.debug.decision', { decision: row })
}

/** 模型层产出（发出 / 沉默 / 失败）回填到规则层创建的决策记录上，并推送更新 */
async function resolveDecisionOutcome(
  db: DB,
  ownerId: string,
  logId: string,
  reason: string,
  fired: boolean,
): Promise<void> {
  const updated = await debugRepo.updateDecisionOutcome(db, logId, {
    stage: 'model',
    reason,
    fired,
  })
  if (updated) hub().sendToUser(ownerId, 'ai.debug.decision', { decision: updated })
}

/* ------------------------------ 提示词上下文 ------------------------------ */

async function rosterOf(db: DB, conversationId: string, selfBotId: string): Promise<Array<{ name: string; isSelf: boolean }>> {
  const rows = await membersRepo.listActive(db, conversationId)
  const userRows = await usersRepo.listByIds(
    db,
    rows.map((row) => row.user_id),
  )
  const users = new Map(userRows.map((user) => [user.id, user.display_name]))
  return rows.map((row) => ({
    name: users.get(row.user_id) ?? row.user_id,
    isSelf: row.user_id === selfBotId,
  }))
}

async function recentMessages(db: DB, conversationId: string): Promise<Message[]> {
  const rows = await messagesRepo.page(db, {
    conversationId,
    before: null,
    after: null,
    limit: RECENT_LIMIT,
  })
  return rows.reverse().map(messagesRepo.mapMessage)
}

/** 某条消息在引用谁：先查群里成员名，再退回 users 表，最后给个泛称 */
async function quotedOfMessage(
  db: DB,
  replyToId: string | null | undefined,
  nameById: Map<string, string>,
): Promise<{ speaker: string; content: string } | null> {
  if (!replyToId) return null
  const row = await messagesRepo.findById(db, replyToId)
  if (!row) return null
  const fallbackName = row.sender_id ? (await usersRepo.findById(db, row.sender_id))?.display_name ?? null : null
  const speaker =
    (row.sender_id ? nameById.get(row.sender_id) : null) ?? fallbackName ?? '某人'
  return { speaker, content: messagesRepo.previewOf(row) }
}

async function toPromptRecent(
  db: DB,
  messages: Message[],
  selfBotId: string,
  nameById: Map<string, string>,
): Promise<Array<{
  speaker: string
  content: string
  isSelf: boolean
  mentionsSelf?: boolean
  replyTo?: { speaker: string; content: string } | null
}>> {
  const out: Array<{
    speaker: string
    content: string
    isSelf: boolean
    mentionsSelf?: boolean
    replyTo?: { speaker: string; content: string } | null
  }> = []
  for (const message of messages) {
    if (message.senderType === 'system' || message.deletedAt || message.content.trim().length === 0) continue
    out.push({
      speaker: nameById.get(message.senderId ?? '') ?? '某人',
      content: message.content,
      isSelf: message.senderId === selfBotId,
      mentionsSelf: Boolean(message.meta?.mentions?.includes(selfBotId)),
      replyTo: await quotedOfMessage(db, message.replyToId, nameById),
    })
  }
  return out
}

async function buildTurnPrompt(
  db: DB,
  input: GroupTurnInput,
): Promise<ReturnType<typeof buildGroupPrompt>> {
  const conversation = await conversationsRepo.findById(db, input.conversationId)
  const persona = aiRepo.mapPersona(input.member.persona)
  const messages = await recentMessages(db, input.conversationId)
  const memberRows = await membersRepo.listActive(db, input.conversationId)
  const nameById = new Map<string, string>()
  for (const row of memberRows) {
    const user = await usersRepo.findById(db, row.user_id)
    nameById.set(row.user_id, user?.display_name ?? row.user_id)
  }

  const triggerRow = input.trigger ? await messagesRepo.findById(db, input.trigger.messageId) : null
  const scheduleRow = await scheduleRepo.findSchedule(
    db,
    input.member.persona.id,
    localDayKey(now(), TZ_OFFSET_MIN),
  )

  return buildGroupPrompt({
    persona,
    mood: input.mood,
    energy: input.energy,
    groupName: conversation?.name ?? '群聊',
    members: await rosterOf(db, input.conversationId, input.member.botUserId),
    recent: await toPromptRecent(db, messages, input.member.botUserId, nameById),
    mode: input.kind,
    stickers: await aiStickerOptionsForPersona(db, input.member.persona),
    trigger: input.trigger
      ? {
          speaker: input.trigger.speaker,
          content: input.trigger.content,
          mustReply: input.trigger.mustReply,
          replyTo: triggerRow ? await quotedOfMessage(db, triggerRow.reply_to_id, nameById) : null,
        }
      : null,
    idleHours:
      input.kind === 'autonomy'
        ? Math.max(0, Math.floor((now() - (await conversationLastMessageAt(db, input.conversationId))) / 3_600_000))
        : undefined,
    localTime: formatLocalTime(now(), TZ_OFFSET_MIN),
    schedule: scheduleRow ? scheduleRepo.mapSchedule(scheduleRow) : null,
    scheduleNowMinutes: minutesOfDay(now(), TZ_OFFSET_MIN),
  })
}

async function conversationLastMessageAt(db: DB, conversationId: string): Promise<number> {
  const row = await one<{ ts: number }>(
    db,
    'SELECT COALESCE(MAX(created_at), 0) AS ts FROM messages WHERE conversation_id = ?',
    [conversationId],
  )
  return row?.ts ?? 0
}

/* ------------------------------ 消息落库 ------------------------------ */

/**
 * 群聊 AI 分段落库的公共入口：服务端生成与客户端回传都走这里。
 * 分段里若带有效的表情标记，拆成文字与表情两条消息；最多解析一个标记。
 */
async function appendGroupSegmentCore(
  db: DB,
  input: {
    conversationId: string
    persona: aiRepo.PersonaRow
    generationId: string
    index: number
    content: string
    totalSegments: number
    model?: string | null
    proactive?: boolean
    replyToId?: string | null
    clientNonce: string
  },
): Promise<Message> {
  const existing = await messagesRepo.findByNonceInConversation(db, input.conversationId, input.clientNonce)
  if (existing) return messagesRepo.mapMessage(existing)

  const enabledIds = await aiEnabledStickerIds(db, input.persona)
  const marker = enabledIds.size > 0 ? extractStickerMarker(input.content, enabledIds) : null
  const text = marker?.stickerId ? marker.text : input.content

  const buildMeta = (index: number): MessageMeta => ({
    ai: {
      generationId: input.generationId,
      index,
      personaId: input.persona.id,
      totalSegments: input.totalSegments,
      model: input.model ?? undefined,
      ...(input.proactive ? { proactive: true } : {}),
    },
  })

  const appendText = async (content: string, index: number, replyToId: string | null): Promise<Message> =>
    appendSystemMessage(db, {
      conversationId: input.conversationId,
      senderType: 'ai' as SenderType,
      senderId: input.persona.user_id,
      type: 'text',
      content,
      meta: buildMeta(index),
      replyToId,
      aiGenerationId: input.generationId,
      aiIndex: index,
      clientNonce: input.clientNonce,
    })

  const stickerNonce = `${input.clientNonce}-s`
  const stickerAppend = async (index: number, replyToId: string | null): Promise<Message | null> =>
    (await appendStickerMessage(db, {
      conversationId: input.conversationId,
      stickerId: marker!.stickerId!,
      generationId: input.generationId,
      index,
      clientNonce: stickerNonce,
      personaId: input.persona.id,
      model: input.model ?? undefined,
      totalSegments: input.totalSegments,
      proactive: input.proactive,
    })) ?? null

  // replyToId 只挂在第一片上：文字在前挂文字，表情在前挂表情
  if (marker?.stickerId && marker.stickerFirst) {
    const sticker = await stickerAppend(input.index, input.replyToId ?? null)
    const textIndex = sticker ? input.index + 1 : input.index
    const first = sticker ?? (await appendText(text, input.index, input.replyToId ?? null))
    if (text.trim()) await appendText(text, textIndex, null)
    return first
  }

  const hasText = text.trim().length > 0
  if (marker?.stickerId) {
    const textMessage = hasText ? await appendText(text, input.index, input.replyToId ?? null) : null
    const sticker = await stickerAppend(textMessage ? input.index + 1 : input.index, textMessage ? null : input.replyToId ?? null)
    return textMessage ?? sticker!
  }

  return appendText(text, input.index, input.replyToId ?? null)
}

async function appendGroupSegment(
  db: DB,
  input: {
    conversationId: string
    persona: aiRepo.PersonaRow
    generationId: string
    index: number
    content: string
    totalSegments: number
    model?: string | null
    proactive?: boolean
    replyToId?: string | null
  },
): Promise<Message> {
  return appendGroupSegmentCore(db, {
    ...input,
    clientNonce: `${input.generationId}-${input.index}`,
  })
}

async function appendSegments(
  db: DB,
  input: GroupTurnInput,
  segments: string[],
  model: string | null,
): Promise<string | null> {
  let firstId: string | null = null
  for (let index = 0; index < segments.length; index++) {
    const message = await appendGroupSegment(db, {
      conversationId: input.conversationId,
      persona: input.member.persona,
      generationId: input.logId,
      index,
      content: segments[index]!,
      totalSegments: segments.length,
      model,
      proactive: input.kind === 'autonomy',
      // 只有第一条像「点了回复」那样挂引用，后续分条是自然延续
      replyToId: index === 0 ? input.replyToId : null,
    })
    if (index === 0) firstId = message.id
  }
  return firstId
}

/* ------------------------------ 生成与派发 ------------------------------ */

async function runTurn(db: DB, input: GroupTurnInput): Promise<TurnOutcome> {
  const provider = input.member.provider
  if (!provider) {
    await finishLog(db, input.logId, 'skipped', { reason: 'no_provider' })
    if (input.settings.debugMode) {
      await resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'no_provider', false)
    }
    return 'no_provider'
  }

  const debugDecisions = input.settings.debugMode
  const model = input.member.persona.model_override ?? provider.model

  // 关闭的模型不可被选用：本轮直接跳过，不发起上游调用
  if (!isModelEnabled(provider, model)) {
    await finishLog(db, input.logId, 'skipped', { reason: 'model_disabled' })
    if (debugDecisions) {
      await resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'model_disabled', false)
    }
    return 'skipped'
  }

  // 顺手补齐当天日程
  await scheduleService.ensureScheduleQuietly(db, input.member.persona)
  const prompt = await buildTurnPrompt(db, input)

  let reply: string
  try {
    reply = (
      await callUpstream({
        baseUrl: provider.base_url,
        apiKey: resolveServerApiKey(provider),
        model,
        temperature: input.member.persona.temperature ?? provider.temperature,
        maxTokens: Math.min(provider.max_tokens, 300),
        messages: prompt,
        record: {
          db,
          ownerId: input.member.persona.owner_id,
          conversationId: input.conversationId,
          personaId: input.member.persona.id,
          providerId: provider.id,
          kind: input.kind === 'reply' ? 'group_reply' : 'group_autonomy',
          refId: input.logId,
        },
      })
    )
      .content
      .trim()
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 160) : 'generate_failed'
    await finishLog(db, input.logId, 'failed', { reason })
    if (debugDecisions) {
      await resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, reason, false)
    }
    return 'failed'
  }

  if (isSkipReply(reply)) {
    await finishLog(db, input.logId, 'skipped', { reason: 'skip' })
    if (debugDecisions) {
      await resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'skip', false)
    }
    return 'skipped'
  }

  const segments = splitSegments(reply, {
    enabled: input.settings.segmentEnabled,
    pattern: input.settings.segmentPattern,
  }).slice(0, 3)
  if (segments.length === 0) {
    await finishLog(db, input.logId, 'skipped', { reason: 'empty_reply' })
    if (debugDecisions) {
      await resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'empty_reply', false)
    }
    return 'skipped'
  }

  const firstId = await appendSegments(db, input, segments, model)
  await finishLog(db, input.logId, 'sent', { messageId: firstId })
  if (debugDecisions) {
    await resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'sent', true)
  }
  return 'sent'
}

/* ------------------------------ 对外入口 ------------------------------ */

export interface GroupMessageTrigger {
  conversationId: string
  messageId: string
  senderId: string
  content: string
  mentions?: string[]
  mentionAll?: boolean
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 用户发了一条群消息：规则预筛后决定谁接话，多个角色按序排队接话 */
export async function respondToGroupMessage(db: DB, trigger: GroupMessageTrigger): Promise<void> {
  const conversation = await conversationsRepo.findById(db, trigger.conversationId)
  if (!conversation || conversation.type !== 'group' || conversation.deleted_at !== null) return

  const sender = await usersRepo.findById(db, trigger.senderId)
  const senderName = sender?.display_name ?? '某人'
  if (sender?.is_bot === 1) return

  const members = await listGroupPersonas(db, trigger.conversationId)
  if (members.length === 0) return

  const ts = now()
  const dayKey = localDayKey(ts, TZ_OFFSET_MIN)
  let fired = 0

  // 同一个群里的成员可能属于不同主人；设置按主人缓存，一条消息每个主人只读一次
  const settingsByOwner = new Map<string, AiGlobalSettings>()
  const settingsOf = async (ownerId: string): Promise<AiGlobalSettings> => {
    let settings = settingsByOwner.get(ownerId)
    if (!settings) {
      settings = await aiRepo.readGlobalSettings(db, ownerId)
      settingsByOwner.set(ownerId, settings)
    }
    return settings
  }

  for (const member of members) {
    const mapped = aiRepo.mapPersona(member.persona)
    const settings = await settingsOf(member.persona.owner_id)
    if (fired >= settings.groupRepliesPerMessage) break

    // 排队接话：已经有人说过话了，轮到下一个角色前先歇口气
    if (fired > 0) {
      await delay(CHAIN_GAP_MIN_MS + Math.random() * (CHAIN_GAP_MAX_MS - CHAIN_GAP_MIN_MS))
    }

    const mentioned =
      trigger.mentionAll ||
      Boolean(trigger.mentions?.includes(member.botUserId)) ||
      (mapped.name.length > 0 && trigger.content.includes(`@${mapped.name}`))

    const state = await readState(db, trigger.conversationId, member.persona.id)
    const decision = decideGroupReply({
      now: ts,
      enabled: settings.groupEnabled,
      repliesToday: await countToday(db, trigger.conversationId, member.persona.id, dayKey, 'reply'),
      maxRepliesPerDay: settings.groupRepliesPerDay,
      lastReplyAt: state.lastReplyAt,
      cooldownMs:
        settings.groupReplyCooldownMinutes === null || settings.groupReplyCooldownMinutes === undefined
          ? GROUP_AI_DEFAULTS.replyCooldownMs
          : settings.groupReplyCooldownMinutes * 60_000,
      probabilityPercent: settings.groupReplyProbability ?? null,
      energy: state.energy,
      mustReply: mentioned,
      relevance: relevanceOf(trigger.content, mapped.name, mapped.interests),
      random: Math.random,
    })

    // 调试模式的数据源：规则层没放行也记一条，让主人看到「谁为什么没接话」；
    // 没开调试模式时这些记录没人看，不写
    if (!decision.fire) {
      if (settings.debugMode && settings.groupEnabled) {
        await pushDecision(db, member.persona.owner_id, {
          conversationId: trigger.conversationId,
          personaId: member.persona.id,
          personaName: mapped.name,
          triggerMessageId: trigger.messageId,
          kind: 'reply',
          fired: false,
          stage: 'rules',
          reason: decision.reason,
          energy: state.energy,
          mood: state.mood,
        })
      }
      continue
    }

    const reserved = await reserveTurn(db, {
      conversationId: trigger.conversationId,
      member,
      kind: 'reply',
      dayKey,
      maxPerDay: settings.groupRepliesPerDay,
      state,
      replyToId: trigger.messageId,
    })
    if (!reserved) continue

    if (settings.debugMode) {
      await pushDecision(db, member.persona.owner_id, {
        conversationId: trigger.conversationId,
        personaId: member.persona.id,
        personaName: mapped.name,
        triggerMessageId: trigger.messageId,
        kind: 'reply',
        fired: true,
        stage: 'rules',
        reason: decision.reason,
        energy: reserved.energy,
        mood: reserved.mood,
        logId: reserved.logId,
      })
    }

    fired += 1
    let outcome: TurnOutcome = 'failed'
    try {
      outcome = await runTurn(db, {
        conversationId: trigger.conversationId,
        member,
        kind: 'reply',
        logId: reserved.logId,
        mood: reserved.mood,
        energy: reserved.energy,
        settings,
        replyToId: trigger.messageId,
        trigger: {
          messageId: trigger.messageId,
          speaker: senderName,
          content: trigger.content,
          mustReply: mentioned,
        },
      })
    } catch (e) {
      await finishLog(db, reserved.logId, 'failed', {
        reason: e instanceof Error ? e.message.slice(0, 160) : 'unknown',
      })
    }

  }
}

/** 路由/WS 发完消息后调用：不阻塞发送响应 */
export function scheduleGroupResponse(db: DB, trigger: GroupMessageTrigger): void {
  setTimeout(() => {
    void respondToGroupMessage(db, trigger).catch(() => undefined)
  }, 0)
}

/* ------------------------------ 自主开口 ------------------------------ */

interface AutonomyCandidate {
  conversation_id: string
  persona: aiRepo.PersonaRow
}

async function listAutonomyCandidates(db: DB): Promise<AutonomyCandidate[]> {
  const rows = await all<aiRepo.PersonaRow & { conversation_id: string }>(
    db,
    `SELECT cm.conversation_id AS conversation_id, p.*
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.type = 'group' AND c.deleted_at IS NULL
       JOIN ai_personas p ON p.user_id = cm.user_id AND p.deleted_at IS NULL
       JOIN users u ON u.id = cm.user_id AND u.status = 'active'
       WHERE cm.left_at IS NULL
       ORDER BY cm.joined_at`,
  )

  return rows.map((row) => ({ conversation_id: row.conversation_id, persona: row }))
}

/** 跑一轮主动开口扫描。导出以便测试与手动触发。 */
export async function scanGroupAutonomyOnce(
  db: DB,
  log: FastifyBaseLogger,
  options: { random?: () => number } = {},
): Promise<void> {
  const random = options.random ?? Math.random
  const ts = now()
  const dayKey = localDayKey(ts, TZ_OFFSET_MIN)

  await run(
    db,
    `UPDATE ai_group_log SET status = 'failed', reason = 'stale_pending'
       WHERE status = 'pending' AND created_at < ?`,
    [ts - STALE_PENDING_MS],
  )

  const spokenGroups = new Set<string>()

  // 候选按主人分组读设置：一个主人可能有好几个角色，设置只读一次
  const settingsByOwner = new Map<string, AiGlobalSettings>()
  const settingsOf = async (ownerId: string): Promise<AiGlobalSettings> => {
    let settings = settingsByOwner.get(ownerId)
    if (!settings) {
      settings = await aiRepo.readGlobalSettings(db, ownerId)
      settingsByOwner.set(ownerId, settings)
    }
    return settings
  }

  for (const candidate of await listAutonomyCandidates(db)) {
    if (spokenGroups.has(candidate.conversation_id)) continue

    const settings = await settingsOf(candidate.persona.owner_id)
    if (!settings.groupEnabled) continue

    const state = await readState(db, candidate.conversation_id, candidate.persona.id)
    const lastMessageAt = await conversationLastMessageAt(db, candidate.conversation_id)
    const decision = decideGroupAutonomy({
      now: ts,
      enabled: settings.groupEnabled,
      autonomyToday: await countToday(db, candidate.conversation_id, candidate.persona.id, dayKey, 'autonomy'),
      maxAutonomyPerDay: settings.groupAutonomyPerDay,
      lastAutonomyAt: state.lastAutonomyAt,
      idleMs: ts - lastMessageAt,
      energy: state.energy,
      inQuietWindow: inQuietWindow(ts, settings.windowStart ?? undefined, settings.windowEnd ?? undefined, TZ_OFFSET_MIN),
      random,
    })
    if (!decision.fire) {
      // 规则层没放行也记一条：主人需要看到「谁为什么没主动开口」；没开调试模式就不写
      if (settings.debugMode) {
        await pushDecision(db, candidate.persona.owner_id, {
          conversationId: candidate.conversation_id,
          personaId: candidate.persona.id,
          personaName: candidate.persona.name,
          triggerMessageId: null,
          kind: 'autonomy',
          fired: false,
          stage: 'rules',
          reason: decision.reason,
          energy: state.energy,
          mood: state.mood,
        })
      }
      continue
    }

    const member: GroupPersonaMember = {
      persona: candidate.persona,
      botUserId: candidate.persona.user_id!,
      provider: await resolvePersonaProvider(db, candidate.persona),
    }

    const reserved = await reserveTurn(db, {
      conversationId: candidate.conversation_id,
      member,
      kind: 'autonomy',
      dayKey,
      maxPerDay: settings.groupAutonomyPerDay,
      state,
      replyToId: null,
    })
    if (!reserved) continue

    if (settings.debugMode) {
      await pushDecision(db, candidate.persona.owner_id, {
        conversationId: candidate.conversation_id,
        personaId: candidate.persona.id,
        personaName: candidate.persona.name,
        triggerMessageId: null,
        kind: 'autonomy',
        fired: true,
        stage: 'rules',
        reason: decision.reason,
        energy: reserved.energy,
        mood: reserved.mood,
        logId: reserved.logId,
      })
    }

    spokenGroups.add(candidate.conversation_id)
    try {
      await runTurn(db, {
        conversationId: candidate.conversation_id,
        member,
        kind: 'autonomy',
        logId: reserved.logId,
        mood: reserved.mood,
        energy: reserved.energy,
        settings,
        replyToId: null,
        trigger: null,
      })
    } catch (e) {
      log.error({ err: e, personaId: candidate.persona.id }, '群自主发言失败')
      await finishLog(db, reserved.logId, 'failed', { reason: 'exception' })
    }
  }
}

export function startGroupAiScheduler(app: FastifyInstance, db: DB): () => void {
  if (process.env.NODE_ENV === 'test') return () => {}

  const job = new Cron(GROUP_AI_DEFAULTS.scanIntervalCron, { protect: true }, () => {
    void scanGroupAutonomyOnce(db, app.log).catch((e) => {
      app.log.error({ err: e }, '群聊主动发言扫描失败')
    })
  })

  const kickoff = setTimeout(() => {
    void scanGroupAutonomyOnce(db, app.log).catch(() => undefined)
  }, 45_000)

  return () => {
    job.stop()
    clearTimeout(kickoff)
  }
}
