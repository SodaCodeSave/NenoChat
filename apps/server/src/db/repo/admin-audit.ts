import { ulid } from '@nenochat/shared'
import { all, one, run, type DB, type Executor } from '../index'
import { now } from '../../util/clock'

/**
 * 管理面板审计日志。管理路由里的每个写操作都应记一条：
 * 谁（actor_id）在什么时候对什么（target_type/target_id）做了什么（action）。
 */

export interface AuditEntryInput {
  actorId: string
  action: string
  targetType: string
  targetId?: string | null
  detail?: unknown
}

export interface AuditRow {
  id: string
  actor_id: string
  action: string
  target_type: string
  target_id: string | null
  detail: string | null
  created_at: number
}

export interface AdminAuditEntry {
  id: string
  actorId: string
  actorName: string | null
  action: string
  targetType: string
  targetId: string | null
  detail: unknown
  createdAt: number
}

export function mapEntry(row: AuditRow & { actor_name?: string | null }): AdminAuditEntry {
  // detail 列是 JSONB：pg 驱动直接返回对象；字符串只在极端直连场景出现，兼容 parse 一次
  let detail: unknown = null
  if (typeof row.detail === 'string') {
    try {
      detail = JSON.parse(row.detail)
    } catch {
      detail = null
    }
  } else if (row.detail !== null && row.detail !== undefined) {
    detail = row.detail
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name ?? null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail,
    createdAt: row.created_at,
  }
}

export async function insert(db: Executor, input: AuditEntryInput): Promise<void> {
  await run(
    db,
    `INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      input.actorId,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      now(),
    ],
  )
}

export async function listPage(
  db: DB,
  page: number,
  pageSize: number,
): Promise<{ items: AdminAuditEntry[]; total: number }> {
  const offset = (page - 1) * pageSize
  const rows = await all<AuditRow & { actor_name?: string | null }>(
    db,
    `SELECT a.*, u.display_name AS actor_name
       FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?`,
    [pageSize, offset],
  )
  const totalRow = await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM admin_audit_log')
  return { items: rows.map(mapEntry), total: totalRow?.c ?? 0 }
}
