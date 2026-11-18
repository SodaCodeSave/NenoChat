import type {
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
  /** 识图模型生成的图片描述，仅图片附件且被识图后才有 */
  description?: string | null
}

/** 一次回复里连接器做过的动作，供聊天界面展示资料来源 */
export interface ConnectorActionMeta {
  kind: 'web_search' | 'fetch' | 'bilibili' | 'weather'
  /** 简要细节：抓取的网页数、视频标题等 */
  detail?: string
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
  /** 本次回复用到的连接器动作（B 站 / 网页抓取 / 联网搜索） */
  connector?: ConnectorActionMeta[]
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
  /** 识图模型名：把聊天图片转成文字描述，让不支持多模态的主模型也能看懂图片 */
  visionModel?: string | null
  /** 模型上下文窗口大小（token 数），调试模式用它算上下文水位；空表示未配置 */
  contextWindow?: number | null
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

/** 主动消息的触发方式：idle = 空闲几小时后；chance = 按固定间隔掷概率找话题 */
export type ProactiveTriggerMode = 'idle' | 'chance'

export interface ProactiveConfig {
  enabled: boolean
  /** 触发方式，缺省按 idle 处理（兼容旧配置） */
  triggerMode?: ProactiveTriggerMode
  minIdleHours: number
  /** 每天最多几条；-1 表示无上限，0 表示不发 */
  maxPerDay: number
  /** chance 模式：掷骰间隔单位（每分钟 / 每小时） */
  chanceUnit?: 'minute' | 'hour'
  /** chance 模式：每次掷骰的触发概率（0-1） */
  chanceProbability?: number
  /** chance 模式：两次主动消息之间的最小冷却（分钟） */
  chanceCooldownMinutes?: number
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

/** 角色日程里的一个时间段，时间统一用角色本地时区的 HH:MM */
export interface AiScheduleItem {
  start: string
  end: string
  activity: string
}

/** 日程来源：AI 生成 / 用户手动调整 */
export type AiScheduleSource = 'ai' | 'manual'

/** 角色某一天的日程 */
export interface AiSchedule {
  personaId: string
  /** YYYY-MM-DD，按角色所在时区算出的本地日 */
  dayKey: string
  items: AiScheduleItem[]
  source: AiScheduleSource
  updatedAt: number
}

/**
 * 用户的 AI 自动互动总闸。
 * 主动私聊与动态互动共用同一条记录，避免「关了一个另一个还在发」。
 */
export interface AiGlobalSettings {
  proactiveEnabled: boolean
  minIdleHours: number
  /** 每天最多几条；-1 表示无上限，0 表示不发 */
  maxPerDay: number
  triggerMode?: ProactiveTriggerMode
  chanceUnit?: 'minute' | 'hour'
  chanceProbability?: number
  chanceCooldownMinutes?: number
  windowStart?: string | null
  windowEnd?: string | null
  /** 动态互动总开关：自动发动态、自动评论、随机点赞都由它控制 */
  momentsEnabled: boolean
  momentsPostsPerDay: number
  momentsCommentsPerDay: number
  momentsLikesPerDay: number
  /** 群聊自动互动总开关：关掉后角色不再插话，也不再主动开口 */
  groupEnabled: boolean
  /** 每个角色在每个群里每天最多插话几条；-1 表示无上限，0 表示不插话 */
  groupRepliesPerDay: number
  /** 一条群消息最多几个角色排队接话（1-5）；后接话的角色能看到前面角色的发言 */
  groupRepliesPerMessage: number
  /** 固定接话概率（0-100）；不配置时走体力与话题相关度的公式 */
  groupReplyProbability?: number | null
  /** 两次插话最少隔几分钟；不配置用默认 45 秒，0 表示不限制（被点名始终必回） */
  groupReplyCooldownMinutes?: number | null
  /** 每个角色在每个群里每天最多主动开几次话题 */
  groupAutonomyPerDay: number
  /** 是否把 AI 回复拆成多条消息发送 */
  segmentEnabled: boolean
  /** 分段用的分隔符正则，默认命中句号、感叹号、问号和换行 */
  segmentPattern: string
  /** AI 回复逐字流式输出；关掉时只要开了分段，仍然按流式增量出段落 */
  streamEnabled: boolean
  /** 调试模式：显示 token 消耗、缓存命中率、群聊成员决策过程等信息 */
  debugMode: boolean
  updatedAt: number
}

/** 一次上游 AI 调用的用途分类 */
export type AiUsageKind =
  | 'chat'
  | 'group_reply'
  | 'group_autonomy'
  | 'proactive'
  | 'moment'
  | 'schedule'
  | 'summary'
  | 'vision'
  | 'title'
  | 'client_report'

/** 一次上游 AI 调用的真实 token 用量 */
export interface AiUsageEntry {
  id: string
  ownerId: string
  conversationId: string | null
  personaId: string | null
  providerId: string | null
  kind: AiUsageKind
  /** 关联对象：私聊 generationId / 群聊 logId 等 */
  refId: string | null
  model: string | null
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  createdAt: number
}

/** 群聊成员的一次决策记录：规则层判定或模型层产出 */
export interface AiGroupDecision {
  id: string
  conversationId: string
  personaId: string
  /** 展示用的角色名，记录快照避免角色改名后历史失真 */
  personaName: string
  triggerMessageId: string | null
  kind: 'reply' | 'autonomy'
  /** 规则层是否放行 */
  fired: boolean
  /** rules = 规则层判定；model = 模型产出（含 SKIP） */
  stage: 'rules' | 'model'
  reason: string | null
  energy: number | null
  mood: string | null
  logId: string | null
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number } | null
  createdAt: number
}

/** 会话维度的调试汇总：用量统计 + 上下文水位 */
export interface AiDebugSummary {
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  /** 缓存命中率 = cachedTokens / promptTokens；没有数据时为 null */
  hitRate: number | null
  lastPromptTokens: number | null
  lastModel: string | null
  lastUsageAt: number | null
  contextWindow: number | null
  /** 最近一次 prompt_tokens 占上下文窗口的比例（0-1），缺窗口配置时为 null */
  contextLevel: number | null
  /** 私聊：已压缩摘要覆盖到的消息 seq */
  lastCompactedSeq: number | null
  /** 私聊：session 记录的粗略 token 估算 */
  tokenEstimate: number | null
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

/* ------------------------------ 连接器 ------------------------------ */

/** 连接器类型：网页搜索 / B 站视频 */
export type ConnectorType = 'deepseek_search' | 'bilibili' | 'heweather'

/** 非敏感配置，随连接器一起下发给客户端 */
export interface ConnectorConfig {
  /** DeepSeek 搜索端点，留空使用官方地址 */
  baseUrl?: string | null
  /** 搜索返回条数 */
  count?: number | null
  /** B 站降级时取多少条热评 */
  maxComments?: number | null
  location?: string | null
  latitude?: number | null
  longitude?: number | null
  weatherAlways?: boolean
  weatherOnUserMessage?: boolean
  weatherOnMention?: boolean
  weatherTool?: boolean
}

/** 敏感配置只回掩码，明文永远不上客户端 */
export interface ConnectorSecretMask {
  apiKey?: string | null
  cookie?: string | null
}

export interface Connector {
  id: string
  ownerId: string
  type: ConnectorType
  name: string
  enabled: boolean
  config: ConnectorConfig
  secretMasked: ConnectorSecretMask
  lastTestAt?: number | null
  lastTestOk?: boolean | null
  lastTestMessage?: string | null
  createdAt: number
  updatedAt: number
}

/** DeepSeek 网页搜索的结果条目 */
export interface ConnectorSearchResult {
  title: string
  url: string
  snippet: string
  summary: string
  siteName?: string | null
  siteIcon?: string | null
  date?: string | null
  score?: number | null
}

export interface BilibiliVideoInfo {
  bvid: string
  aid: number
  title: string
  description: string
  author: string
  authorAvatar?: string | null
  cover: string
  duration: number
  pubDate: number
  url: string
  /** 当前抓取的 P 序号（从 1 开始） */
  page: number
  /** 当前 P 的 cid，字幕必须按它取 */
  cid: number
  /** 当前分 P 的标题，单 P 视频为 null */
  partTitle?: string | null
}

export interface BilibiliComment {
  author: string
  content: string
  like: number
}

/** 抓取到的 B 站视频材料：总结与卡片共用；transcript 为空表示无字幕 */
export interface BilibiliVideoMaterial {
  video: BilibiliVideoInfo
  /** 总结缓存隔离键：单 P 为 bvid，多 P 为 bvid_c{cid} */
  cacheKey: string
  transcript: string
  comments: BilibiliComment[]
  /** 已缓存的 AI 总结，未生成时为 null */
  summary: string | null
  summaryModel?: string | null
  summaryUpdatedAt?: number | null
}

/** DeepSeek fetch 抓到的网页正文 */
export interface FetchedPage {
  url: string
  title: string
  content: string
}

/** 聊天链接卡片：B 站视频卡片或通用网页卡片 */
export interface LinkPreview {
  url: string
  kind: 'bilibili' | 'website'
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
  /** B 站卡片额外字段 */
  author?: string | null
  videoId?: string | null
  /** B 站卡片是否有缓存的总结 */
  hasSummary?: boolean
  fetchedAt: number
}
