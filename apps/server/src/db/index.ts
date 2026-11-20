import fs from 'node:fs'
import path from 'node:path'
import { Pool, PoolClient, types } from 'pg'
import { env } from '../env'
import { runMigrations } from './migrate'

export type Executor = Pool | PoolClient

/** 兼容别名：历史代码里的 DB 即 Executor（连接池或事务内客户端） */
export type DB = Executor

// pg 默认把 BIGINT（int8, oid 20）解析成字符串，这里改回 number；
// 时间戳、seq、计数器等 BIGINT 列的数值都在安全整数范围内
types.setTypeParser(20, (v) => Number(v))

let instance: Pool | null = null

/** 打开（或复用）服务端连接池 */
export function getDb(): Pool {
  if (instance) return instance

  instance = new Pool({
    // 建池时才取值：测试文件可能在 src 模块静态 import 之后才写入 DATABASE_URL
    connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  })
  return instance
}

export async function closeDb(): Promise<void> {
  if (!instance) return
  const pool = instance
  instance = null
  migrationsPromise = null
  await pool.end()
}

let migrationsPromise: Promise<void> | null = null

/** 打开连接池并执行迁移；幂等，启动流程调用一次即可 */
export async function initDb(): Promise<Pool> {
  const pool = getDb()
  if (!migrationsPromise) {
    migrationsPromise = runMigrations(pool)
  }
  await migrationsPromise
  return pool
}

export function dataDir(): string {
  // 取值延迟到调用时刻：测试文件可能在 src 模块静态 import 之后才写入 DATA_DIR
  const dir = path.isAbsolute(process.env.DATA_DIR ?? env.DATA_DIR)
    ? (process.env.DATA_DIR ?? env.DATA_DIR)
    : path.resolve(process.cwd(), process.env.DATA_DIR ?? env.DATA_DIR)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const pgSqlCache = new Map<string, string>()

/** SQLite 风格的 ? 占位符转成 PG 的 $n，转换结果缓存避免重复替换 */
function toPgSql(sql: string): string {
  let converted = pgSqlCache.get(sql)
  if (converted === undefined) {
    let index = 0
    converted = sql.replace(/\?/g, () => `$${++index}`)
    pgSqlCache.set(sql, converted)
  }
  return converted
}

export function all<T = Record<string, unknown>>(
  db: Executor,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.query(toPgSql(sql), params).then((r) => r.rows as T[])
}

export function one<T = Record<string, unknown>>(
  db: Executor,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return db.query(toPgSql(sql), params).then((r) => r.rows[0] as T | undefined)
}

export interface RunResult {
  changes: number
}

export function run(db: Executor, sql: string, params: unknown[] = []): Promise<RunResult> {
  return db.query(toPgSql(sql), params).then((r) => ({ changes: r.rowCount ?? 0 }))
}
