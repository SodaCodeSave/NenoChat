import type { CachePolicy, CachedFileKind, CachedFileMeta } from '@nenochat/shared/storage/types'
import {
  DEFAULT_CACHE_POLICY,
  normalizeCachePolicy,
  planCacheEviction,
} from '@nenochat/shared/storage/cache-policy'
import { getBaseUrl, resolveFileUrl } from '@/api/http'

/**
 * 附件本地缓存。
 *
 * 服务端 /files 是公开静态资源，离线时不能依赖网络，因此把图片与文件落到
 * IndexedDB（桌面 WebView 与浏览器都支持），并记录大小、写入/访问时间用于
 * 统计和 LRU 淘汰。blob 与元数据分两个 store 存，启动时只读元数据，避免
 * 一次把上百兆内容全读进内存。
 */

const DB_NAME = 'nenochat-file-cache'
const DB_VERSION = 1
const ENTRY_STORE = 'entries'
const BLOB_STORE = 'blobs'
const POLICY_KEY = 'nenochat.attachmentCache.policy'

/** 单个文件超过这个大小不做缓存，避免一个大视频把空间瞬间吃满 */
const MAX_SINGLE_BYTES = 32 * 1024 * 1024
/** 访问时间写回节流：同一文件 1 分钟内重复渲染不重复写库 */
const TOUCH_INTERVAL_MS = 60_000
/** 内存里 blob URL 的上限：超出的按 LRU 撤销，IndexedDB 里的 blob 还在，重读很便宜 */
const MAX_OBJECT_URLS = 100

interface CacheEntry extends CachedFileMeta {}

const metaIndex = new Map<string, CacheEntry>()
const objectUrls = new Map<string, string>()
const pendingFetches = new Map<string, Promise<void>>()

let dbPromise: Promise<IDBDatabase | null> | null = null
let initPromise: Promise<void> | null = null
let totalBytes = 0

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      console.error('[file-cache] 打开缓存库失败', e)
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ENTRY_STORE)) {
        db.createObjectStore(ENTRY_STORE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      console.error('[file-cache] 打开缓存库失败', request.error)
      resolve(null)
    }
  })
  return dbPromise
}

function currentNamespace(): string {
  return getBaseUrl() || 'local'
}

function normalizePath(raw: string): string {
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname
    } catch {
      return raw
    }
  }
  return raw.startsWith('/') ? raw : `/${raw}`
}

function cacheKey(namespace: string, path: string): string {
  return `${namespace}::${path}`
}

function keyFor(rawUrl: string): string {
  return cacheKey(currentNamespace(), normalizePath(rawUrl))
}

/** 读取策略；localStorage 与主题设置走同一套本地设置路径 */
export function getCachePolicy(): CachePolicy {
  try {
    const raw = localStorage.getItem(POLICY_KEY)
    if (!raw) return { ...DEFAULT_CACHE_POLICY }
    return normalizeCachePolicy(JSON.parse(raw) as Partial<CachePolicy>)
  } catch {
    return { ...DEFAULT_CACHE_POLICY }
  }
}

async function writeEntryMeta(entry: CacheEntry): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(ENTRY_STORE, 'readwrite')
    tx.objectStore(ENTRY_STORE).put(entry)
    await txDone(tx)
  } catch (e) {
    console.error('[file-cache] 写入缓存元数据失败', e)
  }
}

function touch(key: string): void {
  const entry = metaIndex.get(key)
  if (!entry) return
  const now = Date.now()
  if (now - entry.accessedAt < TOUCH_INTERVAL_MS) return
  entry.accessedAt = now
  void writeEntryMeta(entry)
}

/** 记录新创建的 blob URL；超过容量时撤销并丢弃最老的条目（Map 迭代按插入序，天然是 LRU） */
function rememberObjectUrl(key: string, url: string): void {
  objectUrls.set(key, url)
  while (objectUrls.size > MAX_OBJECT_URLS) {
    const oldest = objectUrls.keys().next().value
    if (oldest === undefined || oldest === key) break
    const stale = objectUrls.get(oldest)
    objectUrls.delete(oldest)
    if (stale) URL.revokeObjectURL(stale)
  }
}

async function deleteEntry(key: string): Promise<void> {
  const entry = metaIndex.get(key)
  if (entry) {
    totalBytes -= entry.size
    metaIndex.delete(key)
  }
  const objectUrl = objectUrls.get(key)
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrls.delete(key)
  }
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction([ENTRY_STORE, BLOB_STORE], 'readwrite')
    tx.objectStore(ENTRY_STORE).delete(key)
    tx.objectStore(BLOB_STORE).delete(key)
    await txDone(tx)
  } catch (e) {
    console.error('[file-cache] 删除缓存失败', e)
  }
}

async function putEntry(entry: CacheEntry, blob: Blob): Promise<void> {
  const db = await openDb()
  if (!db) return
  const tx = db.transaction([ENTRY_STORE, BLOB_STORE], 'readwrite')
  tx.objectStore(ENTRY_STORE).put(entry)
  tx.objectStore(BLOB_STORE).put(blob, entry.key)
  await txDone(tx)
  metaIndex.set(entry.key, entry)
  totalBytes += entry.size
}

async function readBlob(key: string): Promise<Blob | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const tx = db.transaction(BLOB_STORE, 'readonly')
    const blob = await toPromise(tx.objectStore(BLOB_STORE).get(key) as IDBRequest<Blob | undefined>)
    return blob ?? null
  } catch (e) {
    console.error('[file-cache] 读取缓存失败', e)
    return null
  }
}

