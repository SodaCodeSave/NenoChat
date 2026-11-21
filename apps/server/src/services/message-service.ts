import {
  Permission,
  SenderType,
  ulid,
  type Message,
  type MessageMeta,
  type MessageType,
  type ReplyPreview,
} from '@nenochat/shared'
import type { Executor } from '../db'
import { withTx } from '../db/tx'
import * as messagesRepo from '../db/repo/messages'
import type { MessageRow } from '../db/repo/messages'
import * as conversationsRepo from '../db/repo/conversations'
import * as membersRepo from '../db/repo/members'
import * as readCursorsRepo from '../db/repo/read-cursors'
import * as usersRepo from '../db/repo/users'
import { writeChange } from './change-log'
import { assertMember, assertPermission, can, isMuted } from './permission-service'
import { err } from '../util/errors'
import { now } from '../util/clock'
import { hub } from '../ws/hub'
import { emitMessageCreated, emitMessageUpdated } from '../ws/emitter'

export interface SendMessageInput {
  conversationId: string
  senderId: string
  clientNonce: string
  type: MessageType
  content: string
  meta?: MessageMeta | null
  replyToId?: string | null
  deviceId?: string | null
}

export interface SendMessageResult {
  message: Message
  duplicated: boolean
}

/**
 * 引用快照：把被回复消息的发送者与摘要定格在 meta 里。
 * 这样历史翻页、换端、离线重启后都能还原引用块，不必再回查原消息。
 */
async function buildReplyPreview(
  db: Executor,
  conversationId: string,
  replyToId: string,
): Promise<ReplyPreview | null> {
  const row = await messagesRepo.findById(db, replyToId)
  if (!row || row.conversation_id !== conversationId) return null
  const sender = row.sender_id ? await usersRepo.findById(db, row.sender_id) : null
  return {
    id: row.id,
    senderId: row.sender_id,
    senderType: row.sender_type as SenderType,
    senderName: row.sender_id ? (sender?.display_name ?? '未知用户') : '系统',
    preview: messagesRepo.previewOf(row),
    type: row.type as MessageType,
  }
}

/** 合并引用快照进 meta；被引消息解析不到时返回 matched=false */
async function mergeReplyMeta(
  db: Executor,
  conversationId: string,
  replyToId: string | null,
  meta: MessageMeta | null,
): Promise<{ meta: MessageMeta | null; matched: boolean }> {
  if (!replyToId) return { meta, matched: false }
  const preview = await buildReplyPreview(db, conversationId, replyToId)
  if (!preview) return { meta, matched: false }
  return { meta: { ...(meta ?? {}), replyTo: preview }, matched: true }
}

/** 提及去重：meta.mentions 是用户 id 字符串数组（shared 的 MessageMetaSchema 校验过） */
function extractMentionIds(meta: MessageMeta | null): string[] {
  const raw = meta?.mentions
  if (!raw || raw.length === 0) return []
  return [...new Set(raw.filter((id) => typeof id === 'string' && id.length > 0))]
}

/**
 * 发消息的唯一写路径。
 * 权限校验、幂等、seq 分配、会话冗余字段、变更日志全部在同一个事务内完成，
 * 广播放在事务提交之后，避免「已广播但回滚」。
 */
