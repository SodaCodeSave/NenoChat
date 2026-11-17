import {
  GROUP_AI_DEFAULTS,
  buildGroupPrompt,
  isSkipReply,
  splitSegments,
  ulid,
  type Message,
  type MessageMeta,
  type SenderType,
} from '@nenochat/shared'
import { Cron } from 'croner'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as aiRepo from '../db/repo/ai'
import * as channelsRepo from '../db/repo/channels'
import * as conversationsRepo from '../db/repo/conversations'
import * as debugRepo from '../db/repo/debug'
import * as membersRepo from '../db/repo/members'
import * as messagesRepo from '../db/repo/messages'
import * as usersRepo from '../db/repo/users'
import { err } from '../util/errors'
import { now } from '../util/clock'
import { callUpstream, resolveServerApiKey } from './ai-service'
import { appendSystemMessage } from './message-service'
import { createNotification } from './notification-service'
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
  serverTzOffsetMinutes,
} from './proactive-rules'
import { hub } from '../ws/hub'

/**
 * 群聊里的 AI 成员。
 *
 * 和主动私聊的分工一样：规则判定、配额占位都在服务端，保证多端只看到一条；
 * 密钥在本机时服务端只派发 `ai.group.due`，由在线客户端生成后回传落库。
 */

const TZ_OFFSET_MIN = serverTzOffsetMinutes()
const STALE_PENDING_MS = 5 * 60_000
const MAX_REPLIES_PER_MESSAGE = 2
const RECENT_LIMIT = 30

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
  channelId: string | null
  member: GroupPersonaMember
  kind: 'reply' | 'autonomy'
  logId: string
  mood: string
  energy: number
  /** 插话时引用的触发消息，只有第一条分条会挂上 */
  replyToId: string | null
  trigger: { messageId: string; speaker: string; content: string; mustReply: boolean } | null
}

function clampEnergy(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/* ------------------------------ 成员与状态 ------------------------------ */

/** 群里所有还在的 AI 成员（影子账号未被禁用、角色未删除） */
export function listGroupPersonas(db: DB, conversationId: string): GroupPersonaMember[] {
  const rows = db
    .prepare(
      `SELECT p.* FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.type = 'group' AND c.deleted_at IS NULL
       JOIN ai_personas p ON p.user_id = cm.user_id AND p.deleted_at IS NULL
       JOIN users u ON u.id = cm.user_id AND u.status = 'active'
       WHERE cm.conversation_id = ? AND cm.left_at IS NULL
       ORDER BY cm.joined_at`,
    )
    .all(conversationId) as aiRepo.PersonaRow[]

  return rows.map((persona) => ({
    persona,
    botUserId: persona.user_id!,
    provider: resolvePersonaProvider(db, persona),
  }))
}

function resolvePersonaProvider(db: DB, persona: aiRepo.PersonaRow): aiRepo.ProviderRow | null {
  if (persona.provider_id) {
    const provider = aiRepo.findProvider(db, persona.provider_id)
    if (provider) return provider
  }
  return aiRepo.defaultProvider(db, persona.owner_id) ?? null
}

function readState(db: DB, conversationId: string, personaId: string): GroupState {
  const row = db
    .prepare('SELECT * FROM ai_group_state WHERE conversation_id = ? AND persona_id = ?')
    .get(conversationId, personaId) as
    | {
        energy: number
        mood: string
        last_reply_at: number | null
        last_autonomy_at: number | null
        updated_at: number
      }
    | undefined

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

function writeState(db: DB, conversationId: string, personaId: string, state: GroupState): void {
  db.prepare(
    `INSERT INTO ai_group_state
       (conversation_id, persona_id, energy, mood, last_reply_at, last_autonomy_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, persona_id) DO UPDATE SET
       energy = excluded.energy,
       mood = excluded.mood,
       last_reply_at = excluded.last_reply_at,
       last_autonomy_at = excluded.last_autonomy_at,
       updated_at = excluded.updated_at`,
  ).run(
    conversationId,
    personaId,
    state.energy,
    state.mood,
    state.lastReplyAt,
    state.lastAutonomyAt,
    state.updatedAt,
  )
}

function countToday(
  db: DB,
  conversationId: string,
  personaId: string,
  dayKey: string,
  kind: 'reply' | 'autonomy',
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ai_group_log
       WHERE conversation_id = ? AND persona_id = ? AND day_key = ? AND kind = ?
         AND status IN ('pending', 'dispatched', 'sent')`,
    )
    .get(conversationId, personaId, dayKey, kind) as { c: number }
  return row.c
}

interface ReservedTurn {
  logId: string
  slot: number
  mood: string
  energy: number
}

/** 先占配额再生成：昨天遗留的 pending 不会卡住今天 */
function reserveTurn(
  db: DB,
  input: {
    conversationId: string
    channelId: string | null
    member: GroupPersonaMember
    kind: 'reply' | 'autonomy'
    dayKey: string
    maxPerDay: number
    state: GroupState
    replyToId?: string | null
  },
): ReservedTurn | null {
  return withTx(db, () => {
    const used = countToday(db, input.conversationId, input.member.persona.id, input.dayKey, input.kind)
    if (used >= input.maxPerDay) return null

    const ts = now()
    const logId = ulid()
    try {
      db.prepare(
        `INSERT INTO ai_group_log
           (id, conversation_id, persona_id, user_id, channel_id, kind, day_key, slot, status,
            message_id, reply_to_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
      ).run(
        logId,
        input.conversationId,
        input.member.persona.id,
        input.member.persona.owner_id,
        input.channelId,
        input.kind,
        input.dayKey,
        used,
        input.replyToId ?? null,
        ts,
      )
    } catch {
      // 自主开口有唯一索引，多实例只有一个能抢到同一格
      return null
    }

    const spend = input.kind === 'autonomy' ? 20 : 10
    const energy = clampEnergy(input.state.energy - spend)
    writeState(db, input.conversationId, input.member.persona.id, {
      energy,
      mood: deriveMood(energy),
      lastReplyAt: input.kind === 'reply' ? ts : input.state.lastReplyAt,
      lastAutonomyAt: input.kind === 'autonomy' ? ts : input.state.lastAutonomyAt,
      updatedAt: ts,
    })

    return { logId, slot: used, mood: deriveMood(energy), energy }
  })
}

