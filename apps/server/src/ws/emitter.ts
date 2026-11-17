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
import { hub } from './hub'

/** 会话成员的 userId 列表，广播的唯一收件人来源 */
export function memberIds(db: DB, conversationId: string): string[] {
  return membersRepo.listActive(db, conversationId).map((m) => m.user_id)
}

export function emitMessageCreated(db: DB, message: Message, tempId: string | null): void {
  hub().sendToUsers(memberIds(db, message.conversationId), 'message.created', {
    message,
    conversationId: message.conversationId,
    tempId,
  })
}

export function emitMessageUpdated(db: DB, message: Message): void {
  hub().sendToUsers(memberIds(db, message.conversationId), 'message.updated', { message })
}

export function emitConversationUpdated(db: DB, conversation: Conversation, me: Member | null = null): void {
  hub().sendToUsers(memberIds(db, conversation.id), 'conversation.updated', {
    conversation,
    me,
  })
}

export function emitMemberUpserted(db: DB, conversationId: string, member: Member, user?: User): void {
  hub().sendToUsers(memberIds(db, conversationId), 'conversation.member.upserted', {
    conversationId,
    member,
    user,
  })
}

export function emitMemberRemoved(
  db: DB,
  conversationId: string,
  userId: string,
  extraRecipients: string[] = [],
): void {
  const recipients = new Set([...memberIds(db, conversationId), userId, ...extraRecipients])
  hub().sendToUsers([...recipients], 'conversation.member.removed', { conversationId, userId })
}

export function emitTyping(
  db: DB,
  input: { conversationId: string; userId: string; state: 'start' | 'stop'; expiresAt: number },
): void {
  hub().sendToUsers(
    memberIds(db, input.conversationId),
    'typing',
    input,
  )
}

export function emitReadReceipt(
  db: DB,
  input: {
    conversationId: string
    userId: string
    messageSeq: number
    state: 'delivered' | 'read'
    at: number
  },
): void {
  hub().sendToUsers(memberIds(db, input.conversationId), 'receipt.updated', input)
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

export function emitAiDelta(
  db: DB,
  payload: { generationId: AiGenerationId; conversationId: AiConversationId; index: number; delta: string },
): void {
  hub().sendToUsers(memberIds(db, payload.conversationId), 'ai.delta', payload)
}

export function emitAiSegment(
  db: DB,
  payload: { generationId: AiGenerationId; conversationId: AiConversationId; index: number; text: string },
): void {
  hub().sendToUsers(memberIds(db, payload.conversationId), 'ai.segment', payload)
}

export function emitAiConnectorStatus(
  db: DB,
  payload: {
    conversationId: AiConversationId
    kind: ConnectorActionMeta['kind']
    phase: 'start' | 'done'
  },
): void {
  hub().sendToUsers(memberIds(db, payload.conversationId), 'ai.connector.status', payload)
}

export function emitAiDone(
  db: DB,
  payload: {
    generationId: AiGenerationId
    conversationId: AiConversationId
    messageIds: string[]
    model?: string
  },
): void {
  hub().sendToUsers(memberIds(db, payload.conversationId), 'ai.done', payload)
}

export function emitAiError(
  db: DB,
  payload: {
    generationId: AiGenerationId
    conversationId: AiConversationId
    code: string
    message: string
  },
): void {
  hub().sendToUsers(memberIds(db, payload.conversationId), 'ai.error', payload)
}
