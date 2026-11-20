import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { env } from '../env'
import { runMigrations } from './migrate'

export type DB = Database.Database
export type Statement = Database.Statement

let instance: DB | null = null

const stmtCache = new WeakMap<DB, Map<string, Statement>>()

/**
 * 预编译语句缓存：同一条 SQL 只解析编译一次。
 * 热路径上的查询频繁重复同构 SQL，直接复用语句对象可省去每次 prepare 的解析开销。
 */
export function stmt(db: DB, sql: string): Statement {
  let cache = stmtCache.get(db)
  if (!cache) {
    cache = new Map()
    stmtCache.set(db, cache)
  }
  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = db.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}

function ensureDataDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * 打开（或复用）服务端主库连接。
 * better-sqlite3 是同步 API，配合 WAL 后单连接足以承载自建服务器的并发量，
 * 同时让「发消息」这种多表写入能在一个事务里同步写完，不会出现 seq 空洞。
 */
export function getDb(): DB {
  if (instance) return instance

  ensureDataDir(env.DATA_DIR)
  const file = path.isAbsolute(env.DATA_DIR) ? env.DATA_DIR : path.resolve(process.cwd(), env.DATA_DIR)
  const dbPath = path.join(file, 'nenochat.db')

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456')
  // 页缓存调大到 64MB（负值表示以 KB 计），减少大库下的磁盘读
  db.pragma('cache_size = -65536')

  runMigrations(db)
  instance = db
  return db
}

export function closeDb(): void {
  instance?.close()
  instance = null
}

export function dataDir(): string {
  const dir = path.isAbsolute(env.DATA_DIR) ? env.DATA_DIR : path.resolve(process.cwd(), env.DATA_DIR)
  ensureDataDir(dir)
  return dir
}
