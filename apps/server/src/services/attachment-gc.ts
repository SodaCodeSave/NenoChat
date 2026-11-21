import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DB } from '../db'
import { all, dataDir, run } from '../db'

/**
 * 服务端附件回收。
 *
 * 两条路径可能留下孤儿文件：
 * 1. 上传后从未被消息 / 动态 / 表情引用（attachments 行还在，但没人用）；
 * 2. 磁盘上有文件但库里没有对应行（写库失败、手工拷贝等）。
 * 这里统一按「引用集合」判定，并留出宽限期，避免和正在上传/发送的请求抢文件。
 */

export const ATTACHMENT_GC_DEFAULTS = {
  /** 附件行与文件都超过 24 小时无人引用才回收 */
  minAgeMs: 24 * 60 * 60 * 1000,
  /** 启动后的首次清理延迟，避开启动高峰 */
  initialDelayMs: 5 * 60 * 1000,
  intervalMs: 6 * 60 * 60 * 1000,
} as const

export interface StoredFile {
  /** 相对 files 根目录的路径，与 attachments.storage_key 一致 */
  storageKey: string
  size: number
  mtimeMs: number
}

export interface AttachmentGcResult {
  scannedFiles: number
  referencedKeys: number
  removedRows: number
  removedFiles: number
  freedBytes: number
}

/** 递归列出 files 根目录下的所有文件，忽略目录本身（异步版，不阻塞事件循环） */
export async function listStoredFiles(root: string): Promise<StoredFile[]> {
  const files: StoredFile[] = []

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fsp.stat(absolute)
        files.push({
          storageKey: path.relative(root, absolute).split(path.sep).join('/'),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch {
        /* 文件在扫描期间被删掉，跳过 */
      }
    }
  }

  await walk(root)
  return files
}

/**
 * 从相对 URL（/files/...）或绝对 URL 中提取 storage_key。
 * 不是文件地址时返回 null。
 */
export function extractStorageKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  const marker = '/files/'
  const index = raw.indexOf(marker)
  if (index < 0) return null
  const key = raw.slice(index + marker.length).split(/[?#]/)[0]
  return key && key.length > 0 ? key : null
}

/** 从消息 meta 里取出所有被引用的附件 storage_key */
export function extractMessageAttachmentKeys(metaJson: string | null | undefined): string[] {
  if (!metaJson) return []
  try {
    const meta = JSON.parse(metaJson) as {
      attachments?: Array<{ url?: string | null; thumbUrl?: string | null }>
    }
    const list = Array.isArray(meta.attachments) ? meta.attachments : []
    const keys: string[] = []
    for (const attachment of list) {
      const url = extractStorageKey(attachment?.url)
      const thumb = extractStorageKey(attachment?.thumbUrl)
      if (url) keys.push(url)
      if (thumb) keys.push(thumb)
    }
    return keys
  } catch {
    return []
  }
}

export function findOrphanFiles(
  files: StoredFile[],
  referenced: Set<string>,
  options: { now: number; minAgeMs: number },
): StoredFile[] {
  return files.filter(
    (file) =>
      !referenced.has(file.storageKey) && options.now - file.mtimeMs >= options.minAgeMs,
  )
}

function addKey(keys: Set<string>, value: unknown): void {
  const key = extractStorageKey(value)
  if (key) keys.add(key)
}

/** 每处理这么多行让出一次事件循环；行数多的扫描不再阻塞收发 */
const DB_SCAN_CHUNK = 500

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * 汇总数据库里所有仍然被引用的 storage_key。
 * 消息 meta 逐行 JSON.parse 很重，按 ctid 分批取、批间让出事件循环，
 * 大结果集不一次性进内存，也不长期占用单条查询。
 */
export async function collectReferencedKeys(db: DB): Promise<Set<string>> {
  const keys = new Set<string>()

  // 消息附件：attachments 行本身没有 message_id，只能以 meta 里的 URL 为准
  let cursor = '(0,0)'
  for (;;) {
    const rows = await all<{ rid: string; meta: string | null }>(
      db,
      `SELECT ctid AS rid, meta FROM messages
         WHERE ctid > ? AND meta LIKE '%"attachments"%'
         ORDER BY ctid LIMIT ?`,
      [cursor, DB_SCAN_CHUNK],
    )
    if (rows.length === 0) break
    cursor = rows[rows.length - 1]!.rid
    for (const row of rows) {
      for (const key of extractMessageAttachmentKeys(row.meta)) keys.add(key)
    }
    if (rows.length < DB_SCAN_CHUNK) break
    await yieldEventLoop()
  }

  // 头像、空间头图与角色卡直接存 URL
  const avatarRows = await all<{ url: string | null; banner: string | null }>(
    db,
    "SELECT avatar_url AS url, banner_url AS banner FROM users WHERE avatar_url LIKE '/files/%' OR banner_url LIKE '/files/%'",
  )
  for (const row of avatarRows) {
    addKey(keys, row.url)
    addKey(keys, row.banner)
  }

  // 用户设置的聊天背景图也是「URL 存在设置列里」的引用，漏扫会被 GC 当孤儿删掉
  const bgRows = await all<{ url: string | null }>(
    db,
    "SELECT chat_bg_url AS url FROM user_settings WHERE chat_bg_url LIKE '/files/%'",
  )
  for (const row of bgRows) addKey(keys, row.url)

  const personaRows = await all<{ avatar: string | null; card: string | null }>(
    db,
    `SELECT avatar_url AS avatar, card_url AS card FROM ai_personas
       WHERE avatar_url LIKE '/files/%' OR card_url LIKE '/files/%'`,
  )
  for (const row of personaRows) {
    addKey(keys, row.avatar)
    addKey(keys, row.card)
  }

  // 动态与表情通过 attachment_id 引用
  const linkedRows = await all<{ key: string | null; thumb: string | null }>(
    db,
    `SELECT a.storage_key AS key, a.thumb_key AS thumb FROM attachments a
       WHERE a.id IN (
         SELECT attachment_id FROM post_attachments
         UNION SELECT attachment_id FROM stickers WHERE attachment_id IS NOT NULL
       )`,
  )
  for (const row of linkedRows) {
    if (row.key) keys.add(row.key)
    if (row.thumb) keys.add(row.thumb)
  }

  return keys
}

async function removeEmptyDirs(root: string): Promise<void> {
  async function walk(dir: string): Promise<boolean> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!(await walk(path.join(dir, entry.name)))) empty = false
      } else {
        empty = false
      }
    }
    if (empty && dir !== root) {
      try {
        await fsp.rmdir(dir)
      } catch {
        return false
      }
    }
    return empty
  }
  await walk(root)
}

