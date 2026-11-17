import type {
  ChannelKind,
  ContactRelation,
  ConversationType,
  KeyLocation,
  LocalStatus,
  MemoryFactSubject,
  MessageType,
  NotificationLevel,
  PostVisibility,
  ReceiptState,
  ReplyStyle,
  Role,
  SenderType,
  ThemeMode,
} from './enums'

/** 对外可见的用户资料 */
export interface PublicUser {
  id: string
  username: string
  displayName: string
  avatarUrl?: string | null
  bio?: string | null
}

export interface User extends PublicUser {
  status: 'active' | 'disabled'
  isAdmin: boolean
  lastSeenAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface Device {
  id: string
  userId: string
  name: string
  platform: string
  appVersion?: string | null
  createdAt: number
  lastActiveAt?: number | null
}

export interface Conversation {
  id: string
  type: ConversationType
  name?: string | null
  avatarUrl?: string | null
  ownerId?: string | null
  announcement?: string | null
  announcementUpdatedAt?: number | null
  announcementUpdatedBy?: string | null
  aiPersonaId?: string | null
  aiOwnerUserId?: string | null
  lastMessageId?: string | null
  lastMessageAt?: number | null
  messageCount: number
  dmKey?: string | null
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

export interface Member {
  conversationId: string
  userId: string
  role: Role
  nickname?: string | null
  allow: number
  deny: number
  muteUntil?: number | null
  pinnedAt?: number | null
  notificationLevel?: NotificationLevel | null
  joinedAt: number
  leftAt?: number | null
  updatedAt: number
}

export interface Channel {
  id: string
  conversationId: string
  name: string
  topic?: string | null
  kind: ChannelKind
  category?: string | null
  position: number
  archivedAt?: number | null
  createdBy?: string | null
  createdAt: number
  updatedAt: number
}

/** 消息附件引用（存于 message.meta.attachments） */
export interface AttachmentRef {
  id: string
  kind: 'image' | 'file' | 'sticker' | 'avatar'
  filename: string
  mime: string
  size: number
  width?: number | null
  height?: number | null
  url: string
  thumbUrl?: string | null
}

/** AI 相关元信息，仅 AI 会话的消息携带 */
export interface AiMessageMeta {
  generationId: string
  index: number
  model?: string
  personaId?: string
  /** 该分条在原始回复中的总条数，用于折叠渲染 */
  totalSegments?: number
  /** 被用户中止时标记 */
  cancelled?: boolean
  /** 由服务端定时任务（或客户端代跑）主动发起的消息 */
  proactive?: boolean
}

/** 引用回复的快照：发送时定稿，跨分页、离线与重启后仍能还原引用块 */
export interface ReplyPreview {
  id: string
  senderId?: string | null
  senderType?: SenderType
  senderName: string
  /** 被引消息的摘要；原消息撤回后为提示文本 */
  preview: string
  type?: MessageType
}

export interface MessageMeta {
  mentions?: string[]
  mentionAll?: boolean
  attachments?: AttachmentRef[]
  stickerId?: string
  emoji?: string
  clientNonce?: string
  ai?: AiMessageMeta
  /** 被回复消息的快照，由服务端落库时写入 */
  replyTo?: ReplyPreview
}

export interface Message {
  id: string
  conversationId: string
  channelId?: string | null
  senderId?: string | null
  senderType: SenderType
  type: MessageType
  content: string
  meta?: MessageMeta | null
  replyToId?: string | null
  seq: number
  clientNonce?: string | null
  aiGenerationId?: string | null
  aiIndex?: number | null
  pinnedAt?: number | null
  editedAt?: number | null
  deletedAt?: number | null
  deletedBy?: string | null
  createdAt: number
  updatedAt: number
  updatedByDevice?: string | null
  /** 仅客户端：本地发送状态 */
  localStatus?: LocalStatus
  localError?: string | null
}

export interface ReadCursor {
  conversationId: string
  userId: string
  lastReadSeq: number
  lastReadMessageId?: string | null
  lastReadAt?: number | null
  updatedAt: number
}

export interface Receipt {
  messageId: string
  userId: string
  state: ReceiptState
  updatedAt: number
}

export interface Attachment {
  id: string
  ownerId: string
  conversationId?: string | null
  messageId?: string | null
  kind: 'image' | 'file' | 'sticker' | 'avatar'
  filename: string
  mime: string
  size: number
  width?: number | null
  height?: number | null
  sha256: string
  url: string
  thumbUrl?: string | null
  createdAt: number
}

export interface Contact {
  ownerId: string
  contactUserId: string
  alias?: string | null
  relation: ContactRelation
  requestMessage?: string | null
  createdAt: number
  updatedAt: number
  /** 展开的对方资料，读路径直接可用 */
  user?: PublicUser
}

export interface Post {
  id: string
  /** 归属用户：角色发的动态也记在主人名下，删除权限以此为准 */
  authorId: string
  /** 实际署名的 AI 角色，普通用户动态为空 */
  personaId?: string | null
  content: string
  visibility: PostVisibility
  likeCount: number
  commentCount: number
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
  author?: PublicUser
  attachments?: AttachmentRef[]
  likedByMe?: boolean
}

export interface PostComment {
  id: string
  postId: string
  /** 归属用户：角色发的评论也记在主人名下 */
  authorId: string
  /** 实际署名的 AI 角色，普通用户评论为空 */
  personaId?: string | null
  content: string
  replyToCommentId?: string | null
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
  author?: PublicUser
}

export interface StickerPack {
  id: string
  ownerId?: string | null
  name: string
  kind: 'emoji' | 'image'
  position: number
  createdAt: number
  updatedAt: number
}

export interface Sticker {
  id: string
  packId: string
  kind: 'unicode' | 'image' | 'gif'
  value?: string | null
  attachmentId?: string | null
  url?: string | null
  keywords: string[]
  position: number
  createdAt: number
  updatedAt: number
}

export interface AiProvider {
  id: string
  ownerId: string
  name: string
  baseUrl: string
  /** 服务端只返回掩码，客户端仅在本地模式下持有明文 */
  apiKeyMasked?: string | null
  keyLocation: KeyLocation
  model: string
  temperature: number
  maxTokens: number
  isDefault: boolean
  /** 最近一次探测到的余额（如 "110.00"），null 表示未探测到 */
  balance?: string | null
  balanceCurrency?: string | null
  balanceCheckedAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface ProactiveConfig {
  enabled: boolean
  minIdleHours: number
  maxPerDay: number
  windowStart?: string
  windowEnd?: string
}

/** 主动消息与动态互动的配置来源：跟随全局，或每个角色单独一份 */
export type ProactiveMode = 'global' | 'custom'

export interface AiPersona {
  id: string
  ownerId: string
  /** 角色在 users 表里的影子账号 id；进群、加好友都用它当成员标识 */
  userId?: string | null
  name: string
  avatarUrl?: string | null
  systemPrompt: string
  greeting?: string | null
  /** 兴趣标签，注入提示词用，也用于通讯录列表摘要 */
  interests: string[]
  /** 角色卡正文：世界观、说话习惯、经历等长文本设定 */
  card?: string | null
  /** 角色卡原文件地址（相对路径，客户端拼 baseUrl） */
  cardUrl?: string | null
  cardFilename?: string | null
  /** 是否出现在通讯录的「AI 角色」分组 */
  inContacts: boolean
  providerId?: string | null
  modelOverride?: string | null
  temperature?: number | null
  replyStyle: ReplyStyle
  /** 角色自己的主动消息配置，仅在 proactiveMode='custom' 时生效 */
  proactive: ProactiveConfig
  proactiveMode: ProactiveMode
  lastProactiveAt?: number | null
  createdAt: number
  updatedAt: number
}

/**
 * 用户的 AI 自动互动总闸。
 * 主动私聊与动态互动共用同一条记录，避免「关了一个另一个还在发」。
 */
export interface AiGlobalSettings {
  proactiveEnabled: boolean
  minIdleHours: number
  maxPerDay: number
  windowStart?: string | null
  windowEnd?: string | null
  /** 动态互动总开关：自动发动态、自动评论、随机点赞都由它控制 */
  momentsEnabled: boolean
  momentsPostsPerDay: number
  momentsCommentsPerDay: number
  momentsLikesPerDay: number
  /** 群聊自动互动总开关：关掉后角色不再插话，也不再主动开口 */
  groupEnabled: boolean
  /** 每个角色在每个群里每天最多插话几条 */
  groupRepliesPerDay: number
  /** 每个角色在每个群里每天最多主动开几次话题 */
  groupAutonomyPerDay: number
  /** 是否把 AI 回复拆成多条消息发送 */
  segmentEnabled: boolean
  /** 分段用的分隔符正则，默认命中句号、感叹号、问号和换行 */
  segmentPattern: string
  /** AI 回复逐字流式输出；关掉时只要开了分段，仍然按流式增量出段落 */
  streamEnabled: boolean
  updatedAt: number
}

/** 角色在某个群里的心情与体力，决定它愿不愿意接话 */
export interface AiGroupMood {
  conversationId: string
  personaId: string
  /** 0-100，聊天会消耗，休息会恢复 */
  energy: number
  mood: string
  lastReplyAt?: number | null
  lastAutonomyAt?: number | null
  updatedAt: number
}

export interface AiSession {
  conversationId: string
  personaId: string
  providerId: string
  memoryEnabled: boolean
  lastCompactedSeq: number
  messagesSinceCompact: number
  tokenEstimate: number
  createdAt: number
  updatedAt: number
}

export interface AiMemorySummary {
  id: string
  conversationId: string
  fromSeq: number
  toSeq: number
  summary: string
  tokenEstimate: number
  model?: string | null
  supersededBy?: string | null
  createdAt: number
}

export interface AiMemoryFact {
  id: string
  conversationId: string
  subject: MemoryFactSubject
  key: string
  value: string
  confidence: number
  sourceMessageId?: string | null
  status: 'active' | 'superseded' | 'rejected'
  supersededBy?: string | null
  createdAt: number
  updatedAt: number
}

export interface AiGeneration {
  id: string
  conversationId: string
  userId: string
  userMessageId?: string | null
  providerId: string
  personaId: string
  runLocation: KeyLocation
  model?: string | null
  status: 'pending' | 'streaming' | 'done' | 'error' | 'cancelled'
  error?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  messageIds: string[]
  startedAt: number
  finishedAt?: number | null
}

export interface AppNotification {
  id: string
  userId: string
  type: 'mention' | 'dm' | 'group' | 'ai_proactive' | 'post_like' | 'post_comment' | 'system'
  title: string
  body?: string | null
  conversationId?: string | null
  messageId?: string | null
  postId?: string | null
  isRead: boolean
  createdAt: number
}

export interface UserSettings {
  theme: ThemeMode
  accent: string
  fontScale: number
  density: 'cozy' | 'compact'
  sendKey: 'enter' | 'ctrl+enter'
  locale: string
  reduceMotion: boolean
}

export interface NotificationSettings {
  desktopEnabled: boolean
  soundEnabled: boolean
  showPreview: boolean
  dmLevel: NotificationLevel
  groupLevel: NotificationLevel
  dndEnabled: boolean
  dndStart: string
  dndEnd: string
  timezone: string
}

/** GET /server/info 的响应 */
export interface ServerInfo {
  name: string
  version: string
  minClientVersion: string
  registration: { open: boolean; inviteRequired: boolean }
  limits: { maxUploadMb: number; maxGroupMembers: number }
  features: { ai: boolean; proactive: boolean; moments: boolean }
}

/** 服务器实例（仅客户端本地保存） */
export interface ServerInstance {
  id: string
  name: string
  baseUrl: string
  wsUrl: string
  serverName?: string | null
  iconUrl?: string | null
  lastUserId?: string | null
  lastConnectedAt?: number | null
  addedAt: number
}
