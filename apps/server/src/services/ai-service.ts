import {
  ContactRelation,
  ConversationType,
  Role,
  MEMORY_COMPACT,
  RELATIONSHIP_STAGE_LABELS,
  RelationshipStage,
  buildChatMessages,
  buildCompactionPrompt,
  cutStreamingSegments,
  estimateTokens,
  extractStickerMarker,
  segmentDelay,
  splitSegments,
  stripStickerMarkers,
  stripVoiceMarkers,
  renderVoiceBlock,
  type AiMemoryFact,
  type AiMemorySummary,
  type AiDebugSummary,
  type AiGroupDecision,
  type AiPersona,
  type AiProvider,
  type AiProviderModel,
  type AiUsageEntry,
  type AiUsageKind,
  type AiUsageStats,
  type AiUsageWindow,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolDef,
  type ConnectorActionMeta,
  type Conversation,
  type AttachmentRef,
  type Message,
  type MessageMeta,
  type PersonaRelationship,
  type ReplyStyle,
  type SegmentRule,
  type SenderType,
  type TurnImage,
} from '@nenochat/shared'
import fs from 'node:fs'
import path from 'node:path'
import { all, dataDir, one, run, type DB } from '../db'
import { withTx } from '../db/tx'
import { allowPrivateAiEndpoint } from '../env'
import { assertPublicUrl } from '../util/ssrf'
import * as aiRepo from '../db/repo/ai'
import * as attachmentsRepo from '../db/repo/attachments'
import * as contactsRepo from '../db/repo/contacts'
import * as conversationsRepo from '../db/repo/conversations'
import * as debugRepo from '../db/repo/debug'
import * as membersRepo from '../db/repo/members'
import * as messagesRepo from '../db/repo/messages'
import * as scheduleRepo from '../db/repo/schedule'
import * as stickersRepo from '../db/repo/stickers'
import * as billing from './ai-billing-service'
import { localDayKey, minutesOfDay, serverTzOffsetMinutes } from './proactive-rules'
import { buildConnectorContext } from './connector-context'
import * as connectorService from './connector-service'
import * as mcpService from './mcp-service'
import * as skillsRepo from '../db/repo/skills'
import * as skillService from './skill-service'
import * as usersRepo from '../db/repo/users'
import { IMAGE_MIME } from './file-service'
import { writeChange } from './change-log'
import { AppError, err } from '../util/errors'
import { decryptSecret, encryptSecret, maskSecret } from '../util/crypto'
import { appendSystemMessage } from './message-service'
import * as voiceService from './voice-service'
import {
  emitAiConnectorStatus,
  emitAiToolStatus,
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
      // 解密失败说明 SECRET_KEY 与加密时不一致，回显成"未配置"引导用户重填，而不是伪装成已配置
      masked = null
    }
  }
  return aiRepo.mapProvider(row, masked)
}

export async function listProviders(db: DB, ownerId: string): Promise<AiProvider[]> {
  const rows = await aiRepo.listProviders(db, ownerId)
  return rows.map(toPublicProvider)
}

export interface ProviderPayload {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
  visionModel?: string | null
  contextWindow?: number | null
  models?: AiProviderModel[] | null
}

/** 模型不在供应商 AI 列表里视为可用（兼容自由输入）；在列表里且停用则不可被任何 AI 功能选用 */
export function isModelEnabled(provider: aiRepo.ProviderRow, model: string): boolean {
  const entry = aiRepo.parseProviderModels(provider.models_json).find((m) => m.model === model)
  return !entry || entry.enabled
}

export async function createProvider(db: DB, ownerId: string, input: ProviderPayload): Promise<AiProvider> {
  const apiKeyEnc = input.apiKey ? encryptSecret(input.apiKey) : null

  const row = await withTx(db, async (tx) =>
    aiRepo.createProvider(tx, {
      ownerId,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKeyEnc,
      model: input.model,
      visionModel: input.visionModel,
      contextWindow: input.contextWindow,
      models: input.models,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      isDefault: input.isDefault,
    }),
  )
  return toPublicProvider(row)
}

