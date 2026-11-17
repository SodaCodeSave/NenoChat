import {
  ContactRelation,
  ConversationType,
  Role,
  buildChatMessages,
  cutStreamingSegments,
  estimateTokens,
  extractStickerMarker,
  segmentDelay,
  splitSegments,
  stripStickerMarkers,
  type AiMemoryFact,
  type AiMemorySummary,
  type AiDebugSummary,
  type AiGroupDecision,
  type AiPersona,
  type AiProvider,
  type AiUsageEntry,
  type AiUsageKind,
  type ChatMessage,
  type ConnectorActionMeta,
  type Conversation,
  type AttachmentRef,
  type Message,
  type MessageMeta,
  type ReplyStyle,
  type SegmentRule,
  type SenderType,
  type TurnImage,
} from '@nenochat/shared'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db'
import { dataDir } from '../db'
import { withTx } from '../db/tx'
import * as aiRepo from '../db/repo/ai'
import * as attachmentsRepo from '../db/repo/attachments'
import * as contactsRepo from '../db/repo/contacts'
import * as conversationsRepo from '../db/repo/conversations'
import * as debugRepo from '../db/repo/debug'
import * as membersRepo from '../db/repo/members'
import * as messagesRepo from '../db/repo/messages'
import * as scheduleRepo from '../db/repo/schedule'
import * as stickersRepo from '../db/repo/stickers'
import { localDayKey, minutesOfDay, serverTzOffsetMinutes } from './proactive-rules'
import { buildConnectorContext } from './connector-context'
import * as usersRepo from '../db/repo/users'
import { IMAGE_MIME } from './file-service'
import { writeChange } from './change-log'
import { err } from '../util/errors'
import { decryptSecret, encryptSecret, maskSecret } from '../util/crypto'
import { appendSystemMessage } from './message-service'
import {
  emitAiConnectorStatus,
  emitAiDelta,
  emitAiDone,
  emitAiError,
  emitAiSegment,
  emitConversationUpdated,
  emitMemberRemoved,
  emitMessageCreated,
} from '../ws/emitter'

/** 与服务端定时任务保持同一套时区口径 */
const TZ_OFFSET_MIN = serverTzOffsetMinutes()

/* ------------------------------ 服务商 ------------------------------ */

function toPublicProvider(row: aiRepo.ProviderRow): AiProvider {
  let masked: string | null = null
  if (row.api_key_enc) {
    try {
      masked = maskSecret(decryptSecret(row.api_key_enc))
    } catch {
      masked = '****'
    }
  }
  return aiRepo.mapProvider(row, masked)
}

export function listProviders(db: DB, ownerId: string): AiProvider[] {
  return aiRepo.listProviders(db, ownerId).map(toPublicProvider)
}

export interface ProviderPayload {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  keyLocation: 'local' | 'server'
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
  visionModel?: string | null
  contextWindow?: number | null
}

export function createProvider(db: DB, ownerId: string, input: ProviderPayload): AiProvider {
  const apiKeyEnc =
    input.keyLocation === 'server' && input.apiKey ? encryptSecret(input.apiKey) : null

  const row = withTx(db, () =>
    aiRepo.createProvider(db, {
      ownerId,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKeyEnc,
      keyLocation: input.keyLocation,
      model: input.model,
      visionModel: input.visionModel,
      contextWindow: input.contextWindow,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      isDefault: input.isDefault,
    }),
  )
  return toPublicProvider(row)
}