/** 按当前策略淘汰过期与超量条目，返回释放的字节数 */
async function enforcePolicy(): Promise<{ removed: number; freedBytes: number }> {
  const policy = getCachePolicy()
  const plan = planCacheEviction([...metaIndex.values()], policy)
  for (const key of plan.evict) {
    await deleteEntry(key)
  }
  return { removed: plan.evict.length, freedBytes: plan.freedBytes }
}

/** 初始化缓存索引；重复调用安全，浏览器没有 IndexedDB 时静默降级 */
export function initFileCache(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const db = await openDb()
    if (!db) {
      return
    }
    try {
      const tx = db.transaction(ENTRY_STORE, 'readonly')
      const entries = await toPromise(
        tx.objectStore(ENTRY_STORE).getAll() as IDBRequest<CacheEntry[]>,
      )
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string') continue
        metaIndex.set(entry.key, entry)
        totalBytes += Number.isFinite(entry.size) ? entry.size : 0
      }
    } catch (e) {
      console.error('[file-cache] 读取缓存索引失败', e)
    }
    await enforcePolicy()
  })()
  return initPromise
}

/** 供 UI 立即拿到已缓存地址；没有命中时返回 null，由调用方回退到网络地址 */
export async function cachedObjectUrl(rawUrl: string): Promise<string | null> {
  await initFileCache()
  if (!rawUrl) return null
  const key = keyFor(rawUrl)
  const existing = objectUrls.get(key)
  if (existing) {
    // 命中后重新插入刷新 LRU 位次
    objectUrls.delete(key)
    objectUrls.set(key, existing)
    touch(key)
    return existing
  }
  if (!metaIndex.has(key)) return null

  const blob = await readBlob(key)
  if (!blob) {
    await deleteEntry(key)
    return null
  }
  const url = URL.createObjectURL(blob)
  rememberObjectUrl(key, url)
  touch(key)
  return url
}

/**
 * 把附件落到本地缓存。命中索引直接返回；请求失败（离线）时静默放弃，
 * 下次渲染或联网时再补。
 */
export function ensureCached(rawUrl: string, kind: CachedFileKind): Promise<void> {
  const pending = pendingFetches.get(keyFor(rawUrl))
  if (pending) return pending

  const task = (async () => {
    await initFileCache()
    const namespace = currentNamespace()
    const path = normalizePath(rawUrl)
    const key = cacheKey(namespace, path)
    if (metaIndex.has(key)) {
      touch(key)
      return
    }

    const absolute = resolveFileUrl(rawUrl)
    if (!absolute) return

    try {
      const response = await fetch(absolute)
      if (!response.ok) return
      const blob = await response.blob()
      if (blob.size === 0 || blob.size > MAX_SINGLE_BYTES) return

      const now = Date.now()
      const entry: CacheEntry = {
        key,
        namespace,
        path,
        kind,
        size: blob.size,
        storedAt: now,
        accessedAt: now,
      }
      await putEntry(entry, blob)
      // 单文件写入后就检查一次，避免大文件叠加后长时间超限
      const policy = getCachePolicy()
      if (policy.maxBytes > 0 && totalBytes > policy.maxBytes) await enforcePolicy()
    } catch {
      // 离线 / 服务端 404：保留网络地址展示，不做缓存
    } finally {
      pendingFetches.delete(key)
    }
  })()

  pendingFetches.set(keyFor(rawUrl), task)
  return task
}

/** 解析附件展示地址：命中缓存优先用 blob URL，否则用网络地址并后台缓存 */
export async function resolveAttachmentUrl(
  rawUrl: string | null | undefined,
  kind: CachedFileKind,
): Promise<string | null> {
  if (!rawUrl) return null
  const network = resolveFileUrl(rawUrl)
  if (!network) return null

  const cached = await cachedObjectUrl(rawUrl)
  if (cached) return cached

  void ensureCached(rawUrl, kind)
  return network
}

export interface AttachmentCacheStats {
  entries: CachedFileMeta[]
  totalBytes: number
}

/** 缓存占用统计，可按命名空间过滤 */
export async function attachmentCacheStats(namespace?: string): Promise<AttachmentCacheStats> {
  await initFileCache()
  const entries = [...metaIndex.values()]
    .filter((entry) => !namespace || entry.namespace === namespace)
    .map((entry) => ({ ...entry }))
  const bytes = entries.reduce((sum, entry) => sum + (Number.isFinite(entry.size) ? entry.size : 0), 0)
  return { entries, totalBytes: bytes }
}

/** 保存策略并立即按新策略淘汰一次 */
export async function saveCachePolicy(policy: Partial<CachePolicy>): Promise<CachePolicy> {
  const normalized = normalizeCachePolicy(policy)
  try {
    localStorage.setItem(POLICY_KEY, JSON.stringify(normalized))
  } catch {
    /* 隐私模式下可能不可用 */
  }
  await initFileCache()
  await enforcePolicy()
  return normalized
}

/** 按需再执行一次过期/超量淘汰 */
export async function pruneAttachmentCache(): Promise<{ removed: number; freedBytes: number }> {
  await initFileCache()
  return enforcePolicy()
}

/** 清空缓存；可按类别或命名空间过滤 */
export async function clearAttachmentCache(filter: {
  kind?: CachedFileKind
  namespace?: string
} = {}): Promise<{ removed: number; freedBytes: number }> {
  await initFileCache()
  const targets = [...metaIndex.values()].filter(
    (entry) =>
      (!filter.kind || entry.kind === filter.kind) &&
      (!filter.namespace || entry.namespace === filter.namespace),
  )
  let freedBytes = 0
  for (const entry of targets) {
    freedBytes += entry.size
    await deleteEntry(entry.key)
  }
  return { removed: targets.length, freedBytes }
}