export interface ReclaimOptions {
  filesRoot?: string
  now?: number
  /** 文件与附件行的宽限期 */
  minAgeMs?: number
}

/**
 * 回收孤立附件：
 * 1. 删除长时间无人引用、且非最近创建的附件行；
 * 2. 删除磁盘上没有任何附件行指向、且超过宽限期的文件。
 */
export async function reclaimAttachments(
  db: DB,
  options: ReclaimOptions = {},
): Promise<AttachmentGcResult> {
  const root = options.filesRoot ?? path.join(dataDir(), 'files')
  const now = options.now ?? Date.now()
  const minAgeMs = options.minAgeMs ?? ATTACHMENT_GC_DEFAULTS.minAgeMs

  const referenced = await collectReferencedKeys(db)
  let removedRows = 0

  // 只删「确实没人引用」的附件行；创建时间在宽限期内的一律保留。
  // 附件行可能很多，按 ctid 分批取、批间让出事件循环；删除不影响 keyset 推进。
  let cursor = '(0,0)'
  for (;;) {
    const rows = await all<{
      rid: string
      id: string
      storage_key: string
      thumb_key: string | null
      created_at: number
    }>(
      db,
      `SELECT ctid AS rid, id, storage_key, thumb_key, created_at FROM attachments
         WHERE ctid > ? AND deleted_at IS NULL
         ORDER BY ctid LIMIT ?`,
      [cursor, DB_SCAN_CHUNK],
    )
    if (rows.length === 0) break
    cursor = rows[rows.length - 1]!.rid
    for (const row of rows) {
      if (referenced.has(row.storage_key)) continue
      if (row.thumb_key && referenced.has(row.thumb_key)) continue
      if (now - row.created_at < minAgeMs) continue
      await run(db, 'DELETE FROM attachments WHERE id = ?', [row.id])
      removedRows += 1
    }
    if (rows.length < DB_SCAN_CHUNK) break
    await yieldEventLoop()
  }

  // 删除附件行之后重新收集，共享同一 storage_key 的行仍能保护文件
  const surviving = new Set<string>()
  const survivors = await all<{ storage_key: string | null; thumb_key: string | null }>(
    db,
    'SELECT storage_key, thumb_key FROM attachments',
  )
  for (const row of survivors) {
    if (row.storage_key) surviving.add(row.storage_key)
    if (row.thumb_key) surviving.add(row.thumb_key)
  }

  const files = await listStoredFiles(root)
  const orphans = findOrphanFiles(files, surviving, { now, minAgeMs })
  let removedFiles = 0
  let freedBytes = 0

  for (const file of orphans) {
    try {
      await fsp.unlink(path.join(root, file.storageKey))
      removedFiles += 1
      freedBytes += file.size
    } catch {
      /* 已被其它进程删除或权限不足，跳过 */
    }
    if (removedFiles % DB_SCAN_CHUNK === 0) await yieldEventLoop()
  }

  if (removedFiles > 0) await removeEmptyDirs(root)

  return {
    scannedFiles: files.length,
    referencedKeys: referenced.size,
    removedRows,
    removedFiles,
    freedBytes,
  }
}

/** 启动定时回收；返回停止函数，随 Fastify 关闭一起清理 */
export function startAttachmentReclaimer(
  db: DB,
  options: Omit<ReclaimOptions, 'now'> & {
    initialDelayMs?: number
    intervalMs?: number
  } = {},
): () => void {
  const run = (): void => {
    void reclaimAttachments(db, options)
      .then((result) => {
        if (result.removedRows > 0 || result.removedFiles > 0) {
          console.log(
            `[attachment-gc] 回收 ${result.removedRows} 行、${result.removedFiles} 个文件，释放 ${result.freedBytes} 字节`,
          )
        }
      })
      .catch((e) => {
        console.error('[attachment-gc] 回收失败', e)
      })
  }

  const initial = setTimeout(run, options.initialDelayMs ?? ATTACHMENT_GC_DEFAULTS.initialDelayMs)
  const timer = setInterval(run, options.intervalMs ?? ATTACHMENT_GC_DEFAULTS.intervalMs)
  initial.unref()
  timer.unref()

  return () => {
    clearTimeout(initial)
    clearInterval(timer)
  }
}
