import type { DB } from './index'

/**
 * 在 IMMEDIATE 事务内执行同步逻辑。
 * IMMEDIATE 立即获取写锁，避免「先读后写」在并发下拿到过期快照。
 * 支持嵌套：better-sqlite3 会用 SAVEPOINT 处理。
 */
export function withTx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate()
}

/** 只读事务，用于需要一致快照的多表读取 */
export function withReadTx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).deferred()
}