export async function send(db: Executor, input: SendMessageInput): Promise<SendMessageResult> {
  const result = await withTx(db, async (tx) => {
    const member = await assertPermission(tx, input.conversationId, input.senderId, Permission.SEND_MESSAGE)
    if (isMuted(member)) throw err.forbidden('你已被禁言')

    if (input.content.trim().length === 0 && input.type === 'text') {
      throw err.validation('消息内容不能为空')
    }

    const existing = await messagesRepo.findByNonce(tx, input.senderId, input.clientNonce)
    if (existing) {
      return { message: messagesRepo.mapMessage(existing), duplicated: true }
    }

    const replyToId = input.replyToId ?? null
    const reply = await mergeReplyMeta(tx, input.conversationId, replyToId, input.meta ?? null)
    // 被引消息必须属于同一会话；已撤回的仍可引用，摘要会显示「消息已撤回」
    if (replyToId && !reply.matched) {
      throw err.validation('被回复的消息不存在')
    }
    const meta = reply.meta

    const seq = await conversationsRepo.nextSeq(tx, input.conversationId)
    const ts = now()

    const row = await messagesRepo.insert(tx, {
      conversationId: input.conversationId,
      senderId: input.senderId,
      senderType: SenderType.User,
      type: input.type,
      content: input.content,
      meta,
      replyToId,
      seq,
      clientNonce: input.clientNonce,
      createdAt: ts,
      updatedByDevice: input.deviceId ?? null,
    })

    await conversationsRepo.touchLastMessage(tx, input.conversationId, row.id, ts)

    // 提及写穿进 message_mentions，会话列表的 mention_count 才能免扫 meta
    const mentionIds = extractMentionIds(meta)
    if (mentionIds.length > 0) {
      await messagesRepo.insertMentions(tx, row, mentionIds)
    }

    const message = messagesRepo.mapMessage(row)
    await writeChange(tx, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: input.conversationId,
      payload: message,
      actorId: input.senderId,
    })

    return { message, duplicated: false }
  })

  if (!result.duplicated) {
    await emitMessageCreated(db, result.message, input.clientNonce)
  }
  return result
}

export interface ForwardResultItem {
  conversationId: string
  messages: Message[]
}

/**
 * 转发消息的 meta：保留附件、贴纸等展示信息，
 * 剥掉引用快照 / 提及 / 幂等键 / AI 元数据（目标会话里这些都不再成立），盖上转发来源。
 */
function buildForwardMeta(source: MessageRow, sourceLabel: string): MessageMeta {
  let meta: MessageMeta = {}
  if (source.meta) {
    try {
      meta = { ...(JSON.parse(source.meta) as MessageMeta) }
    } catch {
      meta = {}
    }
  }
  delete meta.mentions
  delete meta.mentionAll
  delete meta.replyTo
  delete meta.clientNonce
  delete meta.ai
  meta.forwardedFrom = sourceLabel
  return meta
}

/** 转发来源会话的展示名：群/AI 用会话名，私聊用对方昵称兜底 */
async function sourceConversationLabel(
  db: Executor,
  conversationId: string,
  viewerId: string,
): Promise<string> {
  const conversation = await conversationsRepo.findById(db, conversationId)
  if (!conversation) return '未知会话'
  if (conversation.name && conversation.name.trim().length > 0) return conversation.name
  if (conversation.type === 'direct') {
    const members = await membersRepo.listActive(db, conversationId)
    const partner = members.find((m) => m.user_id !== viewerId)
    if (partner) {
      const user = await usersRepo.findById(db, partner.user_id)
      if (user?.display_name) return user.display_name
    }
  }
  return '会话'
}

/**
 * 批量转发：把若干条消息原样复制到若干个目标会话。
 * 源会话要求可读（成员资格），目标会话逐个校验发送权限；
 * 每个目标会话独立事务，部分目标失败不影响其余；
 * 附件不复制文件，meta 里的 URL 引用即让附件 GC 认为仍被引用。
 * 广播放在事务提交之后，避免「已广播但回滚」。
 */
