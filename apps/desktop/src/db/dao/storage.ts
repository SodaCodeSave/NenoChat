import type { BackupRow, MirrorUsage } from '@nenochat/shared/storage/types'
import { BACKUP_TABLES, sanitizeBackupRows } from '@nenochat/shared/storage/backup'
import { dbExecute, dbExecuteMany, dbSelect } from '@/platform/db'

/**
 * 本地镜像的统计、导出与恢复。
 * 所有读写都带 server_id，确保多服务器数据互不串台；
 * 浏览器模式下本地库不可用，这里全部退化为空结果。
 */

/** 通过页数 × 页大小拿 SQLite 文件的实际占用；PRAGMA 不可用时返回 0 */
async function readDbBytes(): Promise<number> {
  const pages = await dbSelect<{ page_count: number }>('PRAGMA page_count')
  const size = await dbSelect<{ page_size: number }>('PRAGMA page_size')
  const count = Number(pages[0]?.page_count ?? 0)
  const pageSize = Number(size[0]?.page_size ?? 0)
  return Number.isFinite(count * pageSize) ? count * pageSize : 0
}

/**
 * 统计本地镜像占用。
 * 数据库文件是按整个应用算的，所以这里也按全部服务器合计，
 * 否则「其他」分类会把别的服务器的数据也算进来，口径不一致。
 */
export async function collectMirrorUsage(): Promise<MirrorUsage> {
  const [messages, others, dbBytes] = await Promise.all([
    dbSelect<{ c: number; b: number }>(
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(LENGTH(content) + LENGTH(COALESCE(meta, ''))), 0) AS b
       FROM messages`,
    ),
    dbSelect<{ c: number }>(
      `SELECT
         (SELECT COUNT(*) FROM conversations) +
         (SELECT COUNT(*) FROM notifications) +
         (SELECT COUNT(*) FROM drafts) +
         (SELECT COUNT(*) FROM contacts) +
         (SELECT COUNT(*) FROM users) AS c`,
    ),
    readDbBytes(),
  ])

  return {
    dbBytes,
    messageBytes: Number(messages[0]?.b ?? 0),
    messageCount: Number(messages[0]?.c ?? 0),
    otherCount: Number(others[0]?.c ?? 0),
  }
}

/** 按备份白名单导出当前服务器的本地镜像表 */
export async function exportMirrorTables(serverId: string): Promise<Record<string, BackupRow[]>> {
  const tables: Record<string, BackupRow[]> = {}
  for (const [table, columns] of Object.entries(BACKUP_TABLES)) {
    const rows = await dbSelect<Record<string, unknown>>(
      `SELECT ${columns.join(', ')} FROM ${table} WHERE server_id = $1`,
      [serverId],
    )
    const sanitized = sanitizeBackupRows(table, rows)
    if (sanitized.length > 0) tables[table] = sanitized
  }
  return tables
}

/** 重建本地全文索引，导入后调用，避免备份缺失的 FTS 内容搜不到 */
export async function rebuildMessageIndex(serverId: string): Promise<number> {
  await dbExecute('DELETE FROM message_fts WHERE server_id = $1', [serverId])
  const rows = await dbSelect<{ id: string; conversation_id: string; content: string }>(
    `SELECT id, conversation_id, content FROM messages
     WHERE server_id = $1 AND deleted_at IS NULL AND TRIM(content) <> ''`,
    [serverId],
  )

  const chunk = 200
  for (let i = 0; i < rows.length; i += chunk) {
    await dbExecuteMany(
      rows.slice(i, i + chunk).map((row) => ({
        sql: 'INSERT INTO message_fts (message_id, server_id, conversation_id, content) VALUES ($1,$2,$3,$4)',
        params: [row.id, serverId, row.conversation_id, row.content],
      })),
    )
  }
  return rows.length
}

export interface ImportMirrorResult {
  tables: number
  rows: number
}

/**
 * 把备份行写回本地镜像。
 * replace=true 时先清掉目标服务器在这些表里的旧数据，保证「恢复」而不是「合并」；
 * 表名与列名都来自共享白名单，避免备份文件注入任意 SQL。
 */
export async function importMirrorTables(
  serverId: string,
  tables: Record<string, BackupRow[]>,
  options: { replace?: boolean } = {},
): Promise<ImportMirrorResult> {
  let tableCount = 0
  let rowCount = 0

  for (const [table, allowedColumns] of Object.entries(BACKUP_TABLES)) {
    const incoming = sanitizeBackupRows(table, tables[table])
    if (incoming.length === 0) continue

    if (options.replace) {
      await dbExecute(`DELETE FROM ${table} WHERE server_id = $1`, [serverId])
    }

    const statements: Array<{ sql: string; params: unknown[] }> = []
    for (const row of incoming) {
      const columns = Object.keys(row).filter((column) => allowedColumns.includes(column))
      if (!columns.includes('server_id')) continue
      const values = columns.map((column) => (column === 'server_id' ? serverId : row[column] ?? null))
      statements.push({
        sql: `INSERT OR REPLACE INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')})
              VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        params: values,
      })
    }

    if (statements.length > 0) {
      await dbExecuteMany(statements)
      tableCount += 1
      rowCount += statements.length
    }
  }

  // 备份里没有同步游标，导入后从 0 重新对齐服务端变更，避免旧游标跳过数据
  await dbExecute(
    'UPDATE sync_state SET cursor = 0, catchup_done = 0 WHERE server_id = $1',
    [serverId],
  )
  await rebuildMessageIndex(serverId)
  return { tables: tableCount, rows: rowCount }
}

/**
 * 清空当前服务器的消息镜像并重置同步游标，
 * 下次联网会按服务端变更日志重新补齐；服务端数据不受影响。
 */
export async function clearMessageMirror(serverId: string): Promise<void> {
  await dbExecute('DELETE FROM message_fts WHERE server_id = $1', [serverId])
  await dbExecute('DELETE FROM messages WHERE server_id = $1', [serverId])
  await dbExecute(
    'UPDATE sync_state SET cursor = 0, catchup_done = 0 WHERE server_id = $1',
    [serverId],
  )
}
