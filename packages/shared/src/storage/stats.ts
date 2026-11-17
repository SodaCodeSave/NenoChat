import type {
  CacheUsage,
  CachedFileKind,
  MirrorUsage,
  StorageCategory,
  StorageCategoryKey,
  StorageReport,
} from './types'

const CATEGORY_LABELS: Record<StorageCategoryKey, string> = {
  messages: '消息',
  images: '图片',
  files: '文件',
  stickers: '表情',
  other: '其他（设置、索引）',
}

const CATEGORY_ORDER: StorageCategoryKey[] = ['messages', 'images', 'files', 'stickers', 'other']

/** 附件缓存类别归入哪个展示分类 */
const CACHE_CATEGORY: Record<CachedFileKind, StorageCategoryKey> = {
  image: 'images',
  avatar: 'images',
  file: 'files',
  sticker: 'stickers',
}

/** 人类可读的字节数，保留合适的精度 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (value < 1024) return `${Math.round(value)} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2
  return `${Number(size.toFixed(digits))} ${units[unit]}`
}

export interface BuildStorageReportInput {
  mirror: MirrorUsage
  cache: CacheUsage[]
  now?: number
}

/**
 * 汇总本地镜像与附件缓存的占用。
 *
 * 纯函数：输入是已经统计好的字节数，方便在两端复用与单测。
 * 「其他」用数据库总占用减去消息正文占用得到，避免逐表统计导致口径不一致。
 */
export function buildStorageReport(input: BuildStorageReportInput): StorageReport {
  const { mirror, cache } = input
  const now = input.now ?? Date.now()

  const bytes: Record<StorageCategoryKey, number> = {
    messages: Math.max(0, mirror.messageBytes),
    images: 0,
    files: 0,
    stickers: 0,
    other: 0,
  }
  const items: Record<StorageCategoryKey, number> = {
    messages: Math.max(0, mirror.messageCount),
    images: 0,
    files: 0,
    stickers: 0,
    other: Math.max(0, mirror.otherCount),
  }

  let cacheBytes = 0
  for (const entry of cache) {
    const size = Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0
    cacheBytes += size
    const category = CACHE_CATEGORY[entry.kind] ?? 'other'
    bytes[category] += size
    items[category] += 1
  }

  // dbBytes 可能拿不到（浏览器模式或 PRAGMA 不可用），此时至少把消息字节算进去
  const mirrorBytes = Math.max(0, mirror.dbBytes, mirror.messageBytes)
  bytes.other = Math.max(0, mirrorBytes - bytes.messages)

  const categories: StorageCategory[] = CATEGORY_ORDER.map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    bytes: bytes[key],
    items: items[key],
  }))

  return {
    totalBytes: mirrorBytes + cacheBytes,
    mirrorBytes,
    cacheBytes,
    categories,
    generatedAt: now,
  }
}
