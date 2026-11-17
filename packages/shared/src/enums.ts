/** 会话类型：私聊 / 群聊 / AI 会话 */
export const ConversationType = {
  Direct: 'direct',
  Group: 'group',
  Ai: 'ai',
} as const
export type ConversationType = (typeof ConversationType)[keyof typeof ConversationType]

/** 消息内容类型 */
export const MessageType = {
  Text: 'text',
  Image: 'image',
  File: 'file',
  Sticker: 'sticker',
  System: 'system',
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

/** 发送者类型 */
export const SenderType = {
  User: 'user',
  Ai: 'ai',
  System: 'system',
} as const
export type SenderType = (typeof SenderType)[keyof typeof SenderType]

/** 成员角色，权重用于权限比较 */
export const Role = {
  Member: 'member',
  Admin: 'admin',
  Owner: 'owner',
} as const
export type Role = (typeof Role)[keyof typeof Role]

export const ROLE_WEIGHT: Record<Role, number> = {
  member: 1,
  admin: 2,
  owner: 3,
}

/** 会话内权限位 */
export const Permission = {
  SEND_MESSAGE: 1 << 0,
  ATTACH: 1 << 1,
  MENTION_ALL: 1 << 2,
  PIN_MESSAGE: 1 << 3,
  MANAGE_MESSAGES: 1 << 4,
  MANAGE_MEMBERS: 1 << 6,
  MANAGE_CONVERSATION: 1 << 7,
} as const
export type Permission = (typeof Permission)[keyof typeof Permission]

/** 各角色默认拥有的权限位 */
export const ROLE_BASE_PERMISSIONS: Record<Role, number> = {
  member: Permission.SEND_MESSAGE | Permission.ATTACH,
  admin:
    Permission.SEND_MESSAGE |
    Permission.ATTACH |
    Permission.MENTION_ALL |
    Permission.PIN_MESSAGE |
    Permission.MANAGE_MESSAGES |
    Permission.MANAGE_MEMBERS,
  owner: 0xffff,
}

/** 通知级别 */
export const NotificationLevel = {
  All: 'all',
  Mentions: 'mentions',
  None: 'none',
} as const
export type NotificationLevel = (typeof NotificationLevel)[keyof typeof NotificationLevel]

/** 好友关系状态 */
export const ContactRelation = {
  Friend: 'friend',
  PendingOut: 'pending_out',
  PendingIn: 'pending_in',
  Blocked: 'blocked',
} as const
export type ContactRelation = (typeof ContactRelation)[keyof typeof ContactRelation]

/** 动态可见范围 */
export const PostVisibility = {
  Public: 'public',
  Friends: 'friends',
  Private: 'private',
} as const
export type PostVisibility = (typeof PostVisibility)[keyof typeof PostVisibility]

/** AI 回复风格，决定长回复的分条力度 */
export const ReplyStyle = {
  Chatty: 'chatty',
  Concise: 'concise',
  Narrative: 'narrative',
} as const
export type ReplyStyle = (typeof ReplyStyle)[keyof typeof ReplyStyle]

/** AI 密钥存放位置 */
export const KeyLocation = {
  Local: 'local',
  Server: 'server',
} as const
export type KeyLocation = (typeof KeyLocation)[keyof typeof KeyLocation]

/** 消息本地状态（仅客户端） */
export const LocalStatus = {
  Pending: 'pending',
  Sent: 'sent',
  Failed: 'failed',
  Synced: 'synced',
} as const
export type LocalStatus = (typeof LocalStatus)[keyof typeof LocalStatus]

/** 主题模式 */
export const ThemeMode = {
  System: 'system',
  Light: 'light',
  Dark: 'dark',
} as const
export type ThemeMode = (typeof ThemeMode)[keyof typeof ThemeMode]

/** 已读回执状态 */
export const ReceiptState = {
  Delivered: 'delivered',
  Read: 'read',
} as const
export type ReceiptState = (typeof ReceiptState)[keyof typeof ReceiptState]

/** AI 记忆事实的归属主体 */
export const MemoryFactSubject = {
  User: 'user',
  Persona: 'persona',
  Relation: 'relation',
  World: 'world',
} as const
export type MemoryFactSubject = (typeof MemoryFactSubject)[keyof typeof MemoryFactSubject]

/** 同步变更实体名，与 sync_change_log.entity 一致 */
export const ChangeEntity = {
  User: 'user',
  Conversation: 'conversation',
  Member: 'member',
  Message: 'message',
  ReadCursor: 'read_cursor',
  Contact: 'contact',
  Post: 'post',
  PostComment: 'post_comment',
  PostLike: 'post_like',
  StickerPack: 'sticker_pack',
  Sticker: 'sticker',
  AiProvider: 'ai_provider',
  AiPersona: 'ai_persona',
  AiMemorySummary: 'ai_memory_summary',
  AiMemoryFact: 'ai_memory_fact',
  Notification: 'notification',
} as const
export type ChangeEntity = (typeof ChangeEntity)[keyof typeof ChangeEntity]
