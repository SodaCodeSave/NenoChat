#!/usr/bin/env node
/**
 * 历史数据迁移：把旧版 better-sqlite3 数据库整库搬到 PostgreSQL。
 *
 * 用法（在 apps/server 目录下）：
 *   node scripts/migrate-sqlite-to-pg.mjs \
 *     --sqlite ./data/nenochat.db \
 *     --pg postgres://nenochat:nenochat@localhost:5432/nenochat
 *
 * 流程：
 * 1. 对新库按序执行 src/db/migrations 下的全部迁移，确保 PG schema 就绪；
 * 2. 逐表读取 SQLite 全量行，按列名批量写入 PG（跳过 FTS 虚表与 schema_migrations）；
 * 3. 对自增列（sync_change_log.seq）重置 identity 序列到最大值。
 *
 * 幂等性：不做去重，重复执行会撞唯一键。建议只对空库执行一次。
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { Client } from 'pg'
import Database from 'better-sqlite3'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations')

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--sqlite') args.sqlite = argv[++i]
    else if (argv[i] === '--pg') args.pg = argv[++i]
  }
  return args
}

const args = parseArgs(process.argv)
const sqlitePath = path.resolve(args.sqlite ?? './data/nenochat.db')
const pgUrl = args.pg ?? process.env.DATABASE_URL

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite 数据库不存在: ${sqlitePath}`)
  process.exit(1)
}
if (!pgUrl) {
  console.error('缺少 --pg 参数或 DATABASE_URL 环境变量')
  process.exit(1)
}

console.log(`SQLite 源: ${sqlitePath}`)
console.log(`PG 目标: ${pgUrl.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@')}`)

const SKIP_TABLES = new Set(['schema_migrations', 'message_fts'])

/** 自增列清单：导入时排除该列，导完重置序列 */
const IDENTITY_COLUMNS = { sync_change_log: 'seq' }

async function runSchemaMigrations(pg) {
  await pg.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
  )`)
  const { rows } = await pg.query('SELECT version FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.version))
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const version = file.replace(/\.sql$/, '')
    if (applied.has(version)) continue
    await pg.query('BEGIN')
    try {
      await pg.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
      await pg.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        version,
        Date.now(),
      ])
      await pg.query('COMMIT')
      console.log(`[db] applied migration ${version}`)
    } catch (e) {
      await pg.query('ROLLBACK')
      throw new Error(`迁移 ${version} 失败: ${e.message}`)
    }
  }
}

/** SQLite 表清单（排除内部表与 FTS 虚表/影子表） */
function listTables(sqlite) {
  const rows = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
  return rows
    .map((r) => r.name)
    .filter((n) => !SKIP_TABLES.has(n) && !n.endsWith('_data') && !n.endsWith('_idx'))
}

const pg = new Client({ connectionString: pgUrl })
const sqlite = new Database(sqlitePath, { readonly: true })
sqlite.pragma('busy_timeout = 5000')

async function main() {
  await pg.connect()

  // 1. 确保 PG schema 就绪
  await runSchemaMigrations(pg)

  const tables = listTables(sqlite)
  let grandTotal = 0

  for (const table of tables) {
    const idCol = IDENTITY_COLUMNS[table]
    const sqliteCols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)

    const { rows: pgColumns } = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table],
    )
    if (pgColumns.length === 0) {
      console.log(`跳过（PG 中不存在表 ${table}）`)
      continue
    }
    const pgColSet = new Set(pgColumns.map((r) => r.column_name))

    const srcCols = sqliteCols.filter((c) => pgColSet.has(c) && c !== idCol)
    const rows = sqlite.prepare(`SELECT ${srcCols.join(', ')} FROM ${table}`).all()
    if (rows.length === 0) continue

    const placeholders = srcCols.map((_, i) => `$${i + 1}`).join(', ')
    const insertSql = `INSERT INTO ${table} (${srcCols.join(', ')}) VALUES (${placeholders})`

    await pg.query('BEGIN')
    try {
      for (const row of rows) {
        await pg.query(insertSql, srcCols.map((c) => row[c]))
      }
      await pg.query('COMMIT')
    } catch (e) {
      await pg.query('ROLLBACK')
      throw new Error(`导入表 ${table} 失败: ${e.message}`)
    }

    if (idCol) {
      const { rows: maxRows } = await pg.query(`SELECT COALESCE(MAX(${idCol}), 0) AS m FROM ${table}`)
      await pg.query(`SELECT setval(pg_get_serial_sequence('${table}', '${idCol}'), GREATEST($1, 1))`, [
        maxRows[0].m,
      ])
    }
    console.log(`导入 ${table}: ${rows.length} 行`)
    grandTotal += rows.length
  }

  console.log(`完成：${tables.length} 张表，共 ${grandTotal} 行`)
}

main()
  .catch((e) => {
    console.error('[fatal]', e)
    process.exit(1)
  })
  .finally(() => {
    sqlite.close()
    void pg.end()
  })