export function updateProvider(db: DB, ownerId: string, id: string, input: Partial<ProviderPayload>): AiProvider {
  const current = aiRepo.findProvider(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('服务商不存在')

  const apiKeyEnc =
    input.apiKey === undefined
      ? undefined
      : input.apiKey
        ? encryptSecret(input.apiKey)
        : null

  const row = withTx(db, () =>
    aiRepo.updateProvider(db, id, {
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      visionModel: input.visionModel,
      contextWindow: input.contextWindow,
      keyLocation: input.keyLocation,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      isDefault: input.isDefault,
      apiKeyEnc,
    }),
  )
  return toPublicProvider(row)
}

export function deleteProvider(db: DB, ownerId: string, id: string): void {
  const current = aiRepo.findProvider(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('服务商不存在')
  aiRepo.softDeleteProvider(db, id)
}

/** 从服务端托管的 key 取明文，仅在 server 模式下可用 */
export function resolveServerApiKey(row: aiRepo.ProviderRow): string {
  if (!row.api_key_enc) throw err.validation('该服务商没有托管密钥，请在本机配置')
  return decryptSecret(row.api_key_enc)
}

/* ------------------------------- 角色 ------------------------------- */

function toPublicPersona(row: aiRepo.PersonaRow): AiPersona {
  return aiRepo.mapPersona(row)
}

export function listPersonas(db: DB, ownerId: string): AiPersona[] {
  return aiRepo.listPersonas(db, ownerId).map(toPublicPersona)
}

export interface PersonaPayload {
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
  proactive?: {
    enabled: boolean
    minIdleHours: number
    maxPerDay: number
    windowStart?: string
    windowEnd?: string
  }
}

/**
 * 保证一个角色有一条 type='ai' 会话（幂等）。
 * - 会话、成员、ai_sessions 与 change_log 全在一个事务里，调用方可以放心把它嵌进更大的事务
 * - 内部不发任何 WS 事件，emit 一律由调用方在事务提交后做，避免「已广播但回滚」
 * - 没有 providerId 时只建会话不建 ai_sessions，等拿到服务商再补
 *   （保留「没配服务商也能先建角色」的既有能力）
 */
export function ensureAiConversation(
  db: DB,
  input: { userId: string; persona: aiRepo.PersonaRow; providerId?: string | null; title?: string | null },
): { conversationId: string; created: boolean; conversation: Conversation } {
  const existing = db
    .prepare(
      `SELECT * FROM conversations
       WHERE type = 'ai' AND ai_owner_user_id = ? AND ai_persona_id = ? AND deleted_at IS NULL
       ORDER BY created_at LIMIT 1`,
    )
    .get(input.userId, input.persona.id) as conversationsRepo.ConversationRow | undefined

  if (existing) {
    return {
      conversationId: existing.id,
      created: false,
      conversation: conversationsRepo.mapConversation(existing),
    }
  }

  const row = withTx(db, () => {
    const conv = conversationsRepo.create(db, {
      type: ConversationType.Ai,
      name: input.title ?? input.persona.name,
      avatarUrl: input.persona.avatar_url,
      ownerId: input.userId,
      aiPersonaId: input.persona.id,
      aiOwnerUserId: input.userId,
    })

    membersRepo.upsert(db, { conversationId: conv.id, userId: input.userId, role: Role.Owner })

    if (input.providerId) {
      aiRepo.createSession(db, {
        conversationId: conv.id,
        personaId: input.persona.id,
        providerId: input.providerId,
      })
    }

    writeChange(db, {
      entity: 'conversation',
      entityId: conv.id,
      op: 'upsert',
      conversationId: conv.id,
      payload: conversationsRepo.mapConversation(conv),
      actorId: input.userId,
    })
    return conv
  })

  return {
    conversationId: row.id,
    created: true,
    conversation: conversationsRepo.mapConversation(row),
  }
}

export function createPersona(db: DB, ownerId: string, input: PersonaPayload): AiPersona {
  const result = withTx(db, () => {
    const created = aiRepo.createPersona(db, {
      ownerId,
      name: input.name,
      systemPrompt: input.systemPrompt,
      avatarUrl: input.avatarUrl ?? null,
      interests: input.interests,
      card: input.card ?? null,
      cardUrl: input.cardUrl ?? null,
      cardFilename: input.cardFilename ?? null,
      inContacts: input.inContacts,
      providerId: input.providerId ?? null,
      modelOverride: input.modelOverride ?? null,
      temperature: input.temperature ?? null,
      replyStyle: input.replyStyle,
      greeting: input.greeting ?? null,
      proactive: input.proactive,
    })

    // 角色同时是一个「用户」：进群、加好友、通讯录都复用它
    const botId = `bot-${created.id}`
    const bot = usersRepo.createBot(db, {
      id: botId,
      displayName: created.name,
      avatarUrl: created.avatar_url,
    })
    aiRepo.setPersonaUserId(db, created.id, botId)
    const row = aiRepo.findPersona(db, created.id) ?? created

    // 通讯录里 AI 和真人一视同仁：建角色即成为好友
    if (row.in_contacts === 1) {
      const contact = contactsRepo.upsert(db, {
        ownerId,
        contactUserId: botId,
        relation: ContactRelation.Friend,
      })
      writeChange(db, {
        entity: 'contact',
        entityId: `${ownerId}:${botId}`,
        op: 'upsert',
        userId: ownerId,
        payload: {
          ownerId,
          contactUserId: botId,
          alias: contact.alias,
          relation: contact.relation,
          requestMessage: null,
          createdAt: contact.created_at,
          updatedAt: contact.updated_at,
          user: usersRepo.mapPublicUser(bot),
        },
        actorId: ownerId,
      })
    }

    const mapped = aiRepo.mapPersona(row)

    writeChange(db, {
      entity: 'ai_persona',
      entityId: row.id,
      op: 'upsert',
      userId: ownerId,
      payload: mapped,
      actorId: ownerId,
    })

    // 产品行为：建好角色就出现在「消息」与「通讯录」里，不用再点一次「聊天」
    const providerId = row.provider_id ?? aiRepo.defaultProvider(db, ownerId)?.id ?? null
    const ensured = mapped.inContacts
      ? ensureAiConversation(db, { userId: ownerId, persona: row, providerId })
      : null

    return { row, mapped, ensured }
  })

  // 事务提交后再广播
  if (result.ensured) {
    const { conversation, conversationId, created } = result.ensured
    emitConversationUpdated(db, conversation)
    if (created && result.row.greeting) {
      appendAiSegment(db, conversationId, {
        generationId: `greet-${conversationId}`,
        index: 0,
        content: result.row.greeting,
        clientNonce: `greet-${conversationId}`,
        personaId: result.row.id,
      })
    }
  }

  return result.mapped
}

/** 角色改名/换头像后，把其所有 AI 会话的快照一起刷掉（会话列表与聊天头部直接读会话字段） */
function syncPersonaToConversations(db: DB, persona: aiRepo.PersonaRow): Conversation[] {
  const rows = db
    .prepare(`SELECT * FROM conversations WHERE type = 'ai' AND ai_persona_id = ? AND deleted_at IS NULL`)
    .all(persona.id) as conversationsRepo.ConversationRow[]

  const out: Conversation[] = []
  for (const row of rows) {
    const updated = conversationsRepo.update(db, row.id, {
      name: persona.name,
      avatarUrl: persona.avatar_url,
    })
    const mapped = conversationsRepo.mapConversation(updated)
    writeChange(db, {
      entity: 'conversation',
      entityId: updated.id,
      op: 'upsert',
      conversationId: updated.id,
      payload: mapped,
      actorId: persona.owner_id,
    })
    out.push(mapped)
  }
  return out
}

export function updatePersona(db: DB, ownerId: string, id: string, input: Partial<PersonaPayload>): AiPersona {
  const current = aiRepo.findPersona(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('角色不存在')

  const result = withTx(db, () => {
    const row = aiRepo.updatePersona(db, id, input)
    const conversations = syncPersonaToConversations(db, row)

    // 群成员列表与通讯录都读 users 表，角色改名/换头像必须同步影子账号
    if (row.user_id) {
      usersRepo.updateBotProfile(db, row.user_id, {
        displayName: row.name,
        avatarUrl: row.avatar_url,
      })

      const existing = contactsRepo.find(db, ownerId, row.user_id)
      if (row.in_contacts === 1) {
        if (!existing) {
          const contact = contactsRepo.upsert(db, {
            ownerId,
            contactUserId: row.user_id,
            relation: ContactRelation.Friend,
          })
          writeChange(db, {
            entity: 'contact',
            entityId: `${ownerId}:${row.user_id}`,
            op: 'upsert',
            userId: ownerId,
            payload: {
              ownerId,
              contactUserId: row.user_id,
              alias: contact.alias,
              relation: contact.relation,
              requestMessage: null,
              createdAt: contact.created_at,
              updatedAt: contact.updated_at,
              user: usersRepo.findById(db, row.user_id)
                ? usersRepo.mapPublicUser(usersRepo.findById(db, row.user_id)!)
                : null,
            },
            actorId: ownerId,
          })
        }
      } else if (existing) {
        contactsRepo.removePair(db, ownerId, row.user_id)
        writeChange(db, {
          entity: 'contact',
          entityId: `${ownerId}:${row.user_id}`,
          op: 'delete',
          userId: ownerId,
          payload: { ownerId, contactUserId: row.user_id },
          actorId: ownerId,
        })
      }
    }

    // 从「不在通讯录」改回「在通讯录」时补建会话
    let ensured: ReturnType<typeof ensureAiConversation> | null = null
    if (row.in_contacts === 1) {
      const providerId = row.provider_id ?? aiRepo.defaultProvider(db, ownerId)?.id ?? null
      ensured = ensureAiConversation(db, { userId: ownerId, persona: row, providerId })
    }

    const mapped = aiRepo.mapPersona(row)
    writeChange(db, {
      entity: 'ai_persona',
      entityId: row.id,
      op: 'upsert',
      userId: ownerId,
      payload: mapped,
      actorId: ownerId,
    })

    return { mapped, conversations, ensured }
  })

  for (const conversation of result.conversations) emitConversationUpdated(db, conversation)
  if (result.ensured?.created) emitConversationUpdated(db, result.ensured.conversation)

  return result.mapped
}

export function deletePersona(db: DB, ownerId: string, id: string): void {
  const current = aiRepo.findPersona(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('角色不存在')

  const result = withTx(db, () => {
    aiRepo.softDeletePersona(db, id)

    const rows = db
      .prepare(`SELECT * FROM conversations WHERE type = 'ai' AND ai_persona_id = ? AND deleted_at IS NULL`)
      .all(id) as conversationsRepo.ConversationRow[]

    const out: Conversation[] = []
    for (const row of rows) {
      conversationsRepo.softDelete(db, row.id)
      const next = conversationsRepo.findById(db, row.id)
      if (!next) continue
      const mapped = conversationsRepo.mapConversation(next)
      writeChange(db, {
        entity: 'conversation',
        entityId: row.id,
        op: 'delete',
        conversationId: row.id,
        payload: mapped,
        actorId: ownerId,
      })
      out.push(mapped)
    }

    // 影子账号、好友关系、群成员身份一起收尾，避免群里留下一个不会说话的成员
    const botId = current.user_id
    const leftGroups: string[] = []
    if (botId) {
      contactsRepo.removePair(db, ownerId, botId)
      writeChange(db, {
        entity: 'contact',
        entityId: `${ownerId}:${botId}`,
        op: 'delete',
        userId: ownerId,
        payload: { ownerId, contactUserId: botId },
        actorId: ownerId,
      })
      usersRepo.disableBot(db, botId)

      const memberships = db
        .prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ? AND left_at IS NULL')
        .all(botId) as Array<{ conversation_id: string }>
      for (const membership of memberships) {
        membersRepo.markLeft(db, membership.conversation_id, botId)
        writeChange(db, {
          entity: 'member',
          entityId: botId,
          op: 'delete',
          conversationId: membership.conversation_id,
          payload: { conversationId: membership.conversation_id, userId: botId },
          actorId: ownerId,
        })
        leftGroups.push(membership.conversation_id)
      }
    }

    writeChange(db, {
      entity: 'ai_persona',
      entityId: id,
      op: 'delete',
      userId: ownerId,
      payload: { id },
      actorId: ownerId,
    })
    return { conversations: out, leftGroups, botId }
  })

  for (const conversation of result.conversations) emitConversationUpdated(db, conversation)
  if (result.botId) {
    for (const conversationId of result.leftGroups) {
      emitMemberRemoved(db, conversationId, result.botId, [])
    }
  }
}

/**
 * 打开与某个角色的会话：同一角色已有会话时复用，
 * 避免每点一次「聊天」就多出一个空会话。
 */
export function openConversation(
  db: DB,
  userId: string,
  input: { personaId: string; providerId?: string; title?: string },
): Conversation {
  const persona = aiRepo.findPersona(db, input.personaId)
  if (!persona || persona.owner_id !== userId) throw err.notFound('角色不存在')

  const providerId = input.providerId ?? persona.provider_id ?? aiRepo.defaultProvider(db, userId)?.id
  if (!providerId) throw err.validation('请先配置 AI 服务商')

  const provider = aiRepo.findProvider(db, providerId)
  if (!provider || provider.owner_id !== userId) throw err.notFound('服务商不存在')

  const ensured = ensureAiConversation(db, {
    userId,
    persona,
    providerId,
    title: input.title ?? null,
  })

  // 复用已有会话时：服务商可能被换过，或之前没有服务商所以还没建 session
  if (!ensured.created) {
    withTx(db, () => {
      const session = aiRepo.findSession(db, ensured.conversationId)
      if (!session) {
        aiRepo.createSession(db, {
          conversationId: ensured.conversationId,
          personaId: persona.id,
          providerId,
        })
      } else if (session.provider_id !== providerId) {
        db.prepare('UPDATE ai_sessions SET provider_id = ?, updated_at = ? WHERE conversation_id = ?').run(
          providerId,
          Date.now(),
          ensured.conversationId,
        )
      }
    })
  }

  if (ensured.created && persona.greeting) {
    appendAiSegment(db, ensured.conversationId, {
      generationId: `greet-${ensured.conversationId}`,
      index: 0,
      content: persona.greeting,
      clientNonce: `greet-${ensured.conversationId}`,
      personaId: persona.id,
    })
  }

  return ensured.conversation
}

/* ---------------------------- AI 消息落库 ---------------------------- */

/** 表情消息的附件快照，与客户端手动发表情时构造的 meta 保持同一形态 */
function stickerAttachmentRef(sticker: stickersRepo.StickerRow, attachment: attachmentsRepo.AttachmentRow): AttachmentRef {
  return {
    id: sticker.attachment_id ?? sticker.id,
    kind: 'sticker',
    filename: `${sticker.id}.${sticker.kind === 'gif' ? 'gif' : 'png'}`,
    mime: sticker.kind === 'gif' ? 'image/gif' : 'image/png',
    size: 0,
    url: `/files/${attachment.storage_key}`,
  }
}

/**
 * 落一条 AI 的表情消息。表情可能刚被删掉或文件丢失，
 * 此时返回 null 让调用方只发文字，不要让整条回复消失。
 */
export function appendStickerMessage(
  db: DB,
  input: {
    conversationId: string
    stickerId: string
    generationId: string
    index: number
    clientNonce?: string | null
    personaId?: string
    model?: string
    totalSegments?: number
    proactive?: boolean
  },
): Message | null {
  const sticker = stickersRepo.findSticker(db, input.stickerId)
  if (!sticker || !sticker.attachment_id) return null
  const attachment = attachmentsRepo.findById(db, sticker.attachment_id)
  if (!attachment) return null

  const meta: MessageMeta = {
    ai: {
      generationId: input.generationId,
      index: input.index,
      model: input.model,
      personaId: input.personaId,
      totalSegments: input.totalSegments,
      ...(input.proactive ? { proactive: true } : {}),
    },
    stickerId: sticker.id,
    attachments: [stickerAttachmentRef(sticker, attachment)],
  }

  return appendSystemMessage(db, {
    conversationId: input.conversationId,
    senderType: 'ai' as SenderType,
    type: 'sticker',
    content: '',
    meta,
    aiGenerationId: input.generationId,
    aiIndex: input.index,
    clientNonce: input.clientNonce ?? null,
  })
}

/**
 * 追加一条 AI 分段消息。
 * 分段在服务端与客户端都按「一条消息一个片段」处理，
 * 这样置顶、未读、搜索、离线补拉全部复用普通消息能力。
 * 分段里若带有效的表情标记，会拆成文字与表情两条消息；
 * 每条分段最多解析一个标记，其余标记按噪音剔除。
 */
export function appendAiSegment(
  db: DB,
  conversationId: string,
  input: {
    generationId: string
    index: number
    content: string
    clientNonce?: string
    model?: string
    totalSegments?: number
    personaId?: string
    proactive?: boolean
    connector?: ConnectorActionMeta[]
  },
): Message {
  const conv = conversationsRepo.findById(db, conversationId)
  if (!conv || conv.type !== 'ai') throw err.notFound('AI 会话不存在')

  // 幂等：greeting 与主动消息在某些并发路径下可能被调两次
  if (input.clientNonce) {
    const dup = messagesRepo.findByNonceInConversation(db, conversationId, input.clientNonce)
    if (dup) return messagesRepo.mapMessage(dup)
  }

  const session = aiRepo.findSession(db, conversationId)
  const personaId = input.personaId ?? session?.persona_id ?? conv.ai_persona_id ?? undefined
  const ownerId = conv.ai_owner_user_id ?? null

  // 表情标记解析：清单为空（没授权任何表情包）时按普通文字处理
  const enabledIds = ownerId
    ? new Set(stickersRepo.listAiStickers(db, ownerId).map((row) => row.id))
    : new Set<string>()
  const marker = enabledIds.size > 0 ? extractStickerMarker(input.content, enabledIds) : null
  const text = marker?.stickerId ? marker.text : input.content

  const buildMeta = (index: number): MessageMeta => ({
    ai: {
      generationId: input.generationId,
      index,
      model: input.model,
      personaId,
      totalSegments: input.totalSegments,
      ...(input.proactive ? { proactive: true } : {}),
      ...(input.connector?.length ? { connector: input.connector } : {}),
    },
  })

  const stickerPayload = (index: number, clientNonce: string | null) => ({
    conversationId,
    stickerId: marker!.stickerId!,
    generationId: input.generationId,
    index,
    clientNonce,
    personaId,
    model: input.model,
    totalSegments: input.totalSegments,
    proactive: input.proactive,
  })

  const appendText = (content: string, index: number, clientNonce?: string | null): Message =>
    appendSystemMessage(db, {
      conversationId,
      senderType: 'ai' as SenderType,
      type: 'text',
      content,
      meta: buildMeta(index),
      aiGenerationId: input.generationId,
      aiIndex: index,
      clientNonce: clientNonce ?? input.clientNonce ?? null,
    })

  let first: Message
  if (marker?.stickerId && marker.stickerFirst) {
    const sticker = appendStickerMessage(db, stickerPayload(input.index, input.clientNonce ? `${input.clientNonce}-s` : null))
    const textIndex = sticker ? input.index + 1 : input.index
    first = sticker ?? appendText(text, input.index)
    if (text.trim()) appendText(text, textIndex)
  } else if (marker?.stickerId) {
    const textMessage = text.trim() ? appendText(text, input.index) : null
    const sticker = appendStickerMessage(
      db,
      stickerPayload(textMessage ? input.index + 1 : input.index, input.clientNonce ? `${input.clientNonce}-s` : null),
    )
    // 文字与表情都没落成时退回原文，宁可显示标记也不能丢整条回复
    first = textMessage ?? sticker ?? appendText(input.content, input.index)
  } else {
    first = appendText(text, input.index)
  }

  if (session) {
    aiRepo.bumpSessionProgress(db, conversationId, 1, estimateTokens(text))
  }
  return first
}

/* ------------------------------- 记忆 ------------------------------- */

export function listMemory(
  db: DB,
  userId: string,
  conversationId: string,
): { summaries: AiMemorySummary[]; facts: AiMemoryFact[] } {
  assertOwned(db, userId, conversationId)
  return {
    summaries: aiRepo.listSummaries(db, conversationId),
    facts: aiRepo.listFacts(db, conversationId).map(aiRepo.mapFact),
  }
}

export function deleteFact(db: DB, userId: string, conversationId: string, factId: string): void {
  assertOwned(db, userId, conversationId)
  withTx(db, () => aiRepo.rejectFact(db, conversationId, factId))
}

export interface MemoryWritePayload {
  summary?: { fromSeq: number; toSeq: number; text: string; model?: string | null }
  facts?: Array<{
    subject: 'user' | 'persona' | 'relation' | 'world'
    key: string
    value: string
    confidence?: number
  }>
}

/** 客户端压缩完成后回传结果，服务端负责落库与滚动链维护 */
export function writeMemory(db: DB, userId: string, conversationId: string, payload: MemoryWritePayload): void {
  assertOwned(db, userId, conversationId)

  withTx(db, () => {
    if (payload.summary) {
      aiRepo.insertSummary(db, {
        conversationId,
        fromSeq: payload.summary.fromSeq,
        toSeq: payload.summary.toSeq,
        summary: payload.summary.text,
        tokenEstimate: estimateTokens(payload.summary.text),
        model: payload.summary.model ?? null,
      })
      aiRepo.markCompacted(db, conversationId, payload.summary.toSeq)
    }

    for (const fact of payload.facts ?? []) {
      aiRepo.upsertFact(db, {
        conversationId,
        subject: fact.subject,
        key: fact.key,
        value: fact.value,
        confidence: fact.confidence ?? 0.7,
      })
    }
  })
}

function assertOwned(db: DB, userId: string, conversationId: string): void {
  const conv = conversationsRepo.findById(db, conversationId)
  if (!conv || conv.type !== 'ai') throw err.notFound('AI 会话不存在')
  if (conv.ai_owner_user_id !== userId) throw err.forbidden('无权访问该 AI 会话')
}

/* --------------------------- 服务端生成模式 --------------------------- */

export interface ServerGenerationInput {
  conversationId: string
  userId: string
  content: string
  clientNonce: string
  providerId?: string
}

export interface ServerGenerationResult {
  generationId: string
  segments: number
}

/**
 * 密钥托管在服务端时由服务端调用上游。
 * 开了流式或自动分段时走 SSE 流式上游：逐字推送 ai.delta，
 * 分段切好一段就落库一条，客户端靠 message.created 实时看到每一段；
 * 两个开关都关时保持旧行为，拿到完整回复后延迟逐条落库。
 */
export async function generateOnServer(
  db: DB,
  input: ServerGenerationInput,
): Promise<ServerGenerationResult> {
  assertOwned(db, input.userId, input.conversationId)

  const conversation = conversationsRepo.findById(db, input.conversationId)
  if (!conversation || conversation.type !== 'ai') throw err.notFound('AI 会话不存在')

  // 老版本建出来的会话可能没有 ai_sessions 行，这里补建而不是直接报错
  let session = aiRepo.findSession(db, input.conversationId)
  const personaId = session?.persona_id ?? conversation.ai_persona_id
  if (!personaId) throw err.notFound('角色不存在')

  const persona = aiRepo.findPersona(db, personaId)
  if (!persona) throw err.notFound('角色不存在')

  const providerId =
    input.providerId ??
    session?.provider_id ??
    persona.provider_id ??
    aiRepo.defaultProvider(db, input.userId)?.id
  if (!providerId) throw err.validation('请先配置 AI 服务商')

  const provider = aiRepo.findProvider(db, providerId)
  if (!provider) throw err.notFound('服务商不存在')

  if (!session) {
    withTx(db, () =>
      aiRepo.createSession(db, {
        conversationId: input.conversationId,
        personaId,
        providerId,
      }),
    )
    session = aiRepo.findSession(db, input.conversationId)
  }
  if (provider.key_location !== 'server') {
    throw err.validation('该服务商的密钥在本机，请使用桌面客户端生成')
  }
  const apiKey = resolveServerApiKey(provider)

  // 先落用户消息，保证即使上游失败用户输入也不丢
  const userMessageId = appendUserMessage(
    db,
    input.conversationId,
    input.userId,
    input.content,
    input.clientNonce,
  )

  // 用户是在引用某条历史消息后发问时，把被引原文一并交给模型
  const userRow = messagesRepo.findById(db, userMessageId)
  const quotedRow = userRow?.reply_to_id ? messagesRepo.findById(db, userRow.reply_to_id) : null
  const quoted =
    quotedRow && quotedRow.conversation_id === input.conversationId && !quotedRow.deleted_at
      ? quotedRow.content.trim().slice(0, 400)
      : null

  // 当前输入由 buildChatMessages 统一追加一次，这里把它从 recent 里摘掉，
  // 否则模型会看到两遍同样的话（并发插入的 AI 消息也不影响这个判断）
  const recent = loadRecentMessages(db, input.conversationId, 61).filter(
    (message) => message.id !== userMessageId,
  ).slice(-60)
  const facts = aiRepo.listFacts(db, input.conversationId).map(aiRepo.mapFact)
  const summary = aiRepo.latestSummary(db, input.conversationId)
  const owner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(input.userId) as
    | { display_name: string }
    | undefined

  // 图片上下文：配了识图模型就先转文字描述，没配就转成 data URL 直传主模型
  const imageInput = await prepareImageInput(db, provider, apiKey, userRow, recent)

  // 角色日程：客户端打开会话时会确保已生成；这里只读，不阻塞回复
  const scheduleRow = scheduleRepo.findSchedule(
    db,
    persona.id,
    localDayKey(Date.now(), TZ_OFFSET_MIN),
  )

  // 连接器资料（网页搜索 / B 站视频 / 消息内链接正文）只进提示词，失败不影响回复
  const summaryModel = persona.model_override ?? provider.model
  const connector = await buildConnectorContext(db, input.userId, input.content, {
    onActionStart: (kind) => {
      emitAiConnectorStatus(db, { conversationId: input.conversationId, kind, phase: 'start' })
    },
    onActionDone: (action) => {
      emitAiConnectorStatus(db, {
        conversationId: input.conversationId,
        kind: action.kind,
        phase: 'done',
      })
    },
    summarize: async (prompt) => {
      const result = await callUpstream({
        baseUrl: provider.base_url,
        apiKey,
        model: summaryModel,
        temperature: 0.3,
        maxTokens: 900,
        messages: [{ role: 'user', content: prompt }],
        record: {
          db,
          ownerId: input.userId,
          conversationId: input.conversationId,
          personaId: persona.id,
          providerId: provider.id,
          kind: 'summary',
          refId: input.conversationId,
        },
      })
      return { text: result.content, model: summaryModel }
    },
  })

  const chatMessages = buildChatMessages({
    persona: aiRepo.mapPersona(persona),
    facts,
    summary,
    recent,
    userInput: input.content,
    userName: owner?.display_name ?? '用户',
    quoted,
    userImages: imageInput.userImages,
    includeImages: imageInput.includeImages,
    stickers: aiStickerOptions(db, input.userId),
    schedule: scheduleRow ? scheduleRepo.mapSchedule(scheduleRow) : null,
    scheduleNowMinutes: minutesOfDay(Date.now(), TZ_OFFSET_MIN),
    connectorContext: connector.context,
    connectorFetchContext: connector.fetchContext,
  })

  const settings = aiRepo.readGlobalSettings(db, input.userId)
  const rule: SegmentRule = {
    enabled: settings.segmentEnabled,
    pattern: settings.segmentPattern,
  }
  const model = persona.model_override ?? provider.model

  const generationId = aiRepo.createGeneration(db, {
    conversationId: input.conversationId,
    userId: input.userId,
    userMessageId: null,
    providerId: provider.id,
    personaId: persona.id,
    runLocation: 'server',
    model,
  })

  // 流式开关与自动分段任一开启就走流式上游：
  // 前者为了逐字打字气泡，后者为了「切好一段就立刻发出一段」
  if (!settings.streamEnabled && !settings.segmentEnabled) {
    let result: UpstreamResult
    try {
      result = await callUpstream({
        baseUrl: provider.base_url,
        apiKey,
        model,
        temperature: persona.temperature ?? provider.temperature,
        maxTokens: provider.max_tokens,
        messages: chatMessages,
        record: {
          db,
          ownerId: input.userId,
          conversationId: input.conversationId,
          personaId: persona.id,
          providerId: provider.id,
          kind: 'chat',
          refId: generationId,
        },
      })
    } catch (e) {
      aiRepo.finishGeneration(db, generationId, {
        status: 'error',
        error: e instanceof Error ? e.message : '上游失败',
      })
      throw e
    }
    const reply = result.content

    const segments = splitSegments(reply, rule)
    if (segments.length === 0) {
      aiRepo.finishGeneration(db, generationId, { status: 'done', messageIds: [] })
      emitAiDone(db, { generationId, conversationId: input.conversationId, messageIds: [], model })
      return { generationId, segments: 0 }
    }

    // 逐条延迟投递，模拟真人打字节奏；第一条立即发出
    let delay = 0
    const messageIds: string[] = []
    segments.forEach((segment, index) => {
      delay += index === 0 ? 0 : segmentDelay(segment)
      setTimeout(() => {
        try {
          const message = appendAiSegment(db, input.conversationId, {
            generationId,
            index,
            content: segment,
            model,
            totalSegments: segments.length,
            personaId: persona.id,
            connector: connector.actions,
          })
          messageIds.push(message.id)
          if (messageIds.length === segments.length) {
            aiRepo.finishGeneration(db, generationId, {
              status: 'done',
              messageIds,
              promptTokens: result.usage?.promptTokens ?? null,
              completionTokens: result.usage?.completionTokens ?? null,
            })
          }
        } catch (e) {
          aiRepo.finishGeneration(db, generationId, {
            status: 'error',
            error: e instanceof Error ? e.message : '落库失败',
          })
        }
      }, delay)
    })

    // 让客户端把「生成中」状态收掉；正文仍靠 message.created 逐条下发
    emitAiDone(db, { generationId, conversationId: input.conversationId, messageIds: [], model })
    return { generationId, segments: segments.length }
  }

  /* ----------------------- 流式模式：边生成边下发 ----------------------- */

  const messageIds: string[] = []
  let segIndex = 0
  let pending = ''

  // 逐字增量做节流：把上游的小片段攒 60ms 再推，避免 WS 被刷屏
  let pendingDelta = ''
  let deltaTimer: ReturnType<typeof setTimeout> | null = null
  const flushDelta = (): void => {
    if (!pendingDelta) return
    const text = pendingDelta
    pendingDelta = ''
    emitAiDelta(db, {
      generationId,
      conversationId: input.conversationId,
      index: segIndex,
      delta: text,
    })
  }
  const emitDelta = (delta: string): void => {
    pendingDelta += delta
    if (deltaTimer === null) {
      deltaTimer = setTimeout(() => {
        deltaTimer = null
        flushDelta()
      }, 60)
    }
  }

  const appendReady = (segments: string[]): void => {
    for (const segment of segments) {
      const message = appendAiSegment(db, input.conversationId, {
        generationId,
        index: segIndex,
        content: segment,
        model,
        personaId: persona.id,
        connector: connector.actions,
      })
      messageIds.push(message.id)
      segIndex += 1
    }
  }

  /** 切缓冲：能切就先清客户端气泡、发 ai.segment、再把正式段落落库下发 */
  const cutPending = (finished: boolean): void => {
    const { ready, rest } = cutStreamingSegments(pending, rule, finished)
    if (ready.length === 0) return
    pending = rest
    if (deltaTimer !== null) {
      clearTimeout(deltaTimer)
      deltaTimer = null
    }
    pendingDelta = ''
    for (let i = 0; i < ready.length; i++) {
      emitAiSegment(db, {
        generationId,
        conversationId: input.conversationId,
        index: segIndex + i,
        // 表情标记在落库时才拆成真正的表情消息，实时气泡里不能露出原始标记
        text: stripStickerMarkers(ready[i]!),
      })
    }
    appendReady(ready)
  }

  try {
    const { usage } = await callUpstreamStream({
      baseUrl: provider.base_url,
      apiKey,
      model,
      temperature: persona.temperature ?? provider.temperature,
      maxTokens: provider.max_tokens,
      messages: chatMessages,
      onDelta: (delta) => {
        pending += delta
        if (settings.streamEnabled) emitDelta(delta)
        cutPending(false)
      },
      record: {
        db,
        ownerId: input.userId,
        conversationId: input.conversationId,
        personaId: persona.id,
        providerId: provider.id,
        kind: 'chat',
        refId: generationId,
      },
    })
    cutPending(true)
    flushDelta()
    aiRepo.finishGeneration(db, generationId, {
      status: 'done',
      messageIds,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
    })
    emitAiDone(db, { generationId, conversationId: input.conversationId, messageIds, model })
  } catch (e) {
    const message = e instanceof Error ? e.message : '上游失败'
    aiRepo.finishGeneration(db, generationId, { status: 'error', error: message })
    emitAiError(db, {
      generationId,
      conversationId: input.conversationId,
      code: 'UPSTREAM_AI_ERROR',
      message,
    })
    throw e
  } finally {
    if (deltaTimer !== null) clearTimeout(deltaTimer)
  }

  return { generationId, segments: Math.max(messageIds.length, 1) }
}

function appendUserMessage(
  db: DB,
  conversationId: string,
  userId: string,
  content: string,
  clientNonce: string,
): string {
  const existing = messagesRepo.findByNonce(db, userId, clientNonce)
  if (existing) return existing.id

  /**
   * 兜底：客户端已经用另一个 nonce 把这句话发出来了（旧版本、并发重试等），
   * 再插一条就会在历史里出现两份。15 秒内同会话、同发送者、同内容视为同一条。
   * 正常客户端会先 findByNonce 命中，走不到这里。
   */
  const duplicate = db
    .prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND sender_id = ? AND sender_type = 'user'
         AND deleted_at IS NULL AND content = ? AND created_at >= ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(conversationId, userId, content, Date.now() - 15_000) as { id: string } | undefined
  if (duplicate) return duplicate.id

  const seq = conversationsRepo.nextSeq(db, conversationId)
  const ts = Date.now()
  const row = messagesRepo.insert(db, {
    conversationId,
    senderId: userId,
    senderType: 'user',
    type: 'text',
    content,
    meta: null,
    seq,
    clientNonce,
    createdAt: ts,
  })
  conversationsRepo.touchLastMessage(db, conversationId, row.id, ts)
  const message = messagesRepo.mapMessage(row)
  writeChange(db, {
    entity: 'message',
    entityId: row.id,
    op: 'upsert',
    conversationId,
    payload: message,
    actorId: userId,
  })
  emitMessageCreated(db, message, clientNonce)
  return row.id
}

function loadRecentMessages(db: DB, conversationId: string, limit: number): Message[] {
  const rows = messagesRepo.page(db, { conversationId, limit, before: null, after: null })
  return rows.reverse().map(messagesRepo.mapMessage)
}

/* ------------------------------- 图片识图 ------------------------------- */

const VISION_PROMPT =
  '请客观描述这张图片的内容：主体、场景、画面里的文字等关键信息。' +
  '不超过 120 字，这段描述会交给另一个无法看图的 AI 用于回复用户。' +
  '直接输出描述正文，不要任何开场白或解释。'

/** 把落盘的附件读成 base64 data URL，供识图模型或多模态主模型直接消费 */
function imageDataUrl(row: attachmentsRepo.AttachmentRow): string | null {
  try {
    const buffer = fs.readFileSync(path.join(dataDir(), 'files', row.storage_key))
    return `data:${row.mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/** 用识图模型描述一张图片；结果按 sha256 缓存，同图不重复调用上游 */
async function describeAttachment(
  db: DB,
  provider: aiRepo.ProviderRow,
  apiKey: string,
  attachmentId: string,
): Promise<string | null> {
  if (!provider.vision_model) return null
  const row = attachmentsRepo.findById(db, attachmentId)
  if (!row || !IMAGE_MIME.has(row.mime)) return null

  const cached = aiRepo.findImageDescription(db, row.sha256)
  if (cached) return cached

  const dataUrl = imageDataUrl(row)
  if (!dataUrl) return null

  const description = (
    await callUpstream({
      baseUrl: provider.base_url,
      apiKey,
      model: provider.vision_model,
      temperature: 0.2,
      maxTokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      record: {
        db,
        ownerId: provider.owner_id,
        providerId: provider.id,
        kind: 'vision',
        refId: attachmentId,
      },
    })
  )
    .content.trim()
    .slice(0, 1000)
  if (!description) return null

  aiRepo.saveImageDescription(db, row.sha256, description, provider.vision_model)
  return description
}

/** 把描述写回消息 meta 的 attachments，其他设备通过同步拿到同一份 */
function writeAttachmentDescriptions(
  db: DB,
  message: Message,
  descriptions: Record<string, string>,
): void {
  const attachments = message.meta?.attachments
  if (!attachments) return
  let changed = false
  for (const attachment of attachments) {
    const description = descriptions[attachment.id]
    if (description && attachment.description !== description) {
      attachment.description = description
      changed = true
    }
  }
  if (!changed) return
  db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(message.meta), message.id)
  writeChange(db, {
    entity: 'message',
    entityId: message.id,
    op: 'upsert',
    conversationId: message.conversationId,
    payload: message,
  })
}

function imageRefsOf(message: Message | null | undefined): string[] {
  return (message?.meta?.attachments ?? [])
    .filter((a) => a.kind === 'image')
    .map((a) => a.id)
}

/**
 * 组装本次输入的图片上下文。
 * 配了识图模型：当前与最近消息里的图片全部补齐描述（缓存命中不再调上游），
 * 描述以文字注记进入提示词；没配：把本次的图片转成 data URL 直传主模型。
 */
async function prepareImageInput(
  db: DB,
  provider: aiRepo.ProviderRow,
  apiKey: string,
  userRow: messagesRepo.MessageRow | null | undefined,
  recent: Message[],
): Promise<{ userImages: TurnImage[]; includeImages: boolean }> {
  const userMessage = userRow ? messagesRepo.mapMessage(userRow) : null

  if (provider.vision_model) {
    // 待识图的图片：当前消息优先，其次近窗历史里还没有描述的
    const pending = new Map<string, { message: Message; attachmentId: string }>()
    for (const message of [userMessage, ...recent]) {
      if (!message) continue
      for (const attachmentId of imageRefsOf(message)) {
        const ref = message.meta?.attachments?.find((a) => a.id === attachmentId)
        if (ref?.description?.trim()) continue
        pending.set(attachmentId, { message, attachmentId })
      }
    }
    for (const { message, attachmentId } of pending.values()) {
      const description = await describeAttachment(db, provider, apiKey, attachmentId).catch(
        () => null,
      )
      if (!description) continue
      const ref = message.meta?.attachments?.find((a) => a.id === attachmentId)
      if (ref) ref.description = description
      writeAttachmentDescriptions(db, message, { [attachmentId]: description })
    }

    const userImages = imageRefsOf(userMessage).map((attachmentId) => ({
      dataUrl: '',
      description:
        userMessage?.meta?.attachments?.find((a) => a.id === attachmentId)?.description ?? null,
    }))
    return { userImages, includeImages: false }
  }

  // 没配识图模型：本次图片转 data URL 直传，主模型不支持多模态时会自己报错
  const userImages: TurnImage[] = []
  for (const attachmentId of imageRefsOf(userMessage)) {
    const row = attachmentsRepo.findById(db, attachmentId)
    const dataUrl = row ? imageDataUrl(row) : null
    if (dataUrl) userImages.push({ dataUrl, description: null })
  }
  return { userImages, includeImages: true }
}

/** 本机识图完成后由客户端回写：落缓存 + 更新消息 meta */
export function saveImageDescriptionToMessage(
  db: DB,
  userId: string,
  input: { messageId: string; attachmentId: string; description: string; model?: string | null },
): void {
  const row = messagesRepo.findById(db, input.messageId)
  if (!row || row.deleted_at) throw err.notFound('消息不存在')
  if (row.sender_id !== userId) throw err.forbidden('只能补自己发出去的图片描述')

  const attachment = attachmentsRepo.findById(db, input.attachmentId)
  if (!attachment) throw err.notFound('附件不存在')

  aiRepo.saveImageDescription(db, attachment.sha256, input.description, input.model ?? null)

  const message = messagesRepo.mapMessage(row)
  writeAttachmentDescriptions(db, message, { [input.attachmentId]: input.description })
}

/* ---------------------------- 表情包情绪分析 ---------------------------- */

const STICKER_TAG_PROMPT =
  '这是聊天软件里的一张表情包。请给出 3~5 个描述它的情绪或使用场景的中文标签，' +
  '用逗号分隔（例如：开心,庆祝,可爱）。只输出标签，不要任何解释。'

/** 提示词里可用的表情清单：id + 情绪标签，来自「允许 AI 使用」的分组 */
export function aiStickerOptions(db: DB, ownerId: string): Array<{ id: string; tags: string[] }> {
  return stickersRepo.listAiStickers(db, ownerId).map((row) => ({ id: row.id, tags: row.keywords }))
}

/** "开心,庆祝、 可爱" 这类上游输出收敛成干净的标签数组 */
function parseStickerTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const piece of raw.split(/[，,、;；\s]+/)) {
    const tag = piece.trim().slice(0, 24)
    if (!tag) continue
    seen.add(tag)
    if (seen.size >= 5) break
  }
  return [...seen]
}

/**
 * 服务端识图分析一张表情包的情绪标签，结果合并进 keywords。
 * 只有密钥托管在服务端且配了识图模型的服务商可用；本机密钥由客户端自行分析后回传。
 */
export async function analyzeStickerOnServer(db: DB, userId: string, stickerId: string): Promise<string[]> {
  const sticker = stickersRepo.findSticker(db, stickerId)
  if (!sticker || !sticker.attachment_id) throw err.notFound('表情不存在')
  const pack = stickersRepo.findPack(db, sticker.pack_id)
  if (!pack || pack.owner_id !== userId) throw err.forbidden('无权操作该表情')

  const attachment = attachmentsRepo.findById(db, sticker.attachment_id)
  if (!attachment) throw err.notFound('表情文件不存在')

  const provider = aiRepo
    .listProviders(db, userId)
    .find((row) => row.vision_model && row.key_location === 'server' && row.api_key_enc)
  if (!provider) {
    throw err.validation('没有可用的识图模型：需要配置识图模型且密钥托管在服务端的服务商，或使用桌面客户端分析')
  }

  const dataUrl = imageDataUrl(attachment)
  if (!dataUrl) throw err.validation('表情文件读取失败')

  const raw = (
    await callUpstream({
      baseUrl: provider.base_url,
      apiKey: resolveServerApiKey(provider),
      model: provider.vision_model!,
      temperature: 0.2,
      maxTokens: 120,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: STICKER_TAG_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      record: {
        db,
        ownerId: userId,
        providerId: provider.id,
        kind: 'vision',
        refId: stickerId,
      },
    })
  )
    .content
    .trim()

  const tags = parseStickerTags(raw)
  if (tags.length === 0) throw err.upstreamAi('识图模型没有返回有效的情绪标签')

  const existing = sticker.keywords
    ? (JSON.parse(sticker.keywords) as unknown[]).filter((k): k is string => typeof k === 'string')
    : []
  const merged = [...new Set([...existing, ...tags])].slice(0, 10)
  stickersRepo.updateStickerKeywords(db, stickerId, merged)
  return merged
}

/** 上游返回的真实 token 用量；上游不给时字段为 null */
export interface UpstreamUsage {
  promptTokens: number | null
  completionTokens: number | null
  cachedTokens: number | null
}

export interface UpstreamResult {
  content: string
  usage: UpstreamUsage | null
}

/** 传入后这次调用的 usage 会写进 ai_usage_log，供调试模式聚合 */
export interface UpstreamRecordContext {
  db: DB
  ownerId: string
  conversationId?: string | null
  personaId?: string | null
  providerId?: string | null
  kind: AiUsageKind
  refId?: string | null
}

interface UpstreamUsagePayload {
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    cached_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown }
  } | null
}

function parseUpstreamUsage(payload: UpstreamUsagePayload): UpstreamUsage | null {
  const usage = payload.usage
  if (!usage) return null
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const promptTokens = num(usage.prompt_tokens)
  const completionTokens = num(usage.completion_tokens)
  const cachedTokens =
    num(usage.prompt_tokens_details?.cached_tokens) ?? num(usage.cached_tokens)
  if (promptTokens === null && completionTokens === null && cachedTokens === null) return null
  return { promptTokens, completionTokens, cachedTokens }
}

/** 解析出的 usage 落库；没有 usage 时什么都不写 */
function recordUpstreamUsage(
  context: UpstreamRecordContext,
  usage: UpstreamUsage | null,
  model: string,
): void {
  if (!usage) return
  debugRepo.insertUsage(context.db, {
    ownerId: context.ownerId,
    conversationId: context.conversationId ?? null,
    personaId: context.personaId ?? null,
    providerId: context.providerId ?? null,
    kind: context.kind,
    refId: context.refId ?? null,
    model,
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    cachedTokens: usage.cachedTokens ?? 0,
  })
}

/** 非流式调用一次 OpenAI 兼容端点。主动消息等场景也复用它。 */
export async function callUpstream(input: {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  messages: ChatMessage[]
  record?: UpstreamRecordContext
}): Promise<UpstreamResult> {
  const base = input.baseUrl.trimEnd().replace(/\/$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw err.upstreamAi(`上游返回 ${response.status}`, text.slice(0, 300))
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    } & UpstreamUsagePayload
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw err.upstreamAi('上游没有返回内容')

    const usage = parseUpstreamUsage(payload)
    if (input.record) recordUpstreamUsage(input.record, usage, input.model)
    return { content, usage }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw err.upstreamAi('上游请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 流式调用 OpenAI 兼容端点：解析 SSE，把每个增量交给 onDelta，
 * 同时返回完整回复与真实 usage。上游不支持流式时会在读到的内容里找不到增量，按失败处理。
 */
export async function callUpstreamStream(input: {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  messages: ChatMessage[]
  onDelta: (delta: string) => void
  record?: UpstreamRecordContext
}): Promise<UpstreamResult> {
  const base = input.baseUrl.trimEnd().replace(/\/$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

  const controller = new AbortController()
  // 空闲超时：每收到一段数据就重置，长回复不会被总时长掐断
  let timer: ReturnType<typeof setTimeout> | null = null
  const armIdleTimeout = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), 120000)
  }

  try {
    armIdleTimeout()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw err.upstreamAi(`上游返回 ${response.status}`, text.slice(0, 300))
    }

    // 上游不支持流式（忽略 stream 参数直接回 JSON）时退回一次性读取
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      } & UpstreamUsagePayload
      const content = payload.choices?.[0]?.message?.content
      if (!content) throw err.upstreamAi('上游没有返回内容')
      input.onDelta(content)
      const usage = parseUpstreamUsage(payload)
      if (input.record) recordUpstreamUsage(input.record, usage, input.model)
      return { content, usage }
    }

    if (!response.body) throw err.upstreamAi('上游没有返回流式内容')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''
    let full = ''
    let usage: UpstreamUsage | null = null

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      armIdleTimeout()
      sseBuffer += decoder.decode(value, { stream: true })

      let newlineAt = sseBuffer.indexOf('\n')
      while (newlineAt >= 0) {
        const line = sseBuffer.slice(0, newlineAt).trim()
        sseBuffer = sseBuffer.slice(newlineAt + 1)
        newlineAt = sseBuffer.indexOf('\n')

        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const payload = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>
          } & UpstreamUsagePayload
          // usage 通常在最后一个 chunk；出现就覆盖，拿到的永远是最新一份
          const parsedUsage = parseUpstreamUsage(payload)
          if (parsedUsage) usage = parsedUsage
          const piece = payload.choices?.[0]?.delta?.content
          if (piece) {
            full += piece
            input.onDelta(piece)
          }
        } catch {
          /* 忽略解析不了的行，上游偶尔会混入注释或心跳 */
        }
      }
    }

    if (!full.trim()) throw err.upstreamAi('上游没有返回内容')
    if (input.record) recordUpstreamUsage(input.record, usage, input.model)
    return { content: full, usage }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw err.upstreamAi('上游请求超时')
    throw e
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/* ----------------------------- 连接测试 ----------------------------- */
/** 用最小代价探一次上游：验证地址、密钥与模型名是否匹配 */
export async function testProvider(input: {
  baseUrl: string
  apiKey: string
  model: string
}): Promise<{ ok: boolean; sample: string }> {
  const base = input.baseUrl.trimEnd().replace(/\/$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: '说“连接成功”四个字' }],
        max_tokens: 32,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw err.upstreamAi(`上游返回 ${response.status}`, text.slice(0, 200))
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const sample = payload.choices?.[0]?.message?.content ?? ''
    return { ok: true, sample }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw err.upstreamAi('连接超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/* ----------------------------- 余额探测 ----------------------------- */

/** 探测成功的余额结果 */
export interface BalanceHit {
  amount: string
  currency: string
}

interface ExtractedBalance {
  amount: number
  currency: string
  /** 订阅接口只给总额度，需要再查 usage 才能算出剩余 */
  needsUsage?: boolean
}

/** 把各家余额接口的响应收敛成统一结构，认不出返回 null */
export function extractBalance(url: string, payload: unknown): ExtractedBalance | null {
  const obj = payload as Record<string, unknown>
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  // 硅基流动：{ data: { totalBalance, balance } }，单位 CNY
  if (url.includes('/user/info')) {
    const data = obj.data as Record<string, unknown> | undefined
    const total = num(data?.totalBalance) ?? num(data?.balance)
    return total === null ? null : { amount: total, currency: 'CNY' }
  }
  // Kimi / Moonshot：{ data: { available_balance } }，单位 CNY
  if (url.includes('/users/me/balance')) {
    const data = obj.data as Record<string, unknown> | undefined
    const available = num(data?.available_balance)
    return available === null ? null : { amount: available, currency: 'CNY' }
  }
  // DeepSeek：{ balance_infos: [{ currency, total_balance }] }
  if (url.includes('/user/balance')) {
    const infos = obj.balance_infos as Array<{ currency?: string; total_balance?: string }> | undefined
    const total = num(infos?.[0]?.total_balance)
    return total === null ? null : { amount: total, currency: infos?.[0]?.currency ?? 'CNY' }
  }
  // OpenRouter：{ data: { total_credits, total_usage } }，单位 USD
  if (url.endsWith('/credits')) {
    const data = obj.data as Record<string, unknown> | undefined
    const credits = num(data?.total_credits)
    const usage = num(data?.total_usage)
    if (credits === null || usage === null) return null
    return { amount: credits - usage, currency: 'USD' }
  }
  // one-api / new-api 中转站：hard_limit_usd 是总额度，剩余要减 usage；部分站点直接给 balance
  if (url.includes('/dashboard/billing/subscription')) {
    const direct = num(obj.balance)
    if (direct !== null) return { amount: direct, currency: 'USD' }
    const hardLimit = num(obj.hard_limit_usd)
    return hardLimit === null ? null : { amount: hardLimit, currency: 'USD', needsUsage: true }
  }
  return null
}

/** 单个候选接口的探测：非 2xx、非 JSON 或解析不出余额都视为不命中 */
async function probeCandidate(url: string, apiKey: string): Promise<BalanceHit | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        // 个别中转站会拦默认 UA，补一个常规值
        'user-agent': 'NenoChat/0.1',
      },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = (await response.json().catch(() => null)) as unknown
    if (!payload || typeof payload !== 'object') return null
    const hit = extractBalance(url, payload)
    if (!hit) return null

    if (hit.needsUsage) {
      const usageUrl = `${url.replace(/subscription$/, 'usage')}?start_date=${usageDate(100)}&end_date=${usageDate(-1)}`
      const usedCents = await fetchUsageCents(usageUrl, apiKey)
      if (usedCents === null) return null
      const remaining = hit.amount - usedCents / 100
      if (!Number.isFinite(remaining) || remaining < 0) return null
      return { amount: remaining.toFixed(2), currency: hit.currency }
    }
    return { amount: String(hit.amount), currency: hit.currency }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function usageDate(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/** one-api 的 usage 接口返回 total_usage（已用美分） */
async function fetchUsageCents(url: string, apiKey: string): Promise<number | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'user-agent': 'NenoChat/0.1' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = (await response.json().catch(() => null)) as { total_usage?: unknown } | null
    const cents = typeof payload?.total_usage === 'number' ? payload.total_usage : NaN
    return Number.isFinite(cents) ? cents : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 由服务商的 base_url 推导所有可能的余额接口，base 与站点根各试一遍 */
function balanceCandidateUrls(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, '')
  let origin = base
  try {
    origin = new URL(base).origin
  } catch {
    /* 地址解析失败就只试原地址 */
  }
  const urls: string[] = []
  for (const stem of [...new Set([base, origin])]) {
    urls.push(`${stem}/user/info`)
    urls.push(`${stem}/users/me/balance`)
    urls.push(`${stem}/user/balance`)
    urls.push(`${stem}/credits`)
    urls.push(`${stem}/dashboard/billing/subscription`)
  }
  return [...new Set(urls)]
}

/**
 * 并发探测所有候选余额接口，按候选顺序取第一个命中的结果。
 * 覆盖：硅基流动、Kimi/Moonshot、DeepSeek、OpenRouter、one-api/new-api 系中转站。
 */
export async function fetchProviderBalance(input: {
  baseUrl: string
  apiKey: string
}): Promise<BalanceHit | null> {
  const urls = balanceCandidateUrls(input.baseUrl)
  const results = await Promise.allSettled(urls.map((url) => probeCandidate(url, input.apiKey)))
  for (let i = 0; i < urls.length; i++) {
    const result = results[i]
    if (result?.status === 'fulfilled' && result.value) return result.value
  }
  return null
}

/** 刷新某个服务商的余额并缓存，返回更新后的服务商 */
export async function refreshProviderBalance(
  db: DB,
  ownerId: string,
  providerId: string,
  clientApiKey?: string,
): Promise<AiProvider> {
  const row = aiRepo.findProvider(db, providerId)
  if (!row || row.owner_id !== ownerId) throw err.notFound('服务商不存在')

  const apiKey =
    clientApiKey?.trim() ||
    (row.key_location === 'server' && row.api_key_enc ? resolveServerApiKey(row) : '')
  if (!apiKey) throw err.validation('没有可用密钥，本机密钥模式需要在请求里带上 API Key')

  const hit = await fetchProviderBalance({ baseUrl: row.base_url, apiKey })
  aiRepo.saveProviderBalance(db, providerId, hit)

  const updated = aiRepo.findProvider(db, providerId)
  if (!updated) throw err.notFound('服务商不存在')
  return toPublicProvider(updated)
}

/* ------------------------------- 调试模式 ------------------------------- */

/** 校验用户确实是该会话的成员，调试数据只给会话内的人看 */
function assertConversationMember(db: DB, userId: string, conversationId: string): void {
  const conversation = conversationsRepo.findById(db, conversationId)
  if (!conversation || conversation.deleted_at !== null) throw err.notFound('会话不存在')
  if (!membersRepo.findActive(db, conversationId, userId)) {
    throw err.forbidden('不在该会话中')
  }
}

/** 上下文窗口取最近一次调用用的服务商配置；没配置就当 null */
function resolveContextWindow(
  db: DB,
  conversationId: string,
  lastProviderId: string | null,
): number | null {
  const session = aiRepo.findSession(db, conversationId)
  const providerId = lastProviderId ?? session?.provider_id ?? null
  if (!providerId) return null
  const provider = aiRepo.findProvider(db, providerId)
  return provider?.context_window ?? null
}

/** 会话维度的调试汇总：用量聚合 + 上下文水位 + 压缩进度 */
export function debugSummary(db: DB, userId: string, conversationId: string): AiDebugSummary {
  assertConversationMember(db, userId, conversationId)

  // 聚合里带上最近的模型与窗口来源
  const lastUsage = db
    .prepare(
      'SELECT provider_id FROM ai_usage_log WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(conversationId) as { provider_id: string | null } | undefined

  const session = aiRepo.findSession(db, conversationId)
  return debugRepo.debugSummary(db, conversationId, {
    contextWindow: resolveContextWindow(db, conversationId, lastUsage?.provider_id ?? null),
    lastCompactedSeq: session?.last_compacted_seq ?? null,
    tokenEstimate: session?.token_estimate ?? null,
  })
}

/** 本机密钥代跑后客户端回传的真实 usage */
export function reportClientUsage(
  db: DB,
  userId: string,
  input: {
    conversationId?: string
    personaId?: string
    providerId?: string
    kind: AiUsageKind
    refId?: string
    model?: string
    promptTokens: number
    completionTokens: number
    cachedTokens?: number
  },
): void {
  if (input.conversationId) assertConversationMember(db, userId, input.conversationId)
  if (input.personaId) {
    const persona = aiRepo.findPersona(db, input.personaId)
    if (!persona || persona.owner_id !== userId) throw err.forbidden('无权使用该角色')
  }
  debugRepo.insertUsage(db, {
    ownerId: userId,
    conversationId: input.conversationId ?? null,
    personaId: input.personaId ?? null,
    providerId: input.providerId ?? null,
    kind: input.kind,
    refId: input.refId ?? null,
    model: input.model ?? null,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    cachedTokens: input.cachedTokens ?? 0,
  })
}

/** 按 refId 批量查最近一次 usage（消息内联调试条用） */
export function usageByRefs(
  db: DB,
  userId: string,
  refIds: string[],
): Record<string, AiUsageEntry> {
  return debugRepo.findUsageByRefs(db, refIds.slice(0, 200))
}

/** 会话最近的群聊决策记录 */
export function listGroupDecisions(
  db: DB,
  userId: string,
  conversationId: string,
  limit: number,
): AiGroupDecision[] {
  assertConversationMember(db, userId, conversationId)
  return debugRepo.listDecisions(db, conversationId, Math.min(Math.max(limit, 1), 500))
}