function finishLog(
  db: DB,
  logId: string,
  status: 'sent' | 'dispatched' | 'skipped' | 'failed',
  extra: { messageId?: string | null; reason?: string | null } = {},
): void {
  db.prepare('UPDATE ai_group_log SET status = ?, message_id = ?, reason = ? WHERE id = ?').run(
    status,
    extra.messageId ?? null,
    extra.reason ?? null,
    logId,
  )
}

/** 决策落库后实时推给主人的在线客户端；客户端按 debugMode 决定是否显示 */
function pushDecision(db: DB, ownerId: string, decision: debugRepo.InsertDecisionInput): void {
  const row = debugRepo.insertDecision(db, decision)
  hub().sendToUser(ownerId, 'ai.debug.decision', { decision: row })
}

/** 模型层产出（发出 / 沉默 / 失败）回填到规则层创建的决策记录上，并推送更新 */
function resolveDecisionOutcome(
  db: DB,
  ownerId: string,
  logId: string,
  reason: string,
  fired: boolean,
): void {
  const updated = debugRepo.updateDecisionOutcome(db, logId, {
    stage: 'model',
    reason,
    fired,
  })
  if (updated) hub().sendToUser(ownerId, 'ai.debug.decision', { decision: updated })
}

/* ------------------------------ 提示词上下文 ------------------------------ */

function rosterOf(db: DB, conversationId: string, selfBotId: string): Array<{ name: string; isSelf: boolean }> {
  const rows = membersRepo.listActive(db, conversationId)
  const users = new Map(
    usersRepo
      .listByIds(
        db,
        rows.map((row) => row.user_id),
      )
      .map((user) => [user.id, user.display_name]),
  )
  return rows.map((row) => ({
    name: users.get(row.user_id) ?? row.user_id,
    isSelf: row.user_id === selfBotId,
  }))
}

function recentMessages(db: DB, conversationId: string, channelId: string | null): Message[] {
  const rows = messagesRepo.page(db, {
    conversationId,
    channelId,
    before: null,
    after: null,
    limit: RECENT_LIMIT,
  })
  return rows.reverse().map(messagesRepo.mapMessage)
}

/** 某条消息在引用谁：先查群里成员名，再退回 users 表，最后给个泛称 */
function quotedOfMessage(
  db: DB,
  replyToId: string | null | undefined,
  nameById: Map<string, string>,
): { speaker: string; content: string } | null {
  if (!replyToId) return null
  const row = messagesRepo.findById(db, replyToId)
  if (!row) return null
  const speaker =
    (row.sender_id ? nameById.get(row.sender_id) : null) ??
    (row.sender_id ? usersRepo.findById(db, row.sender_id)?.display_name : null) ??
    '某人'
  return { speaker, content: messagesRepo.previewOf(row) }
}

