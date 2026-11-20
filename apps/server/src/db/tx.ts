import type { PoolClient } from 'pg'
import type { Executor } from './index'

function isClient(db: Executor): db is PoolClient {
  return typeof (db as PoolClient).release === 'function'
}

/**
 * 在事务内执行异步逻辑。传入 Pool 时自动取连接并 COMMIT/ROLLBACK；
 * 传入事务内的 PoolClient 时用 SAVEPOINT 支持嵌套。
 * 事务隔离级别保持默认 READ COMMITTED，「先读后写」由 UPDATE 行锁与唯一约束兜底。
 */
export async function withTx<T>(db: Executor, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  if (isClient(db)) {
    // 嵌套事务：外层事务客户端内开 SAVEPOINT，失败只回滚到检查点
    const savepoint = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${savepoint}`)
    try {
      const result = await fn(db)
      await db.query(`RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (e) {
      await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      throw e
    }
  }

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    try {
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
  } finally {
    client.release()
  }
}

/** 只读事务，用于需要一致快照的多表读取 */
export function withReadTx<T>(db: Executor, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  return withTx(db, fn)
}
