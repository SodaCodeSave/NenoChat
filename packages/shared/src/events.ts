import type {
  AppNotification,
  Attachment,
  AiGroupDecision,
  Channel,
  Contact,
  Conversation,
  Member,
  Message,
  MessageMeta,
  Post,
  PostComment,
  Receipt,
  Sticker,
  StickerPack,
  User,
} from './entities'
import type { MessageType, ReceiptState } from './enums'

/** 服务端 -> 客户端的增量变更记录 */
export interface ChangeRecord {
  seq: number
  entity: string
  entityId: string
  op: 'upsert' | 'delete'
  conversationId?: string | null
  userId?: string | null
  payload: unknown
  createdAt: number
}

/** 客户端发起的事件与其 payload */
export interface ClientEventPayloads {
  auth: {
    token: string
    deviceId: string
    /** 上次同步到的 change_log 位置；首次为 0 */
    cursor: number
    resume: boolean
  }
  ping: { ts: number }
  'message.send': {
    conversationId: string
    channelId?: string | null
    clientNonce: string
    type: MessageType
    content: string
    meta?: MessageMeta
    replyToId?: string | null
    /** 客户端本地时间，仅作展示参考 */
    ts?: number
  }
  'message.edit': { messageId: string; content: string }
  'message.delete': { messageId: string }
  typing: { conversationId: string; state: 'start' | 'stop' }
  read: { conversationId: string; messageSeq: number }
  receipt: { messageId: string; state: ReceiptState }
  presence: { status: 'online' | 'away' | 'dnd' }
  'sync.pull': { since: number; limit?: number }
  'ai.cancel': { generationId: string }
  subscribe: { conversationId: string; off?: boolean }
}

export type ClientEventName = keyof ClientEventPayloads

/** 服务端推送的事件与其 payload */
export interface ServerEventPayloads {
  'auth.ok': {
    user: User
    sessionId: string
    serverTime: number
    cursor: number
    catchUp: { hasMore: boolean; nextCursor: number }
  }
  'auth.err': { code: string; message: string }
  pong: { ts: number; serverTime: number }

  'message.created': {
    message: Message
    conversationId: string
    channelId?: string | null
    /** 回显客户端 nonce，用于把本地 pending 消息转正 */
    tempId?: string | null
  }
  'message.updated': { message: Message }
  'message.deleted': { id: string; conversationId: string; seq: number }

  'receipt.updated': {
    conversationId: string
    userId: string
    messageSeq: number
    state: ReceiptState
    at: number
  }

  typing: { conversationId: string; userId: string; state: 'start' | 'stop'; expiresAt: number }
  'presence.updated': { userId: string; status: 'online' | 'away' | 'dnd' | 'offline'; lastSeenAt?: number }

  'conversation.updated': { conversation: Conversation; me?: Member | null }
  'conversation.member.upserted': { conversationId: string; member: Member; user?: User }
  'conversation.member.removed': { conversationId: string; userId: string }
  'channel.upserted': { conversationId: string; channel: Channel }
  'channel.removed': { conversationId: string; channelId: string }

  'post.created': { post: Post }
  'post.updated': { post: Post }
  'post.removed': { postId: string }
  'post.like.changed': { postId: string; userId: string; liked: boolean; likeCount: number }
  'post.comment.created': { comment: PostComment }
  'post.comment.removed': { postId: string; commentId: string }

  'contact.updated': { contact: Contact }
  'sticker.upserted': { sticker: Sticker }
  'sticker.removed': { stickerId: string }
  'stickerPack.upserted': { pack: StickerPack }
  'stickerPack.removed': { packId: string }
  'attachment.upserted': { attachment: Attachment }

  'ai.delta': { generationId: string; conversationId: string; index: number; delta: string }
  'ai.segment': { generationId: string; conversationId: string; index: number; text: string }
  'ai.done': {
    generationId: string
    conversationId: string
    messageIds: string[]
    usage?: { promptTokens?: number; completionTokens?: number }
    model?: string
  }
  'ai.error': { generationId: string; conversationId: string; code: string; message: string }
  /** 调试模式：群聊成员的一次决策（规则层判定或模型层产出），推给开启调试的主人 */
  'ai.debug.decision': { decision: AiGroupDecision }
  'ai.proactive.due': { conversationId: string; personaId: string; hint?: string; dueAt: number }
  /**
   * 群聊里轮到某个角色说话，但它的密钥在本机。
   * 服务端已完成规则预筛并占好配额，在线客户端只需生成内容再回传。
   */
  'ai.group.due': {
    logId: string
    conversationId: string
    channelId?: string | null
    personaId: string
    kind: 'reply' | 'autonomy'
    /** 触发这次插话的消息，自主开口时为空 */
    triggerMessageId?: string | null
    mood: string
    energy: number
    dueAt: number
  }
  /**
   * 服务端判定某个角色该去动态广场活动了，但它的密钥在本机，
   * 只能由在线客户端代跑生成，结果通过动态接口回写。
   */
  'ai.moment.due': {
    taskId: string
    kind: 'post' | 'comment'
    personaId: string
    postId?: string
    dueAt: number
  }

  'sync.batch': { changes: ChangeRecord[]; nextCursor: number; hasMore: boolean }
  'sync.reset': { reason: 'cursor_expired'; snapshotCursor: number }

  'notification.created': { notification: AppNotification }
  'notification.updated': { notification: AppNotification }
  'server.notice': { level: 'info' | 'warn' | 'error'; message: string }
  error: { code: string; message: string }
}

export type ServerEventName = keyof ServerEventPayloads

/** WS 帧：请求 / 响应 / 事件 / 确认 */
export type WsFrame =
  | { t: 'req'; id: string; e: ClientEventName; d: unknown }
  | { t: 'res'; id: string; ok: true; d: unknown }
  | { t: 'res'; id: string; ok: false; err: { code: string; message: string; details?: unknown } }
  | { t: 'evt'; e: ServerEventName; d: unknown; seq?: number }
  | { t: 'ack'; seq: number }

/** 统一的 REST 错误体 */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export const ApiErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UPSTREAM_AI_ERROR: 'UPSTREAM_AI_ERROR',
  INTERNAL: 'INTERNAL',
} as const
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode]