function toPromptRecent(
  db: DB,
  messages: Message[],
  selfBotId: string,
  nameById: Map<string, string>,
): Array<{
  speaker: string
  content: string
  isSelf: boolean
  mentionsSelf?: boolean
  replyTo?: { speaker: string; content: string } | null
}> {
  return messages
    .filter((message) => message.senderType !== 'system' && !message.deletedAt && message.content.trim().length > 0)
    .map((message) => ({
      speaker: nameById.get(message.senderId ?? '') ?? '某人',
      content: message.content,
      isSelf: message.senderId === selfBotId,
      mentionsSelf: Boolean(message.meta?.mentions?.includes(selfBotId)),
      replyTo: quotedOfMessage(db, message.replyToId, nameById),
    }))
}

function buildTurnPrompt(
  db: DB,
  input: GroupTurnInput,
): ReturnType<typeof buildGroupPrompt> {
  const conversation = conversationsRepo.findById(db, input.conversationId)
  const persona = aiRepo.mapPersona(input.member.persona)
  const messages = recentMessages(db, input.conversationId, input.channelId)
  const nameById = new Map(
    membersRepo
      .listActive(db, input.conversationId)
      .map((row) => [
        row.user_id,
        usersRepo.findById(db, row.user_id)?.display_name ?? row.user_id,
      ] as const),
  )

  const triggerRow = input.trigger ? messagesRepo.findById(db, input.trigger.messageId) : null

  return buildGroupPrompt({
    persona,
    mood: input.mood,
    energy: input.energy,
    groupName: conversation?.name ?? '群聊',
    members: rosterOf(db, input.conversationId, input.member.botUserId),
    recent: toPromptRecent(db, messages, input.member.botUserId, nameById),
    mode: input.kind,
    trigger: input.trigger
      ? {
          speaker: input.trigger.speaker,
          content: input.trigger.content,
          mustReply: input.trigger.mustReply,
          replyTo: triggerRow ? quotedOfMessage(db, triggerRow.reply_to_id, nameById) : null,
        }
      : null,
    idleHours:
      input.kind === 'autonomy'
        ? Math.max(0, Math.floor((now() - conversationLastMessageAt(db, input.conversationId)) / 3_600_000))
        : undefined,
    localTime: formatLocalTime(now(), TZ_OFFSET_MIN),
  })
}

function conversationLastMessageAt(db: DB, conversationId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(created_at), 0) AS ts FROM messages WHERE conversation_id = ?')
    .get(conversationId) as { ts: number }
  return row.ts
}

/* ------------------------------ 消息落库 ------------------------------ */

function appendGroupSegment(
  db: DB,
  input: {
    conversationId: string
    channelId: string | null
    persona: aiRepo.PersonaRow
    generationId: string
    index: number
    content: string
    totalSegments: number
    model?: string | null
    proactive?: boolean
    replyToId?: string | null
  },
): Message {
  const clientNonce = `${input.generationId}-${input.index}`
  const existing = messagesRepo.findByNonceInConversation(db, input.conversationId, clientNonce)
  if (existing) return messagesRepo.mapMessage(existing)

  const meta: MessageMeta = {
    ai: {
      generationId: input.generationId,
      index: input.index,
      personaId: input.persona.id,
      totalSegments: input.totalSegments,
      model: input.model ?? undefined,
      ...(input.proactive ? { proactive: true } : {}),
    },
  }

  return appendSystemMessage(db, {
    conversationId: input.conversationId,
    channelId: input.channelId,
    senderType: 'ai' as SenderType,
    senderId: input.persona.user_id,
    type: 'text',
    content: input.content,
    meta,
    replyToId: input.replyToId ?? null,
    aiGenerationId: input.generationId,
    aiIndex: input.index,
    clientNonce,
  })
}

