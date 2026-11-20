import fs from 'node:fs'
import path from 'node:path'
import type { Executor } from './index'
import { withTx } from './tx'

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations')

interface MigrationFile {
  version: string
  sql: string
}

function listMigrations(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      version: file.replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
    }))
}

/** 按文件名顺序执行未应用的迁移，每个文件一个事务 */
export async function runMigrations(db: Executor): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
  )`)

  const { rows } = await db.query('SELECT version FROM schema_migrations')
  const applied = new Set(rows.map((r) => (r as { version: string }).version))

  for (const migration of listMigrations()) {
    if (applied.has(migration.version)) continue
    await withTx(db, async (tx) => {
      // 无参数的多语句走简单查询协议，一个文件整体提交
      await tx.query(migration.sql)
      await tx.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        Date.now(),
      ])
    })
    console.log(`[db] applied migration ${migration.version}`)
  }
}