export async function updateProvider(db: DB, ownerId: string, id: string, input: Partial<ProviderPayload>): Promise<AiProvider> {
  const current = await aiRepo.findProvider(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('服务商不存在')

  const apiKeyEnc =
    input.apiKey === undefined
      ? undefined
      : input.apiKey
        ? encryptSecret(input.apiKey)
        : null

  const row = await withTx(db, async (tx) =>
    aiRepo.updateProvider(tx, id, {
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      visionModel: input.visionModel,
      contextWindow: input.contextWindow,
      models: input.models,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      isDefault: input.isDefault,
      apiKeyEnc,
    }),
  )
  return toPublicProvider(row)
}

export async function deleteProvider(db: DB, ownerId: string, id: string): Promise<void> {
  const current = await aiRepo.findProvider(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('服务商不存在')
  await aiRepo.softDeleteProvider(db, id)
}

/** 取服务端托管密钥的明文；没配密钥时返回空串，兼容不需要密钥的本地端点 */
export function resolveServerApiKey(row: aiRepo.ProviderRow): string {
  if (!row.api_key_enc) return ''
  return decryptSecret(row.api_key_enc)
}

/* ------------------------------- 角色 ------------------------------- */

function toPublicPersona(row: aiRepo.PersonaRow): AiPersona {
  return aiRepo.mapPersona(row)
}

export async function listPersonas(db: DB, ownerId: string): Promise<AiPersona[]> {
  const rows = await aiRepo.listPersonas(db, ownerId)
  return rows.map(toPublicPersona)
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
  /** 该角色可用的表情包分组白名单；null / 空 = 跟随全局授权 */
  stickerPackIds?: string[] | null
  /** 与用户的关系；null = 清掉 */
  relationship?: PersonaRelationship | null
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
export async function ensureAiConversation(
  db: DB,
  input: { userId: string; persona: aiRepo.PersonaRow; providerId?: string | null; title?: string | null },
): Promise<{ conversationId: string; created: boolean; conversation: Conversation }> {
  const existing = await one<conversationsRepo.ConversationRow>(
    db,
    `SELECT * FROM conversations
       WHERE type = 'ai' AND ai_owner_user_id = ? AND ai_persona_id = ? AND deleted_at IS NULL
       ORDER BY created_at LIMIT 1`,
    [input.userId, input.persona.id],
  )

  if (existing) {
    return {
      conversationId: existing.id,
      created: false,
      conversation: conversationsRepo.mapConversation(existing),
    }
  }

  const row = await withTx(db, async (tx) => {
    const conv = await conversationsRepo.create(tx, {
      type: ConversationType.Ai,
      name: input.title ?? input.persona.name,
      avatarUrl: input.persona.avatar_url,
      ownerId: input.userId,
      aiPersonaId: input.persona.id,
      aiOwnerUserId: input.userId,
    })

    await membersRepo.upsert(tx, { conversationId: conv.id, userId: input.userId, role: Role.Owner })

    if (input.providerId) {
      await aiRepo.createSession(tx, {
        conversationId: conv.id,
        personaId: input.persona.id,
        providerId: input.providerId,
      })
    }

    await writeChange(tx, {
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

export async function createPersona(db: DB, ownerId: string, input: PersonaPayload): Promise<AiPersona> {
  const result = await withTx(db, async (tx) => {
    const created = await aiRepo.createPersona(tx, {
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
      stickerPackIds: input.stickerPackIds ?? null,
      relationship: input.relationship ?? null,
      proactive: input.proactive,
    })

    // 角色同时是一个「用户」：进群、加好友、通讯录都复用它
    const botId = `bot-${created.id}`
    const bot = await usersRepo.createBot(tx, {
      id: botId,
      displayName: created.name,
      avatarUrl: created.avatar_url,
    })
    await aiRepo.setPersonaUserId(tx, created.id, botId)
    const row = (await aiRepo.findPersona(tx, created.id)) ?? created

    // 通讯录里 AI 和真人一视同仁：建角色即成为好友
    if (row.in_contacts === 1) {
      const contact = await contactsRepo.upsert(tx, {
        ownerId,
        contactUserId: botId,
        relation: ContactRelation.Friend,
      })
      await writeChange(tx, {
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

    await writeChange(tx, {
      entity: 'ai_persona',
      entityId: row.id,
      op: 'upsert',
      userId: ownerId,
      payload: mapped,
      actorId: ownerId,
    })

    // 产品行为：建好角色就出现在「消息」与「通讯录」里，不用再点一次「聊天」
    const providerId = row.provider_id ?? (await aiRepo.defaultProvider(tx, ownerId))?.id ?? null
    const ensured = mapped.inContacts
      ? await ensureAiConversation(tx, { userId: ownerId, persona: row, providerId })
      : null

    return { row, mapped, ensured }
  })

  // 事务提交后再广播
  if (result.ensured) {
    const { conversation, conversationId, created } = result.ensured
    await emitConversationUpdated(db, conversation)
    if (created && result.row.greeting) {
      await appendAiSegment(db, conversationId, {
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
async function syncPersonaToConversations(db: DB, persona: aiRepo.PersonaRow): Promise<Conversation[]> {
  const rows = await all<conversationsRepo.ConversationRow>(
    db,
    `SELECT * FROM conversations WHERE type = 'ai' AND ai_persona_id = ? AND deleted_at IS NULL`,
    [persona.id],
  )

  const out: Conversation[] = []
  for (const row of rows) {
    const updated = await conversationsRepo.update(db, row.id, {
      name: persona.name,
      avatarUrl: persona.avatar_url,
    })
    const mapped = conversationsRepo.mapConversation(updated)
    await writeChange(db, {
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

export async function updatePersona(db: DB, ownerId: string, id: string, input: Partial<PersonaPayload>): Promise<AiPersona> {
  const current = await aiRepo.findPersona(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('角色不存在')

  const result = await withTx(db, async (tx) => {
    const row = await aiRepo.updatePersona(tx, id, input)
    const conversations = await syncPersonaToConversations(tx, row)

    // 群成员列表与通讯录都读 users 表，角色改名/换头像必须同步影子账号
    if (row.user_id) {
      await usersRepo.updateBotProfile(tx, row.user_id, {
        displayName: row.name,
        avatarUrl: row.avatar_url,
      })

      const existing = await contactsRepo.find(tx, ownerId, row.user_id)
      if (row.in_contacts === 1) {
        if (!existing) {
          const contact = await contactsRepo.upsert(tx, {
            ownerId,
            contactUserId: row.user_id,
            relation: ContactRelation.Friend,
          })
          const botUser = await usersRepo.findById(tx, row.user_id)
          await writeChange(tx, {
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
              user: botUser ? usersRepo.mapPublicUser(botUser) : null,
            },
            actorId: ownerId,
          })
        }
      } else if (existing) {
        await contactsRepo.removePair(tx, ownerId, row.user_id)
        await writeChange(tx, {
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
    let ensured: Awaited<ReturnType<typeof ensureAiConversation>> | null = null
    if (row.in_contacts === 1) {
      const providerId = row.provider_id ?? (await aiRepo.defaultProvider(tx, ownerId))?.id ?? null
      ensured = await ensureAiConversation(tx, { userId: ownerId, persona: row, providerId })
    }

    const mapped = aiRepo.mapPersona(row)
    await writeChange(tx, {
      entity: 'ai_persona',
      entityId: row.id,
      op: 'upsert',
      userId: ownerId,
      payload: mapped,
      actorId: ownerId,
    })

    return { mapped, conversations, ensured }
  })

  for (const conversation of result.conversations) await emitConversationUpdated(db, conversation)
  if (result.ensured?.created) await emitConversationUpdated(db, result.ensured.conversation)

  return result.mapped
}

export async function deletePersona(db: DB, ownerId: string, id: string): Promise<void> {
  const current = await aiRepo.findPersona(db, id)
  if (!current || current.owner_id !== ownerId) throw err.notFound('角色不存在')

  const result = await withTx(db, async (tx) => {
    await aiRepo.softDeletePersona(tx, id)

    const rows = await all<conversationsRepo.ConversationRow>(
      tx,
      `SELECT * FROM conversations WHERE type = 'ai' AND ai_persona_id = ? AND deleted_at IS NULL`,
      [id],
    )

    const out: Conversation[] = []
    for (const row of rows) {
      await conversationsRepo.softDelete(tx, row.id)
      const next = await conversationsRepo.findById(tx, row.id)
      if (!next) continue
      const mapped = conversationsRepo.mapConversation(next)
      await writeChange(tx, {
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
      await contactsRepo.removePair(tx, ownerId, botId)
      await writeChange(tx, {
        entity: 'contact',
        entityId: `${ownerId}:${botId}`,
        op: 'delete',
        userId: ownerId,
        payload: { ownerId, contactUserId: botId },
        actorId: ownerId,
      })
      await usersRepo.disableBot(tx, botId)

      const memberships = await all<{ conversation_id: string }>(
        tx,
        'SELECT conversation_id FROM conversation_members WHERE user_id = ? AND left_at IS NULL',
        [botId],
      )
      for (const membership of memberships) {
        await membersRepo.markLeft(tx, membership.conversation_id, botId)
        await writeChange(tx, {
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

    await writeChange(tx, {
      entity: 'ai_persona',
      entityId: id,
      op: 'delete',
      userId: ownerId,
      payload: { id },
      actorId: ownerId,
    })
    return { conversations: out, leftGroups, botId }
  })

  for (const conversation of result.conversations) await emitConversationUpdated(db, conversation)
  if (result.botId) {
    for (const conversationId of result.leftGroups) {
      await emitMemberRemoved(db, conversationId, result.botId, [])
    }
  }
}

/**
 * 打开与某个角色的会话：同一角色已有会话时复用，
 * 避免每点一次「聊天」就多出一个空会话。
 */
export async function openConversation(
  db: DB,
  userId: string,
  input: { personaId: string; providerId?: string; title?: string },
): Promise<Conversation> {
  const persona = await aiRepo.findPersona(db, input.personaId)
  if (!persona || persona.owner_id !== userId) throw err.notFound('角色不存在')

  const providerId =
    input.providerId ?? persona.provider_id ?? (await aiRepo.defaultProviderWithShared(db, userId))?.id
  if (!providerId) throw err.validation('请先配置 AI 服务商')

  const provider = await aiRepo.findProvider(db, providerId)
  // 共享模式回退到服务器供应商时 owner 是影子账号，放行；其余必须是自己名下的
  if (!provider || (provider.owner_id !== userId && provider.owner_id !== aiRepo.SYSTEM_AI_OWNER_ID)) {
    throw err.notFound('服务商不存在')
  }

  const ensured = await ensureAiConversation(db, {
    userId,
    persona,
    providerId,
    title: input.title ?? null,
  })

  // 复用已有会话时：服务商可能被换过，或之前没有服务商所以还没建 session
  if (!ensured.created) {
    await withTx(db, async (tx) => {
      const session = await aiRepo.findSession(tx, ensured.conversationId)
      if (!session) {
        await aiRepo.createSession(tx, {
          conversationId: ensured.conversationId,
          personaId: persona.id,
          providerId,
        })
      } else if (session.provider_id !== providerId) {
        await run(
          tx,
          'UPDATE ai_sessions SET provider_id = ?, updated_at = ? WHERE conversation_id = ?',
          [providerId, Date.now(), ensured.conversationId],
        )
      }
    })
  }

  if (ensured.created && persona.greeting) {
    await appendAiSegment(db, ensured.conversationId, {
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
export async function appendStickerMessage(
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
): Promise<Message | null> {
  const sticker = await stickersRepo.findSticker(db, input.stickerId)
  if (!sticker || !sticker.attachment_id) return null
  const attachment = await attachmentsRepo.findById(db, sticker.attachment_id)
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
 * 带 [[voice]] 标记或语音连接器概率命中时，整条分段转成语音消息。
 */
export async function appendAiSegment(
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
): Promise<Message> {
  const conv = await conversationsRepo.findById(db, conversationId)
  if (!conv || conv.type !== 'ai') throw err.notFound('AI 会话不存在')

  // 幂等：greeting 与主动消息在某些并发路径下可能被调两次
  if (input.clientNonce) {
    const dup = await messagesRepo.findByNonceInConversation(db, conversationId, input.clientNonce)
    if (dup) return messagesRepo.mapMessage(dup)
  }

  const session = await aiRepo.findSession(db, conversationId)
  const personaId = input.personaId ?? session?.persona_id ?? conv.ai_persona_id ?? undefined
  const ownerId = conv.ai_owner_user_id ?? null

  // 表情标记解析：按角色的表情包授权取有效编号（没授权任何表情包时按普通文字处理）
  const personaRow = personaId ? await aiRepo.findPersona(db, personaId) : undefined
  const enabledIds = ownerId
    ? personaRow
      ? await aiEnabledStickerIds(db, personaRow)
      : new Set((await stickersRepo.listAiStickers(db, ownerId)).map((row) => row.id))
    : new Set<string>()
  const marker = enabledIds.size > 0 ? extractStickerMarker(input.content, enabledIds) : null

  // 语音：[[voice]] 标记（工具模式）或连接器概率命中时整条分段转语音；
  // 与表情标记同段出现时表情优先，语音只吃纯文字分段，合成失败降级为文字。
  const voicePlan =
    ownerId && !marker?.stickerId
      ? await voiceService.planVoiceSegment(db, ownerId, input.content)
      : null
  const text =
    voicePlan && (voicePlan.voice || voicePlan.marked)
      ? voicePlan.text
      : marker?.stickerId
        ? marker.text
        : input.content

  if (voicePlan?.voice && voicePlan.text && ownerId) {
    const voiceMessage = await voiceService.appendVoiceMessage(db, {
      conversationId,
      ownerId,
      text: voicePlan.text,
      generationId: input.generationId,
      index: input.index,
      personaId,
      model: input.model,
      totalSegments: input.totalSegments,
      proactive: input.proactive,
      connector: input.connector,
      clientNonce: input.clientNonce ?? null,
    })
    if (voiceMessage) {
      if (session) {
        await aiRepo.bumpSessionProgress(db, conversationId, 1, estimateTokens(voicePlan.text))
      }
      return voiceMessage
    }
  }

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

  const appendText = async (content: string, index: number, clientNonce?: string | null): Promise<Message> =>
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
    const sticker = await appendStickerMessage(db, stickerPayload(input.index, input.clientNonce ? `${input.clientNonce}-s` : null))
    const textIndex = sticker ? input.index + 1 : input.index
    first = sticker ?? (await appendText(text, input.index))
    if (text.trim()) await appendText(text, textIndex)
  } else if (marker?.stickerId) {
    const textMessage = text.trim() ? await appendText(text, input.index) : null
    const sticker = await appendStickerMessage(
      db,
      stickerPayload(textMessage ? input.index + 1 : input.index, input.clientNonce ? `${input.clientNonce}-s` : null),
    )
    // 文字与表情都没落成时退回原文，宁可显示标记也不能丢整条回复
    first = textMessage ?? sticker ?? (await appendText(input.content, input.index))
  } else {
    first = await appendText(text, input.index)
  }

  if (session) {
    await aiRepo.bumpSessionProgress(db, conversationId, 1, estimateTokens(text))
  }
  return first
}

/* ------------------------------- 记忆 ------------------------------- */

export async function listMemory(
  db: DB,
  userId: string,
  conversationId: string,
): Promise<{ summaries: AiMemorySummary[]; facts: AiMemoryFact[] }> {
  await assertOwned(db, userId, conversationId)
  return {
    summaries: await aiRepo.listSummaries(db, conversationId),
    facts: (await aiRepo.listFacts(db, conversationId)).map(aiRepo.mapFact),
  }
}

export async function deleteFact(db: DB, userId: string, conversationId: string, factId: string): Promise<void> {
  await assertOwned(db, userId, conversationId)
  await withTx(db, async (tx) => aiRepo.rejectFact(tx, conversationId, factId))
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
export async function writeMemory(db: DB, userId: string, conversationId: string, payload: MemoryWritePayload): Promise<void> {
  await assertOwned(db, userId, conversationId)

  await withTx(db, async (tx) => {
    if (payload.summary) {
      await aiRepo.insertSummary(tx, {
        conversationId,
        fromSeq: payload.summary.fromSeq,
        toSeq: payload.summary.toSeq,
        summary: payload.summary.text,
        tokenEstimate: estimateTokens(payload.summary.text),
        model: payload.summary.model ?? null,
      })
      await aiRepo.markCompacted(tx, conversationId, payload.summary.toSeq)
    }

    for (const fact of payload.facts ?? []) {
      await aiRepo.upsertFact(tx, {
        conversationId,
        subject: fact.subject,
        key: fact.key,
        value: fact.value,
        confidence: fact.confidence ?? 0.7,
      })
    }
  })
}

/**
 * 生成结束后的服务端记忆压缩：未压缩的 AI 发言攒够阈值，就把旧对话压成
 * 摘要 + 事实落库（滚动链与覆盖链都走 writeMemory）；关系系统开着时顺带
 * 让模型更新与用户的关系并写回角色。整个函数自吞错误，失败等下次生成再试。
 */
async function compactMemoryAfterGeneration(
  db: DB,
  input: {
    conversationId: string
    userId: string
    persona: aiRepo.PersonaRow
    provider: aiRepo.ProviderRow
    userName: string
  },
): Promise<void> {
  try {
    const session = await aiRepo.findSession(db, input.conversationId)
    if (!session || session.messages_since_compact < MEMORY_COMPACT.messagesSinceCompact) return

    const summaries = await aiRepo.listSummaries(db, input.conversationId)
    const lastCompactedSeq = summaries.reduce((max, s) => Math.max(max, s.toSeq), 0)
    const pendingRows = await all<{ seq: number; sender_type: string; content: string }>(
      db,
      `SELECT seq, sender_type, content FROM messages
         WHERE conversation_id = ? AND seq > ? AND deleted_at IS NULL
         ORDER BY seq ASC LIMIT ?`,
      [input.conversationId, lastCompactedSeq, MEMORY_COMPACT.batchMessages],
    )
    if (pendingRows.length < MEMORY_COMPACT.messagesSinceCompact) return

    const personaEntity = aiRepo.mapPersona(input.persona)
    const settings = await aiRepo.readGlobalSettings(db, input.userId)
    const model = input.persona.model_override ?? input.provider.model

    const prompt = buildCompactionPrompt({
      previousSummary: summaries[0]?.summary ?? null,
      transcript: pendingRows
        .map((row) => `${row.sender_type === 'ai' ? personaEntity.name : input.userName}：${row.content}`)
        .join('\n'),
      // 关系系统关闭时不传，提示词里就不出现关系更新要求
      currentRelationship: settings.relationshipEnabled ? personaEntity.relationship ?? null : undefined,
    })

    const result = await callUpstream({
      baseUrl: input.provider.base_url,
      apiKey: resolveServerApiKey(input.provider),
      model,
      temperature: 0.2,
      maxTokens: 900,
      messages: prompt,
      record: {
        db,
        ownerId: input.userId,
        conversationId: input.conversationId,
        personaId: input.persona.id,
        providerId: input.provider.id,
        kind: 'summary',
        refId: input.conversationId,
      },
    })

    const parsed = JSON.parse(result.content) as {
      summary?: string
      facts?: Array<{ subject?: string; key?: string; value?: string; confidence?: number }>
      relationship?: { stage?: string; description?: string }
    }

    const lastMessage = pendingRows[pendingRows.length - 1]!
    await writeMemory(db, input.userId, input.conversationId, {
      summary: parsed.summary?.trim()
        ? {
            fromSeq: lastCompactedSeq,
            toSeq: lastMessage.seq,
            text: parsed.summary.trim(),
            model,
          }
        : undefined,
      facts: (parsed.facts ?? [])
        .filter((fact) => Boolean(fact.key?.trim() && fact.value?.trim()))
        .map((fact) => ({
          subject: (['user', 'persona', 'relation', 'world'].includes(fact.subject ?? '')
            ? fact.subject
            : 'user') as 'user' | 'persona' | 'relation' | 'world',
          key: fact.key!.trim(),
          value: fact.value!.trim(),
          confidence: fact.confidence,
        })),
    })

    // 关系写回角色：只有阶段或描述真的变了才动库，免得每轮都发 persona 变更事件
    if (settings.relationshipEnabled && parsed.relationship?.description?.trim()) {
      const stage = (parsed.relationship.stage ?? '') in RELATIONSHIP_STAGE_LABELS
        ? (parsed.relationship.stage as RelationshipStage)
        : RelationshipStage.Stranger
      const next: PersonaRelationship = {
        stage,
        description: parsed.relationship.description.trim().slice(0, 500),
      }
      const current = personaEntity.relationship
      if (current?.stage !== next.stage || current?.description !== next.description) {
        await updatePersona(db, input.userId, input.persona.id, { relationship: next })
      }
    }
  } catch {
    /* 压缩失败不影响主流程，下次对话继续尝试 */
  }
}

async function assertOwned(db: DB, userId: string, conversationId: string): Promise<void> {
  const conv = await conversationsRepo.findById(db, conversationId)
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

/* 同一会话的生成互斥：两个并发请求会各自跑一整轮上游，分段 setTimeout 交错了 seq 就乱了 */
const generationQueues = new Map<string, Promise<unknown>>()

/**
 * 后到的排队等前一个落地（成败都算），链排空了就删掉，免得 Map 无限膨胀。
 * 只在 generateOnServer 顶层入队，任务内部绝不再对同一 key 入队，不会死锁。
 */
function enqueueGeneration<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const previous = generationQueues.get(conversationId) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  generationQueues.set(conversationId, settled)
  void settled.then(() => {
    if (generationQueues.get(conversationId) === settled) generationQueues.delete(conversationId)
  })
  return run
}

/**
 * 密钥托管在服务端时由服务端调用上游。
 * 开了流式或自动分段时走 SSE 流式上游：逐字推送 ai.delta，
 * 分段切好一段就落库一条，客户端靠 message.created 实时看到每一段；
 * 两个开关都关时保持旧行为，拿到完整回复后延迟逐条落库。
 */
export function generateOnServer(
  db: DB,
  input: ServerGenerationInput,
): Promise<ServerGenerationResult> {
  // 同一会话串行生成：请求先排队，前一轮跑完（成败都算）才轮到下一轮
  return enqueueGeneration(input.conversationId, () => runGenerationOnServer(db, input))
}

async function runGenerationOnServer(
  db: DB,
  input: ServerGenerationInput,
): Promise<ServerGenerationResult> {
  await assertOwned(db, input.userId, input.conversationId)

  const conversation = await conversationsRepo.findById(db, input.conversationId)
  if (!conversation || conversation.type !== 'ai') throw err.notFound('AI 会话不存在')

  // 老版本建出来的会话可能没有 ai_sessions 行，这里补建而不是直接报错
  let session = await aiRepo.findSession(db, input.conversationId)
  const personaId = session?.persona_id ?? conversation.ai_persona_id
  if (!personaId) throw err.notFound('角色不存在')

  const persona = await aiRepo.findPersona(db, personaId)
  if (!persona) throw err.notFound('角色不存在')

  const providerId =
    input.providerId ??
    session?.provider_id ??
    persona.provider_id ??
    (await aiRepo.defaultProviderWithShared(db, input.userId))?.id
  if (!providerId) throw err.validation('请先配置 AI 服务商')

  const provider = await aiRepo.findProvider(db, providerId)
  if (!provider) throw err.notFound('服务商不存在')

  // 关闭的模型不可被选用：角色指定的模型或供应商主模型被停用时直接拒绝这轮回复
  const requestedModel = persona.model_override ?? provider.model
  if (!isModelEnabled(provider, requestedModel)) {
    throw err.validation(`模型 ${requestedModel} 已在 AI 设置里停用，请改用其它模型`)
  }

  if (!session) {
    await withTx(db, async (tx) =>
      aiRepo.createSession(tx, {
        conversationId: input.conversationId,
        personaId,
        providerId,
      }),
    )
    session = await aiRepo.findSession(db, input.conversationId)
  }
  const apiKey = resolveServerApiKey(provider)

  // 先落用户消息，保证即使上游失败用户输入也不丢
  const userMessageId = await appendUserMessage(
    db,
    input.conversationId,
    input.userId,
    input.content,
    input.clientNonce,
  )

  // 用户是在引用某条历史消息后发问时，把被引原文一并交给模型
  const userRow = await messagesRepo.findById(db, userMessageId)
  const quotedRow = userRow?.reply_to_id ? await messagesRepo.findById(db, userRow.reply_to_id) : null
  const quoted =
    quotedRow && quotedRow.conversation_id === input.conversationId && !quotedRow.deleted_at
      ? quotedRow.content.trim().slice(0, 400)
      : null

  // 当前输入由 buildChatMessages 统一追加一次，这里把它从 recent 里摘掉，
  // 否则模型会看到两遍同样的话（并发插入的 AI 消息也不影响这个判断）
  // 语音消息在历史里按占位注入：有转写（content）直接用，还没有转写时标注为语音
  const recent = (await loadRecentMessages(db, input.conversationId, 61)).filter(
    (message) => message.id !== userMessageId,
  ).slice(-60).map((message) =>
    message.type === 'voice' && !message.content.trim()
      ? { ...message, content: '[语音]（暂无转写）' }
      : message,
  )
  const facts = (await aiRepo.listFacts(db, input.conversationId)).map(aiRepo.mapFact)
  const summary = await aiRepo.latestSummary(db, input.conversationId)
  const owner = await one<{ display_name: string }>(
    db,
    'SELECT display_name FROM users WHERE id = ?',
    [input.userId],
  )

  // 图片上下文：配了识图模型就先转文字描述，没配就转成 data URL 直传主模型
  const imageInput = await prepareImageInput(db, provider, apiKey, userRow, recent)

  // 角色日程：客户端打开会话时会确保已生成；这里只读，不阻塞回复
  const scheduleRow = await scheduleRepo.findSchedule(
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

  // 全局设置提前读：关系开关要参与 prompt 组装，分段/流式规则在后面用
  const settings = await aiRepo.readGlobalSettings(db, input.userId)

  const chatMessages = buildChatMessages({
    persona: aiRepo.mapPersona(persona),
    facts,
    summary,
    recent,
    // 用户发的是语音时，输入用转写文本；ASR 还没接入时给占位说明，模型不至于对着空输入胡编
    userInput:
      userRow?.type === 'voice'
        ? input.content.trim() || '[语音]（暂无转写，用户刚发来一条语音消息）'
        : input.content,
    userName: owner?.display_name ?? '用户',
    quoted,
    userImages: imageInput.userImages,
    includeImages: imageInput.includeImages,
    stickers: await aiStickerOptionsForPersona(db, persona),
    schedule: scheduleRow ? scheduleRepo.mapSchedule(scheduleRow) : null,
    scheduleNowMinutes: minutesOfDay(Date.now(), TZ_OFFSET_MIN),
    connectorContext: connector.context,
    connectorFetchContext: connector.fetchContext,
    relationshipEnabled: settings.relationshipEnabled,
  })

  // 语音工具模式：连接器开启时把 [[voice]] 协议追加进系统提示词（概率模式无需提示词）
  const voiceRow = await connectorService.enabledConnectorOfType(db, input.userId, 'mimo_tts')
  if (voiceRow) {
    let voiceTool = false
    try {
      voiceTool =
        (JSON.parse(voiceRow.config || '{}') as { voiceTool?: unknown }).voiceTool === true
    } catch {
      voiceTool = false
    }
    if (voiceTool) chatMessages.push({ role: 'system', content: renderVoiceBlock() })
  }

  /* ----------------- MCP 工具与技能目录（function calling） ----------------- */

  // MCP 工具集：逐服务器连接列工具，失败的服务器静默跳过
  const mcpToolset = await mcpService.buildToolset(db, input.userId)
  // 技能目录只注入名字+描述，正文留给 read_skill 按需读取
  const enabledSkills = await skillsRepo.listEnabledSkills(db, input.userId)
  if (enabledSkills.length > 0) {
    chatMessages.push({ role: 'system', content: skillService.renderSkillCatalog(enabledSkills) })
  }
  const genTools: ChatToolDef[] = [...mcpToolset.tools]
  if (enabledSkills.length > 0) genTools.push(skillService.READ_SKILL_TOOL_DEF)

  // 内置 read_skill 与 MCP 工具统一走这一个执行入口
  const executeTool = async (name: string, argsJson: string): Promise<string> => {
    if (name === skillService.READ_SKILL_TOOL_DEF.function.name) {
      let wanted = ''
      try {
        wanted = String((JSON.parse(argsJson || '{}') as { name?: unknown }).name ?? '')
      } catch {
        /* 参数不合法时保持空串，走未找到分支 */
      }
      const content = await skillService.resolveSkillContent(db, input.userId, wanted)
      return content ?? `没有找到名为「${wanted.trim() || '（空）'}」的技能，可用技能以系统提示词目录为准`
    }
    return mcpToolset.call(name, argsJson)
  }
  const onToolStatus = (tool: string, phase: 'start' | 'done'): void => {
    // 推给客户端的是展示名：read_skill 用中文，MCP 工具用服务器上的原始名
    const label =
      tool === skillService.READ_SKILL_TOOL_DEF.function.name ? '读取技能' : mcpToolset.labelOf(tool)
    void emitAiToolStatus(db, { conversationId: input.conversationId, tool: label, phase }).catch(() => {})
  }

  const rule: SegmentRule = {
    enabled: settings.segmentEnabled,
    pattern: settings.segmentPattern,
  }
  const model = persona.model_override ?? provider.model

  const generationId = await aiRepo.createGeneration(db, {
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
      result = await runToolLoop({
        baseUrl: provider.base_url,
        apiKey,
        model,
        temperature: persona.temperature ?? provider.temperature,
        maxTokens: provider.max_tokens,
        messages: chatMessages,
        tools: genTools,
        executeTool,
        onToolStatus,
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
      await aiRepo.finishGeneration(db, generationId, {
        status: 'error',
        error: e instanceof Error ? e.message : '上游失败',
      })
      throw e
    }
    const reply = result.content

    const segments = splitSegments(reply, rule)
    if (segments.length === 0) {
      await aiRepo.finishGeneration(db, generationId, { status: 'done', messageIds: [] })
      await emitAiDone(db, { generationId, conversationId: input.conversationId, messageIds: [], model })
      return { generationId, segments: 0 }
    }

    // 逐条延迟投递，模拟真人打字节奏；第一条立即发出
    let delay = 0
    const deliveredIds: string[] = []
    let settled = false
    segments.forEach((segment, index) => {
      delay += index === 0 ? 0 : segmentDelay(segment)
      setTimeout(() => {
        void (async () => {
          try {
            const message = await appendAiSegment(db, input.conversationId, {
              generationId,
              index,
              content: segment,
              model,
              totalSegments: segments.length,
              personaId: persona.id,
              connector: connector.actions,
            })
            deliveredIds.push(message.id)
            // 每送出一段就把进度落库：终态还没到，进程挂了也不丢已送达的分段
            await aiRepo.trackGenerationMessages(db, generationId, deliveredIds)
            if (deliveredIds.length === segments.length) {
              await aiRepo.finishGeneration(db, generationId, {
                status: 'done',
                messageIds: deliveredIds,
                promptTokens: result.usage?.promptTokens ?? null,
                completionTokens: result.usage?.completionTokens ?? null,
              })
              // 全部段落都落库了才收「生成中」状态，正文仍靠 message.created 逐条下发
              await emitAiDone(db, {
                generationId,
                conversationId: input.conversationId,
                messageIds: deliveredIds,
                model,
              })
              // 全部段落落库后异步压缩记忆；失败不影响这轮回复
              void compactMemoryAfterGeneration(db, {
                conversationId: input.conversationId,
                userId: input.userId,
                persona,
                provider,
                userName: owner?.display_name ?? '用户',
              })
            }
          } catch (e) {
            // 单段落库失败：生成标记失败但保留已送达的分段 id，不让错误覆盖前面的消息
            if (!settled) {
              settled = true
              const message = e instanceof Error ? e.message : '落库失败'
              await aiRepo.finishGeneration(db, generationId, {
                status: 'error',
                error: message,
                messageIds: deliveredIds,
              })
              await emitAiError(db, {
                generationId,
                conversationId: input.conversationId,
                code: 'UPSTREAM_AI_ERROR',
                message,
              })
            }
          }
        })()
      }, delay)
    })

    return { generationId, segments: segments.length }
  }

  /* ----------------------- 流式模式：边生成边下发 ----------------------- */

  const messageIds: string[] = []
  let segIndex = 0
  let pending = ''

  // 落库按切出的顺序串行执行，切段只负责排程，结果统一在流结束后等待
  let appendChain: Promise<void> = Promise.resolve()
  let appendError: unknown = null

  // 逐字增量做节流：把上游的小片段攒 60ms 再推，避免 WS 被刷屏
  let pendingDelta = ''
  let deltaTimer: ReturnType<typeof setTimeout> | null = null
  const flushDelta = (): void => {
    if (!pendingDelta) return
    const text = pendingDelta
    pendingDelta = ''
    void (async () => {
      await emitAiDelta(db, {
        generationId,
        conversationId: input.conversationId,
        index: segIndex,
        delta: text,
      })
    })().catch(() => {})
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

  const appendReady = async (segments: string[], startIndex: number): Promise<void> => {
    for (let i = 0; i < segments.length; i++) {
      const message = await appendAiSegment(db, input.conversationId, {
        generationId,
        index: startIndex + i,
        content: segments[i]!,
        model,
        personaId: persona.id,
        connector: connector.actions,
      })
      messageIds.push(message.id)
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
    const startIndex = segIndex
    segIndex += ready.length
    for (let i = 0; i < ready.length; i++) {
      void (async () => {
        await emitAiSegment(db, {
          generationId,
          conversationId: input.conversationId,
          index: startIndex + i,
          // 表情与语音标记都在落库时才拆成真正的消息，实时气泡里不能露出原始标记
          text: stripVoiceMarkers(stripStickerMarkers(ready[i]!)),
        })
      })().catch(() => {})
    }
    appendChain = appendChain
      .then(() => appendReady(ready, startIndex))
      .catch((e) => {
        if (appendError === null) appendError = e
      })
  }

  try {
    const { usage } = await runToolLoop({
      baseUrl: provider.base_url,
      apiKey,
      model,
      temperature: persona.temperature ?? provider.temperature,
      maxTokens: provider.max_tokens,
      messages: chatMessages,
      tools: genTools,
      executeTool,
      onToolStatus,
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
    await appendChain
    if (appendError !== null) throw appendError
    await aiRepo.finishGeneration(db, generationId, {
      status: 'done',
      messageIds,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
    })
    await emitAiDone(db, { generationId, conversationId: input.conversationId, messageIds, model })
    // 全部段落落库后异步压缩记忆；失败不影响这轮回复
    void compactMemoryAfterGeneration(db, {
      conversationId: input.conversationId,
      userId: input.userId,
      persona,
      provider,
      userName: owner?.display_name ?? '用户',
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : '上游失败'
    await aiRepo.finishGeneration(db, generationId, { status: 'error', error: message })
    await emitAiError(db, {
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

async function appendUserMessage(
  db: DB,
  conversationId: string,
  userId: string,
  content: string,
  clientNonce: string,
): Promise<string> {
  const existing = await messagesRepo.findByNonce(db, userId, clientNonce)
  if (existing) return existing.id

  /**
   * 兜底：客户端已经用另一个 nonce 把这句话发出来了（旧版本、并发重试等），
   * 再插一条就会在历史里出现两份。15 秒内同会话、同发送者、同内容视为同一条。
   * 正常客户端会先 findByNonce 命中，走不到这里。
   */
  const duplicate = await one<{ id: string }>(
    db,
    `SELECT id FROM messages
       WHERE conversation_id = ? AND sender_id = ? AND sender_type = 'user'
         AND deleted_at IS NULL AND content = ? AND created_at >= ?
       ORDER BY seq DESC LIMIT 1`,
    [conversationId, userId, content, Date.now() - 15_000],
  )
  if (duplicate) return duplicate.id

  const seq = await conversationsRepo.nextSeq(db, conversationId)
  const ts = Date.now()
  const row = await messagesRepo.insert(db, {
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
  await conversationsRepo.touchLastMessage(db, conversationId, row.id, ts)
  const message = messagesRepo.mapMessage(row)
  await writeChange(db, {
    entity: 'message',
    entityId: row.id,
    op: 'upsert',
    conversationId,
    payload: message,
    actorId: userId,
  })
  await emitMessageCreated(db, message, clientNonce)
  return row.id
}

async function loadRecentMessages(db: DB, conversationId: string, limit: number): Promise<Message[]> {
  const rows = await messagesRepo.page(db, { conversationId, limit, before: null, after: null })
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
  const row = await attachmentsRepo.findById(db, attachmentId)
  if (!row || !IMAGE_MIME.has(row.mime)) return null

  const cached = await aiRepo.findImageDescription(db, row.sha256)
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

  await aiRepo.saveImageDescription(db, row.sha256, description, provider.vision_model)
  return description
}

/** 把描述写回消息 meta 的 attachments，其他设备通过同步拿到同一份 */
async function writeAttachmentDescriptions(
  db: DB,
  message: Message,
  descriptions: Record<string, string>,
): Promise<void> {
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
  await run(db, 'UPDATE messages SET meta = ? WHERE id = ?', [JSON.stringify(message.meta), message.id])
  await writeChange(db, {
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
      await writeAttachmentDescriptions(db, message, { [attachmentId]: description })
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
    const row = await attachmentsRepo.findById(db, attachmentId)
    const dataUrl = row ? imageDataUrl(row) : null
    if (dataUrl) userImages.push({ dataUrl, description: null })
  }
  return { userImages, includeImages: true }
}

/* ---------------------------- 表情包情绪分析 ---------------------------- */

const STICKER_TAG_PROMPT =
  '这是聊天软件里的一张表情包。请给出 3~5 个描述它的情绪或使用场景的中文标签，' +
  '用逗号分隔（例如：开心,庆祝,可爱）。只输出标签，不要任何解释。'

/**
 * 按角色取提示词里的表情清单：角色配了 stickerPackIds 白名单时只在白名单分组里挑，
 * 没配（null）则沿用全部授权分组。群聊与私聊的提示词共用这一个口径。
 */
export async function aiStickerOptionsForPersona(
  db: DB,
  persona: aiRepo.PersonaRow,
): Promise<Array<{ id: string; tags: string[] }>> {
  const packFilter = aiRepo.parseStickerPackIds(persona.sticker_pack_ids)
  const rows = await stickersRepo.listAiStickers(db, persona.owner_id, packFilter)
  return rows.map((row) => ({ id: row.id, tags: row.keywords }))
}

/** 落库校验用的有效表情 id 集合，口径与 aiStickerOptionsForPersona 一致 */
export async function aiEnabledStickerIds(db: DB, persona: aiRepo.PersonaRow): Promise<Set<string>> {
  const packFilter = aiRepo.parseStickerPackIds(persona.sticker_pack_ids)
  const rows = await stickersRepo.listAiStickers(db, persona.owner_id, packFilter)
  return new Set(rows.map((row) => row.id))
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
 * 需要服务商配了识图模型。
 */
export async function analyzeStickerOnServer(db: DB, userId: string, stickerId: string): Promise<string[]> {
  const sticker = await stickersRepo.findSticker(db, stickerId)
  if (!sticker || !sticker.attachment_id) throw err.notFound('表情不存在')
  const pack = await stickersRepo.findPack(db, sticker.pack_id)
  if (!pack || pack.owner_id !== userId) throw err.forbidden('无权操作该表情')

  const attachment = await attachmentsRepo.findById(db, sticker.attachment_id)
  if (!attachment) throw err.notFound('表情文件不存在')

  const provider =
    (await aiRepo.listProviders(db, userId)).find((row) => row.vision_model && row.api_key_enc) ??
    (await aiRepo.listSharedProvidersIfEnabled(db)).find((row) => row.vision_model && row.api_key_enc)
  if (!provider) {
    throw err.validation('没有可用的识图模型：请给服务商配置识图模型')
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
  await stickersRepo.updateStickerKeywords(db, stickerId, merged)
  return merged
}

/** 上游返回的真实 token 用量；上游不给时字段为 null */
export interface UpstreamUsage {
  promptTokens: number | null
  completionTokens: number | null
  cachedTokens: number | null
}

/**
 * 校验用户配置的 AI 上游地址，防止通过 baseUrl 打内网/云元数据。
 * 本地模型（ollama 等）需设置 ALLOW_PRIVATE_AI_ENDPOINT=true 才放行私网。
 */
async function assertAiUpstreamUrl(raw: string): Promise<void> {
  try {
    await assertPublicUrl(raw, { allowPrivate: allowPrivateAiEndpoint })
  } catch (e) {
    throw err.validation(e instanceof Error ? e.message : 'AI 上游地址不合法')
  }
}

export interface UpstreamResult {
  content: string
  usage: UpstreamUsage | null
  /** 上游要求执行的函数调用；空（含 undefined）表示这是最终回复 */
  toolCalls?: ChatToolCall[]
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
async function recordUpstreamUsage(
  context: UpstreamRecordContext,
  usage: UpstreamUsage | null,
  model: string,
): Promise<void> {
  if (!usage) return
  await debugRepo.insertUsage(context.db, {
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
  await chargeIfBilled(context, model, usage)
}

/** 共享模式门禁：走服务器供应商的调用，余额耗尽直接拒绝 */
async function gateSharedBalance(context: UpstreamRecordContext | undefined): Promise<void> {
  if (!context?.providerId) return
  const provider = await aiRepo.findProvider(context.db, context.providerId)
  if (!provider) return
  await billing.assertSharedBalance(context.db, context.ownerId, provider)
}

/** 用量落库后按模型单价扣个人余额；只对服务器供应商计费 */
async function chargeIfBilled(
  context: UpstreamRecordContext,
  model: string,
  usage: UpstreamUsage | null,
): Promise<void> {
  if (!usage || !context.providerId) return
  const provider = await aiRepo.findProvider(context.db, context.providerId)
  if (!provider || !billing.isBilledProvider(provider)) return
  // 计费是旁路：扣费出错不回滚已成功的生成，账务差异由管理员在余额页修正
  try {
    await billing.chargeUsage(context.db, context.ownerId, provider, model, usage)
  } catch {
    /* 余额扣减失败不影响本次回复 */
  }
}

/**
 * fetch 的传输层失败（DNS 解析、连接拒绝、TLS 握手等）抛的是普通 TypeError，
 * 不包装会被统一错误处理器当成 500 INTERNAL；这里统一转成 502 上游错误。
 */
function wrapUpstreamTransportError(e: unknown, timeoutMessage: string): unknown {
  if (e instanceof AppError) return e
  if (e instanceof Error && e.name === 'AbortError') return err.upstreamAi(timeoutMessage)
  return err.upstreamAi('无法连接 AI 上游', e instanceof Error ? e.message : String(e))
}

/** 非流式调用一次 OpenAI 兼容端点。主动消息等场景也复用它。 */
export async function callUpstream(input: {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  messages: ChatMessage[]
  /** 传入后走 function calling，上游可能回 tool_calls 而不是最终回复 */
  tools?: ChatToolDef[]
  record?: UpstreamRecordContext
}): Promise<UpstreamResult> {
  const base = input.baseUrl.trimEnd().replace(/\/$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  await gateSharedBalance(input.record)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  try {
    await assertAiUpstreamUrl(url)
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
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw err.upstreamAi(`上游返回 ${response.status}`, text.slice(0, 300))
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: UpstreamToolCallPayload[] } }>
    } & UpstreamUsagePayload
    const message = payload.choices?.[0]?.message
    const content = message?.content
    const toolCalls = normalizeToolCalls(message?.tool_calls)
    if (!content && toolCalls.length === 0) throw err.upstreamAi('上游没有返回内容')

    const usage = parseUpstreamUsage(payload)
    if (input.record) await recordUpstreamUsage(input.record, usage, input.model)
    return { content: content ?? '', usage, ...(toolCalls.length > 0 ? { toolCalls } : {}) }
  } catch (e) {
    throw wrapUpstreamTransportError(e, '上游请求超时')
  } finally {
    clearTimeout(timer)
  }
}

/** 上游 tool_calls 的原始分片形态：字段可能残缺，收集完再归一化 */
interface UpstreamToolCallPayload {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** 剔除缺 name 的残片，id 缺失时按序补一个 */
function normalizeToolCalls(raw: UpstreamToolCallPayload[] | undefined): ChatToolCall[] {
  if (!raw || raw.length === 0) return []
  const calls: ChatToolCall[] = []
  raw.forEach((item, index) => {
    if (!item.function?.name) return
    calls.push({
      id: item.id || `call_${index}`,
      type: 'function',
      function: { name: item.function.name, arguments: item.function.arguments ?? '' },
    })
  })
  return calls
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
  /** 传入后走 function calling，上游可能回 tool_calls 而不是最终回复 */
  tools?: ChatToolDef[]
  onDelta: (delta: string) => void
  record?: UpstreamRecordContext
}): Promise<UpstreamResult> {
  const base = input.baseUrl.trimEnd().replace(/\/$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  await gateSharedBalance(input.record)

  const controller = new AbortController()
  // 空闲超时：每收到一段数据就重置，长回复不会被总时长掐断
  let timer: ReturnType<typeof setTimeout> | null = null
  const armIdleTimeout = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), 120000)
  }

  try {
    await assertAiUpstreamUrl(url)
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
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
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
        choices?: Array<{ message?: { content?: string; tool_calls?: UpstreamToolCallPayload[] } }>
      } & UpstreamUsagePayload
      const message = payload.choices?.[0]?.message
      const content = message?.content
      const toolCalls = normalizeToolCalls(message?.tool_calls)
      if (!content && toolCalls.length === 0) throw err.upstreamAi('上游没有返回内容')
      if (content) input.onDelta(content)
      const usage = parseUpstreamUsage(payload)
      if (input.record) await recordUpstreamUsage(input.record, usage, input.model)
      return { content: content ?? '', usage, ...(toolCalls.length > 0 ? { toolCalls } : {}) }
    }

    if (!response.body) throw err.upstreamAi('上游没有返回流式内容')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''
    let full = ''
    let usage: UpstreamUsage | null = null
    // delta.tool_calls 按 index 分片到达，逐个累积到齐再归一化
    const toolAcc: Array<{ id?: string; name?: string; arguments: string }> = []

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
            choices?: Array<{
              delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
            }>
          } & UpstreamUsagePayload
          // usage 通常在最后一个 chunk；出现就覆盖，拿到的永远是最新一份
          const parsedUsage = parseUpstreamUsage(payload)
          if (parsedUsage) usage = parsedUsage
          const choice = payload.choices?.[0]
          const piece = choice?.delta?.content
          if (piece) {
            full += piece
            input.onDelta(piece)
          }
          for (const fragment of choice?.delta?.tool_calls ?? []) {
            const idx = Math.max(0, fragment.index ?? 0)
            const acc = (toolAcc[idx] ??= { arguments: '' })
            if (fragment.id) acc.id = fragment.id
            if (fragment.function?.name) acc.name = fragment.function.name
            if (fragment.function?.arguments) acc.arguments += fragment.function.arguments
          }
        } catch {
          /* 忽略解析不了的行，上游偶尔会混入注释或心跳 */
        }
      }
    }

    const toolCalls = normalizeToolCalls(
      toolAcc.filter((acc) => acc.name).map((acc) => ({ id: acc.id, function: { name: acc.name!, arguments: acc.arguments } })),
    )
    if (!full.trim() && toolCalls.length === 0) throw err.upstreamAi('上游没有返回内容')
    if (input.record) await recordUpstreamUsage(input.record, usage, input.model)
    return { content: full, usage, ...(toolCalls.length > 0 ? { toolCalls } : {}) }
  } catch (e) {
    throw wrapUpstreamTransportError(e, '上游请求超时')
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 工具调用轮数上限：防止模型反复调用工具不放 */
const MAX_TOOL_ROUNDS = 8

export interface ToolLoopInput {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  messages: ChatMessage[]
  /** 空数组/缺省时直接单轮调用，行为与无工具链路完全一致 */
  tools?: ChatToolDef[]
  /** 执行一个工具调用，返回给上游的文本结果 */
  executeTool: (name: string, argsJson: string) => Promise<string>
  /** 工具调用的实时进度回调（WS 推送用） */
  onToolStatus?: (tool: string, phase: 'start' | 'done') => void
  /** 流式模式：每轮增量走这里；不传则整轮非流式 */
  onDelta?: (delta: string) => void
  record?: UpstreamRecordContext
}

/**
 * function calling 主循环：上游要求执行工具就执行并回填结果，直到给出最终回复。
 * 达到轮数上限后去掉工具再要一次，强制收口；各轮 usage 由底层逐轮落库，
 * 汇总后挂在最终结果上供 finishGeneration 记总账。
 */
export async function runToolLoop(input: ToolLoopInput): Promise<UpstreamResult> {
  const tools = input.tools && input.tools.length > 0 ? input.tools : undefined
  const callOnce = (messages: ChatMessage[], withTools: boolean): Promise<UpstreamResult> => {
    const common = {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      messages,
      ...(withTools && tools ? { tools } : {}),
      record: input.record,
    }
    return input.onDelta ? callUpstreamStream({ ...common, onDelta: input.onDelta }) : callUpstream(common)
  }

  if (!tools) return await callOnce(input.messages, true)

  const messages = [...input.messages]
  let usageSum: UpstreamUsage | null = null
  const addUsage = (usage: UpstreamUsage | null): void => {
    if (!usage) return
    usageSum = usageSum
      ? {
          promptTokens: (usageSum.promptTokens ?? 0) + (usage.promptTokens ?? 0),
          completionTokens: (usageSum.completionTokens ?? 0) + (usage.completionTokens ?? 0),
          cachedTokens: (usageSum.cachedTokens ?? 0) + (usage.cachedTokens ?? 0),
        }
      : usage
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callOnce(messages, true)
    addUsage(result.usage)
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return { ...result, usage: usageSum ?? result.usage }
    }
    // 工具中转轮次：原样回填 assistant 的 tool_calls，再逐个补 tool 结果
    messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })
    for (const call of result.toolCalls) {
      input.onToolStatus?.(call.function.name, 'start')
      const output = await input.executeTool(call.function.name, call.function.arguments)
      input.onToolStatus?.(call.function.name, 'done')
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }

  // 轮数用尽：去掉工具再要一次最终回复
  const final = await callOnce(messages, false)
  addUsage(final.usage)
  return { ...final, usage: usageSum ?? final.usage }
}

/** 拉取 OpenAI 兼容端点的模型列表，只回传 id，供前端下拉选择 */
export async function listProviderModels(input: {
  baseUrl: string
  apiKey: string
}): Promise<string[]> {
  const base = input.baseUrl.trimEnd().replace(/\/$/, '')
  const url = `${base}/models`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    await assertAiUpstreamUrl(url)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw err.upstreamAi(`上游返回 ${response.status}`, text.slice(0, 200))
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: unknown } | unknown>
    }
    const rows = Array.isArray(payload.data) ? payload.data : []
    const ids = rows
      .map((row) => (typeof row === 'string' ? row : row && typeof row === 'object' && 'id' in row ? row.id : null))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim())
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 1000)
  } catch (e) {
    throw wrapUpstreamTransportError(e, '连接超时')
  } finally {
    clearTimeout(timer)
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
    await assertAiUpstreamUrl(url)
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
    throw wrapUpstreamTransportError(e, '连接超时')
  } finally {
    clearTimeout(timer)
  }
}

/** 用服务端托管的密钥测试已保存的服务商；表单里没填密钥时也能验证真实配置 */
export async function testStoredProvider(
  db: DB,
  ownerId: string,
  id: string,
  override?: { baseUrl?: string; model?: string },
): Promise<{ ok: boolean; sample: string }> {
  const row = await aiRepo.findProvider(db, id)
  if (!row || row.owner_id !== ownerId) throw err.notFound('服务商不存在')

  let apiKey: string
  try {
    apiKey = resolveServerApiKey(row)
  } catch {
    throw err.validation('托管密钥解密失败（服务端加密密钥可能变动过），请重新保存该密钥')
  }
  if (!apiKey) throw err.validation('该服务商没有配置 API Key，请先在表单里填写并保存')

  return testProvider({
    baseUrl: override?.baseUrl?.trim() || row.base_url,
    apiKey,
    model: override?.model?.trim() || row.model,
  })
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
): Promise<AiProvider> {
  const row = await aiRepo.findProvider(db, providerId)
  if (!row || row.owner_id !== ownerId) throw err.notFound('服务商不存在')

  const apiKey = resolveServerApiKey(row)
  if (!apiKey) throw err.validation('该服务商没有配置 API Key')

  const hit = await fetchProviderBalance({ baseUrl: row.base_url, apiKey })
  await aiRepo.saveProviderBalance(db, providerId, hit)

  const updated = await aiRepo.findProvider(db, providerId)
  if (!updated) throw err.notFound('服务商不存在')
  return toPublicProvider(updated)
}

/* ------------------------------- 调试模式 ------------------------------- */

/** 校验用户确实是该会话的成员，调试数据只给会话内的人看 */
async function assertConversationMember(db: DB, userId: string, conversationId: string): Promise<void> {
  const conversation = await conversationsRepo.findById(db, conversationId)
  if (!conversation || conversation.deleted_at !== null) throw err.notFound('会话不存在')
  if (!(await membersRepo.findActive(db, conversationId, userId))) {
    throw err.forbidden('不在该会话中')
  }
}

/** 上下文窗口取最近一次调用用的服务商配置；没配置就当 null */
async function resolveContextWindow(
  db: DB,
  conversationId: string,
  lastProviderId: string | null,
): Promise<number | null> {
  const session = await aiRepo.findSession(db, conversationId)
  const providerId = lastProviderId ?? session?.provider_id ?? null
  if (!providerId) return null
  const provider = await aiRepo.findProvider(db, providerId)
  return provider?.context_window ?? null
}

/** 会话维度的调试汇总：用量聚合 + 上下文水位 + 压缩进度 */
export async function debugSummary(db: DB, userId: string, conversationId: string): Promise<AiDebugSummary> {
  await assertConversationMember(db, userId, conversationId)

  // 聚合里带上最近的模型与窗口来源
  const lastUsage = await one<{ provider_id: string | null }>(
    db,
    'SELECT provider_id FROM ai_usage_log WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
    [conversationId],
  )

  const session = await aiRepo.findSession(db, conversationId)
  return debugRepo.debugSummary(db, conversationId, {
    contextWindow: await resolveContextWindow(db, conversationId, lastUsage?.provider_id ?? null),
    lastCompactedSeq: session?.last_compacted_seq ?? null,
    tokenEstimate: session?.token_estimate ?? null,
  })
}

/** 主人的 token 用量统计：时间窗作用于总览、时间序列与模型/功能/角色三个聚合 */
export async function usageStats(
  db: DB,
  userId: string,
  window: AiUsageWindow,
  tzOffsetMinutes?: number,
): Promise<AiUsageStats> {
  // 客户端没带偏移时退回服务端时区
  return debugRepo.usageStats(db, userId, window, tzOffsetMinutes ?? serverTzOffsetMinutes())
}

/** 本机密钥代跑后客户端回传的真实 usage */
export async function reportClientUsage(
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
): Promise<void> {
  if (input.conversationId) await assertConversationMember(db, userId, input.conversationId)
  if (input.personaId) {
    const persona = await aiRepo.findPersona(db, input.personaId)
    if (!persona || persona.owner_id !== userId) throw err.forbidden('无权使用该角色')
  }
  await debugRepo.insertUsage(db, {
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

/** 按 refId 批量查最近一次 usage（消息内联调试条用），只查自己的记录 */
export async function usageByRefs(
  db: DB,
  userId: string,
  refIds: string[],
): Promise<Record<string, AiUsageEntry>> {
  return debugRepo.findUsageByRefs(db, userId, refIds.slice(0, 200))
}

/** 会话最近的群聊决策记录 */
export async function listGroupDecisions(
  db: DB,
  userId: string,
  conversationId: string,
  limit: number,
): Promise<AiGroupDecision[]> {
  await assertConversationMember(db, userId, conversationId)
  return debugRepo.listDecisions(db, conversationId, Math.min(Math.max(limit, 1), 500))
}