function appendSegments(
  db: DB,
  input: GroupTurnInput,
  segments: string[],
  model: string | null,
): string | null {
  let firstId: string | null = null
  for (let index = 0; index < segments.length; index++) {
    const message = appendGroupSegment(db, {
      conversationId: input.conversationId,
      channelId: input.channelId,
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

async function runTurn(db: DB, input: GroupTurnInput): Promise<void> {
  const provider = input.member.provider
  if (!provider) {
    finishLog(db, input.logId, 'skipped', { reason: 'no_provider' })
    resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'no_provider', false)
    return
  }

  const prompt = buildTurnPrompt(db, input)
  const model = input.member.persona.model_override ?? provider.model

  // 密钥在本机：服务端只负责派发，在线客户端生成后回传
  if (provider.key_location !== 'server') {
    if (!hub().isOnline(input.member.persona.owner_id)) {
      finishLog(db, input.logId, 'skipped', { reason: 'local_key_offline' })
      resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'local_key_offline', false)
      return
    }
    hub().sendToUser(input.member.persona.owner_id, 'ai.group.due', {
      logId: input.logId,
      conversationId: input.conversationId,
      channelId: input.channelId,
      personaId: input.member.persona.id,
      kind: input.kind,
      triggerMessageId: input.trigger?.messageId ?? null,
      mood: input.mood,
      energy: input.energy,
      dueAt: now(),
    })
    finishLog(db, input.logId, 'dispatched')
    return
  }

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
    finishLog(db, input.logId, 'failed', { reason })
    resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, reason, false)
    return
  }

  if (isSkipReply(reply)) {
    finishLog(db, input.logId, 'skipped', { reason: 'skip' })
    resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'skip', false)
    return
  }

  const settings = aiRepo.readGlobalSettings(db, input.member.persona.owner_id)
  const segments = splitSegments(reply, {
    enabled: settings.segmentEnabled,
    pattern: settings.segmentPattern,
  }).slice(0, 3)
  if (segments.length === 0) {
    finishLog(db, input.logId, 'skipped', { reason: 'empty_reply' })
    resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'empty_reply', false)
    return
  }

  const firstId = appendSegments(db, input, segments, model)
  finishLog(db, input.logId, 'sent', { messageId: firstId })
  resolveDecisionOutcome(db, input.member.persona.owner_id, input.logId, 'sent', true)

  if (input.kind === 'autonomy') {
    createNotification(db, {
      userId: input.member.persona.owner_id,
      type: 'ai_proactive',
      title: input.member.persona.name,
      body: segments.join(' ').slice(0, 120),
      conversationId: input.conversationId,
      messageId: firstId,
    })
  }
}

/* ------------------------------ 对外入口 ------------------------------ */

export interface GroupMessageTrigger {
  conversationId: string
  channelId: string | null
  messageId: string
  senderId: string
  content: string
  mentions?: string[]
  mentionAll?: boolean
}

