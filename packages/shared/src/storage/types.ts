/** 存储与数据：服务端与桌面端共用的类型定义 */

export type StorageCategoryKey = 'messages' | 'images' | 'files' | 'stickers' | 'other'

/** 存储占用里的一个分类（消息、图片、文件、表情、其他） */
export interface StorageCategory {
  key: StorageCategoryKey
  label: string
  bytes: number
  items: number
}

export interface StorageReport {
  /** 本地镜像 + 附件缓存的总占用 */
  totalBytes: number
  /** 本地 SQLite 镜像占用 */
  mirrorBytes: number
  /** 附件缓存占用 */
  cacheBytes: number
  categories: StorageCategory[]
  generatedAt: number
}

/** 附件缓存中的文件类别，与消息附件 kind 对齐 */
export type CachedFileKind = 'image' | 'file' | 'sticker' | 'avatar'

/** 附件缓存的元信息。blob 本身由各端自行存储，这里只描述可统计、可淘汰的部分 */
export interface CachedFileMeta {
  /** 缓存键：命名空间 + 路径 */
  key: string
  /** 命名空间（服务器 baseUrl），不同服务器的同名路径互不影响 */
  namespace: string
  /** 相对路径，例如 /files/files/ab/cd/xxx.png */
  path: string
  kind: CachedFileKind
  size: number
  storedAt: number
  accessedAt: number
}

export interface CachePolicy {
  /** 缓存总大小上限（字节），0 表示不限制 */
  maxBytes: number
  /** 闲置多久后过期（毫秒），0 表示永不过期 */
  maxAgeMs: number
}

/** 本地镜像的可统计指标 */
export interface MirrorUsage {
  /** SQLite 文件实际占用（页数 × 页大小） */
  dbBytes: number
  /** 消息正文与 meta 的字节数 */
  messageBytes: number
  messageCount: number
  /** 会话、通知、草稿等其余记录数，用于「其他」分类 */
  otherCount: number
}

export interface CacheUsage {
  kind: CachedFileKind
  size: number
}

/* ------------------------------ 备份文件 ------------------------------ */

export type BackupValue = string | number | null

export interface BackupRow {
  [column: string]: BackupValue
}

export interface BackupServer {
  id: string
  name: string
  baseUrl: string
}

export interface BackupFile {
  format: 'nenochat.backup'
  version: number
  exportedAt: number
  appVersion?: string
  server: BackupServer
  /** 表名 → 行数据；只包含白名单内的表与列 */
  tables: Record<string, BackupRow[]>
  /** 客户端本地偏好（主题色等），与服务端无关 */
  preferences?: Record<string, string>
}

export interface BackupSummary {
  messages: number
  conversations: number
  members: number
  users: number
  notifications: number
  drafts: number
  totalRows: number
}
