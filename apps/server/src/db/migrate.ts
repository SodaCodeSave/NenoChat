import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './index'

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
export function runMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: string }).version),
  )

  for (const migration of listMigrations()) {
    if (applied.has(migration.version)) continue
    const apply = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      )
    })
    apply()
    console.log(`[db] applied migration ${migration.version}`)
  }
}