/** 用户发了一条群消息：规则预筛后决定谁接话 */
export async function respondToGroupMessage(db: DB, trigger: GroupMessageTrigger): Promise<void> {
  const conversation = conversationsRepo.findById(db, trigger.conversationId)
  if (!conversation || conversation.type !== 'group' || conversation.deleted_at !== null) return

  const sender = usersRepo.findById(db, trigger.senderId)
  const senderName = sender?.display_name ?? '某人'
  if (sender?.is_bot === 1) return

  const members = listGroupPersonas(db, trigger.conversationId)
  if (members.length === 0) return

  const ts = now()
  const dayKey = localDayKey(ts, TZ_OFFSET_MIN)
  let fired = 0

  for (const member of members) {
    if (fired >= MAX_REPLIES_PER_MESSAGE) break

    const mapped = aiRepo.mapPersona(member.persona)
    const settings = aiRepo.readGlobalSettings(db, member.persona.owner_id)
    const mentioned =
      trigger.mentionAll ||
      Boolean(trigger.mentions?.includes(member.botUserId)) ||
      (mapped.name.length > 0 && trigger.content.includes(`@${mapped.name}`))

    const state = readState(db, trigger.conversationId, member.persona.id)
    const decision = decideGroupReply({
      now: ts,
      enabled: settings.groupEnabled,
      repliesToday: countToday(db, trigger.conversationId, member.persona.id, dayKey, 'reply'),
      maxRepliesPerDay: settings.groupRepliesPerDay,
      lastReplyAt: state.lastReplyAt,
      energy: state.energy,
      mustReply: mentioned,
      relevance: relevanceOf(trigger.content, mapped.name, mapped.interests),
      random: Math.random,
    })

    // 调试模式的数据源：规则层没放行也记一条，让主人看到「谁为什么没接话」
    if (!decision.fire) {
      if (settings.groupEnabled) {
        pushDecision(db, member.persona.owner_id, {
          conversationId: trigger.conversationId,
          personaId: member.persona.id,
          personaName: mapped.name,
          triggerMessageId: trigger.messageId,
          channelId: trigger.channelId,
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

    const reserved = reserveTurn(db, {
      conversationId: trigger.conversationId,
      channelId: trigger.channelId,
      member,
      kind: 'reply',
      dayKey,
      maxPerDay: settings.groupRepliesPerDay,
      state,
      replyToId: trigger.messageId,
    })
    if (!reserved) continue

    pushDecision(db, member.persona.owner_id, {
      conversationId: trigger.conversationId,
      personaId: member.persona.id,
      personaName: mapped.name,
      triggerMessageId: trigger.messageId,
      channelId: trigger.channelId,
      kind: 'reply',
      fired: true,
      stage: 'rules',
      reason: decision.reason,
      energy: reserved.energy,
      mood: reserved.mood,
      logId: reserved.logId,
    })

    fired += 1
    try {
      await runTurn(db, {
        conversationId: trigger.conversationId,
        channelId: trigger.channelId,
        member,
        kind: 'reply',
        logId: reserved.logId,
        mood: reserved.mood,
        energy: reserved.energy,
        replyToId: trigger.messageId,
        trigger: {
          messageId: trigger.messageId,
          speaker: senderName,
          content: trigger.content,
          mustReply: mentioned,
        },
      })
    } catch (e) {
      finishLog(db, reserved.logId, 'failed', {
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

/** 客户端代跑：把本机生成的群消息交回服务端落库 */
export function appendClientGroupSegment(
  db: DB,
  ownerId: string,
  input: {
    logId: string
    personaId: string
    conversationId: string
    channelId?: string | null
    generationId: string
    index: number
    content: string
    clientNonce: string
    model?: string
    totalSegments?: number
  },
): Message {
  const persona = aiRepo.findPersona(db, input.personaId)
  if (!persona || persona.owner_id !== ownerId) throw err.forbidden('无权使用该角色')
  if (!persona.user_id) throw err.validation('该角色还没有绑定账号')

  if (!membersRepo.findActive(db, input.conversationId, persona.user_id)) {
    throw err.forbidden('该角色不在这个群里')
  }

  const existing = messagesRepo.findByNonceInConversation(db, input.conversationId, input.clientNonce)
  if (existing) return messagesRepo.mapMessage(existing)

  const log = db.prepare('SELECT * FROM ai_group_log WHERE id = ?').get(input.logId) as
    | {
        conversation_id: string
        persona_id: string
        kind: string
        status: string
        reply_to_id: string | null
      }
    | undefined
  if (!log || log.conversation_id !== input.conversationId || log.persona_id !== persona.id) {
    throw err.notFound('这次发言机会不存在')
  }
  if (log.status === 'skipped' || log.status === 'failed') {
    throw err.validation('这次发言机会已经结束')
  }

  const message = appendSystemMessage(db, {
    conversationId: input.conversationId,
    channelId: input.channelId ?? null,
    senderType: 'ai' as SenderType,
    senderId: persona.user_id,
    type: 'text',
    content: input.content,
    meta: {
      ai: {
        generationId: input.generationId,
        index: input.index,
        personaId: persona.id,
        totalSegments: input.totalSegments,
        model: input.model,
        ...(log?.kind === 'autonomy' ? { proactive: true } : {}),
      },
    },
    // 与本地生成保持一致：只有第一条分条引用触发它的消息
    replyToId: input.index === 0 ? (log?.reply_to_id ?? null) : null,
    aiGenerationId: input.generationId,
    aiIndex: input.index,
    clientNonce: input.clientNonce,
  })

  if (input.index === 0 && log && log.status !== 'sent') {
    finishLog(db, input.logId, 'sent', { messageId: message.id })
    resolveDecisionOutcome(db, persona.owner_id, input.logId, 'sent', true)
  }
  return message
}

/** 客户端判断「不想说」时回报，服务端把这条配额标记为跳过 */
export function skipClientGroupDue(db: DB, ownerId: string, logId: string, reason?: string): void {
  const log = db.prepare('SELECT * FROM ai_group_log WHERE id = ?').get(logId) as
    | { persona_id: string; status: string }
    | undefined
  if (!log) throw err.notFound('记录不存在')

  const persona = aiRepo.findPersona(db, log.persona_id)
  if (!persona || persona.owner_id !== ownerId) throw err.forbidden('无权操作')
  if (log.status === 'sent') return

  const skipReason = reason ?? 'client_skip'
  finishLog(db, logId, 'skipped', { reason: skipReason })
  resolveDecisionOutcome(db, ownerId, logId, skipReason, false)
}

/* ------------------------------ 自主开口 ------------------------------ */

interface AutonomyCandidate {
  conversation_id: string
  persona: aiRepo.PersonaRow
}

function listAutonomyCandidates(db: DB): AutonomyCandidate[] {
  const rows = db
    .prepare(
      `SELECT cm.conversation_id AS conversation_id, p.*
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.type = 'group' AND c.deleted_at IS NULL
       JOIN ai_personas p ON p.user_id = cm.user_id AND p.deleted_at IS NULL
       JOIN users u ON u.id = cm.user_id AND u.status = 'active'
       WHERE cm.left_at IS NULL
       ORDER BY cm.joined_at`,
    )
    .all() as Array<aiRepo.PersonaRow & { conversation_id: string }>

  return rows.map((row) => ({ conversation_id: row.conversation_id, persona: row }))
}

function firstTextChannelId(db: DB, conversationId: string): string | null {
  const channels = channelsRepo.listByConversation(db, conversationId)
  return channels.find((channel) => channel.kind === 'text')?.id ?? channels[0]?.id ?? null
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

  db.prepare(
    `UPDATE ai_group_log SET status = 'failed', reason = 'stale_pending'
     WHERE status = 'pending' AND created_at < ?`,
  ).run(ts - STALE_PENDING_MS)

  const spokenGroups = new Set<string>()

  for (const candidate of listAutonomyCandidates(db)) {
    if (spokenGroups.has(candidate.conversation_id)) continue

    const settings = aiRepo.readGlobalSettings(db, candidate.persona.owner_id)
    if (!settings.groupEnabled) continue

    const state = readState(db, candidate.conversation_id, candidate.persona.id)
    const lastMessageAt = conversationLastMessageAt(db, candidate.conversation_id)
    const decision = decideGroupAutonomy({
      now: ts,
      enabled: settings.groupEnabled,
      autonomyToday: countToday(db, candidate.conversation_id, candidate.persona.id, dayKey, 'autonomy'),
      maxAutonomyPerDay: settings.groupAutonomyPerDay,
      lastAutonomyAt: state.lastAutonomyAt,
      idleMs: ts - lastMessageAt,
      energy: state.energy,
      inQuietWindow: inQuietWindow(ts, settings.windowStart ?? undefined, settings.windowEnd ?? undefined, TZ_OFFSET_MIN),
      random,
    })
    if (!decision.fire) {
      // 规则层没放行也记一条：主人需要看到「谁为什么没主动开口」
      pushDecision(db, candidate.persona.owner_id, {
        conversationId: candidate.conversation_id,
        personaId: candidate.persona.id,
        personaName: candidate.persona.name,
        triggerMessageId: null,
        channelId: null,
        kind: 'autonomy',
        fired: false,
        stage: 'rules',
        reason: decision.reason,
        energy: state.energy,
        mood: state.mood,
      })
      continue
    }

    const member: GroupPersonaMember = {
      persona: candidate.persona,
      botUserId: candidate.persona.user_id!,
      provider: resolvePersonaProvider(db, candidate.persona),
    }

    const reserved = reserveTurn(db, {
      conversationId: candidate.conversation_id,
      channelId: firstTextChannelId(db, candidate.conversation_id),
      member,
      kind: 'autonomy',
      dayKey,
      maxPerDay: settings.groupAutonomyPerDay,
      state,
      replyToId: null,
    })
    if (!reserved) continue

    pushDecision(db, candidate.persona.owner_id, {
      conversationId: candidate.conversation_id,
      personaId: candidate.persona.id,
      personaName: candidate.persona.name,
      triggerMessageId: null,
      channelId: null,
      kind: 'autonomy',
      fired: true,
      stage: 'rules',
      reason: decision.reason,
      energy: reserved.energy,
      mood: reserved.mood,
      logId: reserved.logId,
    })

    spokenGroups.add(candidate.conversation_id)
    try {
      await runTurn(db, {
        conversationId: candidate.conversation_id,
        channelId: firstTextChannelId(db, candidate.conversation_id),
        member,
        kind: 'autonomy',
        logId: reserved.logId,
        mood: reserved.mood,
        energy: reserved.energy,
        replyToId: null,
        trigger: null,
      })
    } catch (e) {
      log.error({ err: e, personaId: candidate.persona.id }, '群自主发言失败')
      finishLog(db, reserved.logId, 'failed', { reason: 'exception' })
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