export async function forward(
  db: Executor,
  input: {
    userId: string
    messageIds: string[]
    targetConversationIds: string[]
    deviceId?: string | null
  },
): Promise<{ results: ForwardResultItem[] }> {
  const rows = await messagesRepo.findByIds(db, input.messageIds)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const sources = input.messageIds
    .map((id) => byId.get(id))
    .filter((row): row is MessageRow => Boolean(row) && row.deleted_at === null && row.type !== 'system')
  if (sources.length === 0) throw err.validation('没有可转发的消息')

  const sourceConversations = [...new Set(sources.map((row) => row.conversation_id))]
  for (const conversationId of sourceConversations) {
    await assertMember(db, conversationId, input.userId)
  }
  const sourceLabels = new Map<string, string>()
  for (const conversationId of sourceConversations) {
    sourceLabels.set(conversationId, await sourceConversationLabel(db, conversationId, input.userId))
  }

  const results: ForwardResultItem[] = []
  for (const targetId of input.targetConversationIds) {
    const messages = await withTx(db, async (tx) => {
      const member = await assertPermission(tx, targetId, input.userId, Permission.SEND_MESSAGE)
      if (isMuted(member)) throw err.forbidden('你已被禁言')

      const created: Message[] = []
      for (const source of sources) {
        const meta = buildForwardMeta(source, sourceLabels.get(source.conversation_id) ?? '会话')
        const seq = await conversationsRepo.nextSeq(tx, targetId)
        const ts = now()
        const row = await messagesRepo.insert(tx, {
          conversationId: targetId,
          senderId: input.userId,
          senderType: SenderType.User,
          type: source.type as MessageType,
          content: source.content,
          meta,
          replyToId: null,
          seq,
          // 转发行的幂等键由服务端生成，客户端没有乐观行需要对账
          clientNonce: ulid(),
          createdAt: ts,
          updatedByDevice: input.deviceId ?? null,
        })
        await conversationsRepo.touchLastMessage(tx, targetId, row.id, ts)
        const mapped = messagesRepo.mapMessage(row)
        await writeChange(tx, {
          entity: 'message',
          entityId: row.id,
          op: 'upsert',
          conversationId: targetId,
          payload: mapped,
          actorId: input.userId,
        })
        created.push(mapped)
      }
      return created
    })

    for (const message of messages) {
      await emitMessageCreated(db, message, null)
    }
    results.push({ conversationId: targetId, messages })
  }

  return { results }
}

/** 由系统或 AI 产生的消息，跳过权限但走同一套落库与广播 */
export async function appendSystemMessage(
  db: Executor,
  input: {
    conversationId: string
    senderType: SenderType
    senderId?: string | null
    type: MessageType
    content: string
    meta?: MessageMeta | null
    replyToId?: string | null
    aiGenerationId?: string | null
    aiIndex?: number | null
    clientNonce?: string | null
  },
): Promise<Message> {
  const message = await withTx(db, async (tx) => {
    const seq = await conversationsRepo.nextSeq(tx, input.conversationId)
    const ts = now()
    // AI/系统消息的引用来源同样定格成快照；解析不到就退化成普通消息
    const replyPreview = input.replyToId
      ? await buildReplyPreview(tx, input.conversationId, input.replyToId)
      : null
    const meta = replyPreview
      ? { ...(input.meta ?? {}), replyTo: replyPreview }
      : (input.meta ?? null)
    const row = await messagesRepo.insert(tx, {
      conversationId: input.conversationId,
      senderId: input.senderId ?? null,
      senderType: input.senderType,
      type: input.type,
      content: input.content,
      meta,
      replyToId: replyPreview?.id ?? null,
      seq,
      aiGenerationId: input.aiGenerationId ?? null,
      aiIndex: input.aiIndex ?? null,
      clientNonce: input.clientNonce ?? null,
      createdAt: ts,
    })
    await conversationsRepo.touchLastMessage(tx, input.conversationId, row.id, ts)
    // AI/系统消息同样写穿提及，保持 mention_count 统计口径一致
    const systemMentionIds = extractMentionIds(meta)
    if (systemMentionIds.length > 0) {
      await messagesRepo.insertMentions(tx, row, systemMentionIds)
    }
    const mapped = messagesRepo.mapMessage(row)
    await writeChange(tx, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: input.conversationId,
      payload: mapped,
      actorId: input.senderId ?? null,
    })
    return mapped
  })

  await emitMessageCreated(db, message, null)
  return message
}

export async function edit(
  db: Executor,
  input: { messageId: string; userId: string; content: string; deviceId?: string | null },
): Promise<Message> {
  const message = await withTx(db, async (tx) => {
    const row = await messagesRepo.findById(tx, input.messageId)
    if (!row || row.deleted_at !== null) throw err.notFound('消息不存在')
    if (row.sender_id !== input.userId) throw err.forbidden('只能编辑自己发送的消息')

    const ts = now()
    const updated = await messagesRepo.updateContent(tx, row.id, input.content, ts, input.deviceId ?? null)
    const mapped = messagesRepo.mapMessage(updated)
    await writeChange(tx, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.conversation_id,
      payload: mapped,
      actorId: input.userId,
    })
    return mapped
  })

  await emitMessageUpdated(db, message)
  return message
}

