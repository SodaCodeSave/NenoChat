import {
  Permission,
  SenderType,
  type Message,
  type MessageMeta,
  type MessageType,
  type ReplyPreview,
} from '@nenochat/shared'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as messagesRepo from '../db/repo/messages'
import * as conversationsRepo from '../db/repo/conversations'
import * as membersRepo from '../db/repo/members'
import * as readCursorsRepo from '../db/repo/read-cursors'
import * as usersRepo from '../db/repo/users'
import { writeChange } from './change-log'
import { assertMember, assertPermission, isMuted } from './permission-service'
import { err } from '../util/errors'
import { now } from '../util/clock'
import { hub } from '../ws/hub'
import { emitMessageCreated, emitMessageUpdated } from '../ws/emitter'

export interface SendMessageInput {
  conversationId: string
  channelId?: string | null
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
function buildReplyPreview(
  db: DB,
  conversationId: string,
  replyToId: string,
): ReplyPreview | null {
  const row = messagesRepo.findById(db, replyToId)
  if (!row || row.conversation_id !== conversationId) return null
  return {
    id: row.id,
    senderId: row.sender_id,
    senderType: row.sender_type as SenderType,
    senderName: row.sender_id
      ? (usersRepo.findById(db, row.sender_id)?.display_name ?? '未知用户')
      : '系统',
    preview: messagesRepo.previewOf(row),
    type: row.type as MessageType,
  }
}

/** 合并引用快照进 meta；被引消息解析不到时返回 matched=false */
function mergeReplyMeta(
  db: DB,
  conversationId: string,
  replyToId: string | null,
  meta: MessageMeta | null,
): { meta: MessageMeta | null; matched: boolean } {
  if (!replyToId) return { meta, matched: false }
  const preview = buildReplyPreview(db, conversationId, replyToId)
  if (!preview) return { meta, matched: false }
  return { meta: { ...(meta ?? {}), replyTo: preview }, matched: true }
}

/**
 * 发消息的唯一写路径。
 * 权限校验、幂等、seq 分配、会话冗余字段、变更日志全部在同一个事务内完成，
 * 广播放在事务提交之后，避免「已广播但回滚」。
 */
export function send(db: DB, input: SendMessageInput): SendMessageResult {
  const result = withTx(db, () => {
    const member = assertPermission(db, input.conversationId, input.senderId, Permission.SEND_MESSAGE)
    if (isMuted(member)) throw err.forbidden('你已被禁言')

    if (input.content.trim().length === 0 && input.type === 'text') {
      throw err.validation('消息内容不能为空')
    }

    const existing = messagesRepo.findByNonce(db, input.senderId, input.clientNonce)
    if (existing) {
      return { message: messagesRepo.mapMessage(existing), duplicated: true }
    }

    const replyToId = input.replyToId ?? null
    const reply = mergeReplyMeta(db, input.conversationId, replyToId, input.meta ?? null)
    // 被引消息必须属于同一会话；已撤回的仍可引用，摘要会显示「消息已撤回」
    if (replyToId && !reply.matched) {
      throw err.validation('被回复的消息不存在')
    }
    const meta = reply.meta

    const seq = conversationsRepo.nextSeq(db, input.conversationId)
    const ts = now()

    const row = messagesRepo.insert(db, {
      conversationId: input.conversationId,
      channelId: input.channelId ?? null,
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

    conversationsRepo.touchLastMessage(db, input.conversationId, row.id, ts)

    const message = messagesRepo.mapMessage(row)
    writeChange(db, {
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
    emitMessageCreated(db, result.message, input.clientNonce)
  }
  return result
}

/** 由系统或 AI 产生的消息，跳过权限但走同一套落库与广播 */
export function appendSystemMessage(
  db: DB,
  input: {
    conversationId: string
    channelId?: string | null
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
): Message {
  const message = withTx(db, () => {
    const seq = conversationsRepo.nextSeq(db, input.conversationId)
    const ts = now()
    // AI/系统消息的引用来源同样定格成快照；解析不到就退化成普通消息
    const replyPreview = input.replyToId
      ? buildReplyPreview(db, input.conversationId, input.replyToId)
      : null
    const meta = replyPreview
      ? { ...(input.meta ?? {}), replyTo: replyPreview }
      : (input.meta ?? null)
    const row = messagesRepo.insert(db, {
      conversationId: input.conversationId,
      channelId: input.channelId ?? null,
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
    conversationsRepo.touchLastMessage(db, input.conversationId, row.id, ts)
    const mapped = messagesRepo.mapMessage(row)
    writeChange(db, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: input.conversationId,
      payload: mapped,
      actorId: input.senderId ?? null,
    })
    return mapped
  })

  emitMessageCreated(db, message, null)
  return message
}

export function edit(
  db: DB,
  input: { messageId: string; userId: string; content: string; deviceId?: string | null },
): Message {
  const message = withTx(db, () => {
    const row = messagesRepo.findById(db, input.messageId)
    if (!row || row.deleted_at !== null) throw err.notFound('消息不存在')
    if (row.sender_id !== input.userId) throw err.forbidden('只能编辑自己发送的消息')

    const ts = now()
    const updated = messagesRepo.updateContent(db, row.id, input.content, ts, input.deviceId ?? null)
    const mapped = messagesRepo.mapMessage(updated)
    writeChange(db, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.conversation_id,
      payload: mapped,
      actorId: input.userId,
    })
    return mapped
  })

  emitMessageUpdated(db, message)
  return message
}

export function recall(db: DB, input: { messageId: string; userId: string }): Message {
  const message = withTx(db, () => {
    const row = messagesRepo.findById(db, input.messageId)
    if (!row || row.deleted_at !== null) throw err.notFound('消息不存在')

    const member = membersRepo.findActive(db, row.conversation_id, input.userId)
    if (!member) throw err.forbidden('你不在这个会话中')

    const isOwn = row.sender_id === input.userId
    const canManage = (member.allow & Permission.MANAGE_MESSAGES) !== 0 || member.role !== 'member'
    if (!isOwn && !canManage) throw err.forbidden('没有权限撤回他人消息')

    const updated = messagesRepo.softDelete(db, row.id, input.userId, now())
    const mapped = messagesRepo.mapMessage(updated)
    writeChange(db, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.conversation_id,
      payload: mapped,
      actorId: input.userId,
    })
    return mapped
  })

  emitMessageUpdated(db, message)
  return message
}

export function pin(db: DB, input: { messageId: string; userId: string; pinned: boolean }): Message {
  const message = withTx(db, () => {
    const row = messagesRepo.findById(db, input.messageId)
    if (!row || row.deleted_at !== null) throw err.notFound('消息不存在')

    assertPermission(db, row.conversation_id, input.userId, Permission.PIN_MESSAGE)

    const updated = messagesRepo.setPinned(db, row.id, input.pinned ? now() : null)
    const mapped = messagesRepo.mapMessage(updated)
    writeChange(db, {
      entity: 'message',
      entityId: row.id,
      op: 'upsert',
      conversationId: row.conversation_id,
      payload: mapped,
      actorId: input.userId,
    })
    return mapped
  })

  emitMessageUpdated(db, message)
  return message
}

export function listPage(
  db: DB,
  input: {
    conversationId: string
    userId: string
    channelId?: string | null
    before?: number | null
    after?: number | null
    limit: number
  },
): { messages: Message[]; hasMore: boolean } {
  assertMember(db, input.conversationId, input.userId)

  // 多取一条用于判断是否还有更多
  const rows = messagesRepo.page(db, {
    conversationId: input.conversationId,
    channelId: input.channelId ?? null,
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
export function around(
  db: DB,
  input: { conversationId: string; userId: string; messageId: string; limit?: number },
): { messages: Message[]; hasMore: boolean } {
  assertMember(db, input.conversationId, input.userId)

  const anchor = messagesRepo.findById(db, input.messageId)
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

export function markRead(
  db: DB,
  input: { conversationId: string; userId: string; seq: number; messageId?: string | null; deviceId?: string | null },
): { advanced: boolean; lastReadSeq: number } {
  assertMember(db, input.conversationId, input.userId)

  const { advanced, row } = withTx(db, () => readCursorsRepo.advance(db, input))
  return { advanced, lastReadSeq: row.last_read_seq }
}

/** 群聊已读人数：由游标聚合推导 */
export function readCount(db: DB, conversationId: string, seq: number): number {
  return readCursorsRepo.countReadUpTo(db, conversationId, seq)
}

export function onlineMembers(db: DB, conversationId: string): string[] {
  return membersRepo
    .listActive(db, conversationId)
    .map((m) => m.user_id)
    .filter((id) => hub().isOnline(id))
}
