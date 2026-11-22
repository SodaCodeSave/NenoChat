import type {
  ConnectorActionMeta,
  Contact,
  Conversation,
  Member,
  Message,
  Post,
  PostComment,
  User,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as membersRepo from '../db/repo/members'
import { now } from '../util/clock'
import { hub } from './hub'

/** 会话成员的 userId 列表，广播的唯一收件人来源 */
export async function memberIds(db: DB, conversationId: string): Promise<string[]> {
  const members = await membersRepo.listActive(db, conversationId)
  return members.map((m) => m.user_id)
}

/** typing / 已读回执这类高频事件的成员名单短缓存：5 秒内复用一次查询结果 */
const MEMBER_IDS_TTL_MS = 5000
const memberIdsCache = new Map<string, { ids: string[]; expiresAt: number }>()

/**
 * 仅限 typing / 已读回执扇出使用的缓存版本；成员变化最多延迟 5 秒生效。
 * 消息广播等权限关键路径必须继续走 memberIds 实时查询，不走这里。
 */
async function memberIdsCached(db: DB, conversationId: string): Promise<string[]> {
  const cached = memberIdsCache.get(conversationId)
  const ts = now()
  if (cached && cached.expiresAt > ts) return cached.ids
  const ids = await memberIds(db, conversationId)
  memberIdsCache.set(conversationId, { ids, expiresAt: ts + MEMBER_IDS_TTL_MS })
  return ids
}

export async function emitMessageCreated(db: DB, message: Message, tempId: string | null): Promise<void> {
  hub().sendToUsers(await memberIds(db, message.conversationId), 'message.created', {
    message,
    conversationId: message.conversationId,
    tempId,
  })
}

export async function emitMessageUpdated(db: DB, message: Message): Promise<void> {
  hub().sendToUsers(await memberIds(db, message.conversationId), 'message.updated', { message })
}

export async function emitConversationUpdated(db: DB, conversation: Conversation, me: Member | null = null): Promise<void> {
  hub().sendToUsers(await memberIds(db, conversation.id), 'conversation.updated', {
    conversation,
    me,
  })
}

export async function emitMemberUpserted(db: DB, conversationId: string, member: Member, user?: User): Promise<void> {
  hub().sendToUsers(await memberIds(db, conversationId), 'conversation.member.upserted', {
    conversationId,
    member,
    user,
  })
}

export async function emitMemberRemoved(
  db: DB,
  conversationId: string,
  userId: string,
  extraRecipients: string[] = [],
): Promise<void> {
  const recipients = new Set([...(await memberIds(db, conversationId)), userId, ...extraRecipients])
  hub().sendToUsers([...recipients], 'conversation.member.removed', { conversationId, userId })
}

export async function emitTyping(
  db: DB,
  input: { conversationId: string; userId: string; state: 'start' | 'stop'; expiresAt: number },
): Promise<void> {
  // typing 频率极高，成员名单走短缓存；名单只决定发给谁，不涉及权限判定
  hub().sendToUsers(
    await memberIdsCached(db, input.conversationId),
    'typing',
    input,
  )
}

export async function emitReadReceipt(
  db: DB,
  input: {
    conversationId: string
    userId: string
    messageSeq: number
    state: 'delivered' | 'read'
    at: number
  },
): Promise<void> {
  hub().sendToUsers(await memberIdsCached(db, input.conversationId), 'receipt.updated', input)
}

export function emitPostCreated(userIds: string[], post: Post): void {
  hub().sendToUsers(userIds, 'post.created', { post })
}

export function emitPostUpdated(userIds: string[], post: Post): void {
  hub().sendToUsers(userIds, 'post.updated', { post })
}

export function emitPostRemoved(userIds: string[], postId: string): void {
  hub().sendToUsers(userIds, 'post.removed', { postId })
}

export function emitPostCommentCreated(userIds: string[], comment: PostComment): void {
  hub().sendToUsers(userIds, 'post.comment.created', { comment })
}

/** 好友关系是个人域实体，只推给主人自己 */
export function emitContactUpdated(userId: string, contact: Contact): void {
  hub().sendToUser(userId, 'contact.updated', { contact })
}

/* ------------------------- AI 生成进度事件 ------------------------- */

type AiGenerationId = string
type AiConversationId = string

export async function emitAiDelta(
  db: DB,
  payload: { generationId: AiGenerationId; conversationId: AiConversationId; index: number; delta: string },
): Promise<void> {
  hub().sendToUsers(await memberIds(db, payload.conversationId), 'ai.delta', payload)
}

export async function emitAiSegment(
  db: DB,
  payload: { generationId: AiGenerationId; conversationId: AiConversationId; index: number; text: string },
): Promise<void> {
  hub().sendToUsers(await memberIds(db, payload.conversationId), 'ai.segment', payload)
}

export async function emitAiConnectorStatus(
  db: DB,
  payload: {
    conversationId: AiConversationId
    kind: ConnectorActionMeta['kind']
    phase: 'start' | 'done'
  },
): Promise<void> {
  hub().sendToUsers(await memberIds(db, payload.conversationId), 'ai.connector.status', payload)
}

export async function emitAiToolStatus(
  db: DB,
  payload: {
    conversationId: AiConversationId
    tool: string
    phase: 'start' | 'done'
  },
): Promise<void> {
  hub().sendToUsers(await memberIds(db, payload.conversationId), 'ai.tool.status', payload)
}

export async function emitAiDone(
  db: DB,
  payload: {
    generationId: AiGenerationId
    conversationId: AiConversationId
    messageIds: string[]
    model?: string
  },
): Promise<void> {
  hub().sendToUsers(await memberIds(db, payload.conversationId), 'ai.done', payload)
}

export async function emitAiError(
  db: DB,
  payload: {
    generationId: AiGenerationId
    conversationId: AiConversationId
    code: string
    message: string
  },
): Promise<void> {
  hub().sendToUsers(await memberIds(db, payload.conversationId), 'ai.error', payload)
}