export async function recall(db: Executor, input: { messageId: string; userId: string }): Promise<Message> {
  const message = await withTx(db, async (tx) => {
    const row = await messagesRepo.findById(tx, input.messageId)
    if (!row || row.deleted_at !== null) throw err.notFound('消息不存在')

    const member = await membersRepo.findActive(tx, row.conversation_id, input.userId)
    if (!member) throw err.forbidden('你不在这个会话中')

    const isOwn = row.sender_id === input.userId
    // 撤回他人消息需要明确的管理权限位（含角色默认权限，并尊重 deny），
    // 不再用“非 member 即可”这种过宽判定
    if (!isOwn && !can(member, Permission.MANAGE_MESSAGES)) throw err.forbidden('没有权限撤回他人消息')

    const updated = await messagesRepo.softDelete(tx, row.id, input.userId, now())
    const mapped = messagesRepo.mapMessage(updated)
    await writeChange(tx, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.conversation_id,
      payload: mapped,
      actorId: input.userId,
    })
    return mapped
  })

  await emitMessageUpdated(db, message)
  return message
}

export async function pin(db: Executor, input: { messageId: string; userId: string; pinned: boolean }): Promise<Message> {
  const message = await withTx(db, async (tx) => {
    const row = await messagesRepo.findById(tx, input.messageId)
    if (!row || row.deleted_at !== null) throw err.notFound('消息不存在')

    await assertPermission(tx, row.conversation_id, input.userId, Permission.PIN_MESSAGE)

    const updated = await messagesRepo.setPinned(tx, row.id, input.pinned ? now() : null)
    const mapped = messagesRepo.mapMessage(updated)
    await writeChange(tx, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.conversation_id,
      payload: mapped,
      actorId: input.userId,
    })
    return mapped
  })

  await emitMessageUpdated(db, message)
  return message
}

export async function listPage(
  db: Executor,
  input: {
    conversationId: string
    userId: string
    before?: number | null
    after?: number | null
    limit: number
  },
): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(db, input.conversationId, input.userId)

  // 多取一条用于判断是否还有更多
  const rows = await messagesRepo.page(db, {
    conversationId: input.conversationId,
    before: input.before ?? null,
    after: input.after ?? null,
    limit: input.limit + 1,
  })

  const hasMore = rows.length > input.limit
  const sliced = hasMore ? rows.slice(0, input.limit) : rows
  const ordered = input.after != null && input.before == null ? sliced : sliced.reverse()

  return { messages: ordered.map(messagesRepo.mapMessage), hasMore }
}

/** 以某条消息为锚点加载上下文，供搜索结果跳转使用 */
export async function around(
  db: Executor,
  input: { conversationId: string; userId: string; messageId: string; limit?: number },
): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(db, input.conversationId, input.userId)

  const anchor = await messagesRepo.findById(db, input.messageId)
  if (!anchor || anchor.conversation_id !== input.conversationId) {
    throw err.notFound('消息不存在')
  }

  const limit = input.limit ?? 60
  const half = Math.ceil(limit / 2)
  return listPage(db, {
    conversationId: input.conversationId,
    userId: input.userId,
    // 多取半页在锚点之后，跳转后还能继续往下滑
    before: anchor.seq + half + 1,
    limit,
  })
}

export async function markRead(
  db: Executor,
  input: { conversationId: string; userId: string; seq: number; messageId?: string | null; deviceId?: string | null },
): Promise<{ advanced: boolean; lastReadSeq: number }> {
  await assertMember(db, input.conversationId, input.userId)

  const { advanced, row } = await withTx(db, (tx) => readCursorsRepo.advance(tx, input))
  return { advanced, lastReadSeq: row.last_read_seq }
}

/** 群聊已读人数：由游标聚合推导 */
export async function readCount(db: Executor, conversationId: string, seq: number): Promise<number> {
  return readCursorsRepo.countReadUpTo(db, conversationId, seq)
}

export async function onlineMembers(db: Executor, conversationId: string): Promise<string[]> {
  const members = await membersRepo.listActive(db, conversationId)
  return members.map((m) => m.user_id).filter((id) => hub().isOnline(id))
}
