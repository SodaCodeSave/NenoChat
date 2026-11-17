import Database from '@tauri-apps/plugin-sql'
import { LOCAL_DB_URL } from '@nenochat/shared'
import { isTauri } from './device'

let handle: Database | null = null
let loading: Promise<Database | null> | null = null

/** 本地镜像库是否可用；浏览器模式下为 false，所有读写退化为直连服务端 */
export function hasLocalDb(): boolean {
  return isTauri()
}

/**
 * 打开本地库。连接串与 tauri.conf.json 的 plugins.sql.preload 必须一致，
 * 迁移由 Rust 侧在启动时执行完毕。
 */
export async function localDb(): Promise<Database | null> {
  if (!hasLocalDb()) return null
  if (handle) return handle
  if (!loading) {
    loading = Database.load(LOCAL_DB_URL)
      .then((db) => {
        handle = db
        return db
      })
      .catch((e) => {
        console.error('[db] 本地库打开失败', e)
        loading = null
        return null
      })
  }
  return loading
}

/** 查询。占位符是 $1/$2 风格，不是 ? */
export async function dbSelect<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = await localDb()
  if (!db) return []
  try {
    return (await db.select<T[]>(sql, params)) as T[]
  } catch (e) {
    console.error('[db] select 失败', sql, e)
    return []
  }
}

/** 写入。失败只记录日志，不阻断 UI —— 本地库是镜像，服务端才是权威 */
export async function dbExecute(sql: string, params: unknown[] = []): Promise<boolean> {
  const db = await localDb()
  if (!db) return false
  try {
    await db.execute(sql, params)
    return true
  } catch (e) {
    console.error('[db] execute 失败', sql, e)
    return false
  }
}

/** 顺序执行一组写语句，任一条失败即中止后续 */
export async function dbExecuteMany(statements: Array<{ sql: string; params: unknown[] }>): Promise<boolean> {
  const db = await localDb()
  if (!db) return false
  try {
    for (const statement of statements) {
      await db.execute(statement.sql, statement.params)
    }
    return true
  } catch (e) {
    console.error('[db] 批量写入失败', e)
    return false
  }
}

/**
 * 生成多行 VALUES 的占位符：参数编号在同一语句内全局递增
 * （2 列 3 行 → "($1,$2),($3,$4),($5,$6)"），供 DAO 层拼批量 upsert 语句。
 */
export function rowPlaceholders(rows: number, columns: number, offset = 0): string {
  const parts: string[] = []
  for (let row = 0; row < rows; row++) {
    const base = offset + row * columns
    const slots: string[] = []
    for (let i = 1; i <= columns; i++) slots.push(`$${base + i}`)
    parts.push(`(${slots.join(',')})`)
  }
  return parts.join(',')
}
