import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { env } from '../env'
import { runMigrations } from './migrate'

export type DB = Database.Database

let instance: DB | null = null

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
