/** REST 前缀 */
export const API_PREFIX = '/api/v1'

/** 服务端默认端口 */
export const DEFAULT_SERVER_PORT = 8787

/** 本地 SQLite 连接串，Tauri 的 preload 与 add_migrations 必须完全一致 */
export const LOCAL_DB_URL = 'sqlite:nenochat.db'

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
/** refresh token 有效期；0 表示永不过期，只有手动退出登录或管理员撤销设备才失效 */
export const REFRESH_TOKEN_TTL_MS = 0

export const MESSAGE_PAGE_SIZE = 50
export const MESSAGE_PAGE_MAX = 100
export const SYNC_BATCH_SIZE = 500
export const SYNC_CHANGE_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const WS_HEARTBEAT_MS = 25_000
export const WS_AUTH_TIMEOUT_MS = 5_000
export const TYPING_TTL_MS = 6_000
export const TYPING_THROTTLE_MS = 4_000

export const EDIT_WINDOW_MS = 5 * 60 * 1000
export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000

export const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024
/** 导入表情包 zip 的上限；图片本身已压缩，正常整包在这个量级 */
export const MAX_STICKER_PACK_BYTES = 300 * 1024 * 1024
/** 单次导入的表情张数上限，防止一个包塞进成千上万张小图 */
export const MAX_STICKER_PACK_FILES = 300
export const MAX_GROUP_MEMBERS_DEFAULT = 200
export const MAX_POST_IMAGES = 9
export const POST_PAGE_SIZE = 20

/** FTS5 trigram 分词要求查询串至少 3 个字符，短于这个长度回退到 LIKE */
export const SEARCH_FTS_MIN_CHARS = 3
export const SEARCH_DEFAULT_LIMIT = 20

export const PASSWORD_MIN_LENGTH = 8
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/

/** 上下文预算（token），超出即触发压缩或截断 */
export const AI_CONTEXT_BUDGET = {
  /** 人设提示词 + 角色卡 + 兴趣，长角色卡主要吃这一份预算 */
  system: 1600,
  /** 当天日程：全天安排 + 当前活动提示 */
  schedule: 500,
  facts: 400,
  summary: 500,
  recent: 3000,
} as const

/** 触发记忆压缩的阈值 */
export const MEMORY_COMPACT = {
  messagesSinceCompact: 20,
  contextTokens: 6000,
  staleDays: 7,
  minNewMessages: 7,
  batchMessages: 60,
} as const

/** 主动消息默认值 */
export const PROACTIVE_DEFAULTS = {
  minIdleHours: 6,
  maxPerDay: 1,
  /** 触发方式：idle = 空闲几小时后；chance = 按固定间隔掷概率找话题 */
  triggerMode: 'idle',
  /** chance 模式的掷骰间隔单位 */
  chanceUnit: 'hour',
  /** chance 模式每次掷骰的触发概率 */
  chanceProbability: 0.1,
  /** chance 模式两次主动消息之间的最小冷却（分钟） */
  chanceCooldownMinutes: 60,
  /** 主动消息按分钟扫描，chance 模式的最小间隔就是一分钟 */
  scanIntervalCron: '* * * * *',
} as const

/** 动态互动的默认配额与节流参数 */
export const MOMENT_AI_DEFAULTS = {
  /** 每个角色每天最多发几条动态 */
  postsPerDay: 1,
  /** 每个角色每天最多留几条评论 */
  commentsPerDay: 3,
  /** 每个角色每天最多点几个赞（用来表达「看过」） */
  likesPerDay: 3,
  /** 只对这段时间内发布的动态产生兴趣，太旧的不翻出来评论 */
  freshWindowMs: 3 * 24 * 60 * 60 * 1000,
  /** 发动态的活跃时段（本地小时，含头不含尾） */
  activeHourStart: 9,
  activeHourEnd: 23,
  scanIntervalCron: '*/10 * * * *',
} as const

/** 模型输出这个标记表示「这次没什么想说的」，服务端据此跳过不占配额 */
export const AI_SKIP_TOKEN = 'SKIP'

/** 群聊里 AI 成员的默认行为参数 */
export const GROUP_AI_DEFAULTS = {
  /** 每个角色在每个群里每天的插话上限 */
  repliesPerDay: 12,
  /** 每个角色在每个群里每天的主动开口上限 */
  autonomyPerDay: 1,
  /** 两次插话之间的最小间隔，避免跟着每条消息刷屏 */
  replyCooldownMs: 45_000,
  /** 两次主动开口之间的最小间隔 */
  autonomyCooldownMs: 6 * 60 * 60 * 1000,
  /** 群里安静多久之后才考虑主动开口 */
  autonomyIdleMs: 2 * 60 * 60 * 1000,
  /** 初始体力；插话消耗、休息恢复 */
  initialEnergy: 70,
  /** 每小时恢复的体力 */
  energyRecoveryPerHour: 6,
  /** 体力低于这个值就不再主动接话，除非被点名 */
  lowEnergyThreshold: 18,
  scanIntervalCron: '*/10 * * * *',
} as const

/** 客户端单会话在内存中保留的最大消息实体数，超出滚出即回读 SQLite */
export const MESSAGE_MEMORY_WINDOW = 300

/** 自动滚动的底部阈值 */
export const AUTOSCROLL_THRESHOLD_PX = 80
