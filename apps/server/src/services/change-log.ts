import type { DB } from '../db'
import { now } from '../util/clock'

export interface ChangeInput {
  entity: string
  entityId: string
  op: 'upsert' | 'delete'
  /** 会话域可见性：该会话的成员能拉到这条变更 */
  conversationId?: string | null
  /** 个人域可见性：只有该用户能拉到（好友、已读、设置等） */
  userId?: string | null
  /** 实体完整快照，客户端直接 upsert，无需实现 diff 合并 */
  payload: unknown
  actorId?: string | null
}

/**
 * 追加一条同步变更。必须在写入实体的同一个事务里调用，
 * 否则会出现「实体存在但客户端拉不到」或「客户端拉到不存在的实体」。
 */
export function writeChange(db: DB, input: ChangeInput): number {
  const info = db
    .prepare(
      `INSERT INTO sync_change_log (entity, entity_id, op, conversation_id, user_id, payload, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.entity,
      input.entityId,
      input.op,
      input.conversationId ?? null,
      input.userId ?? null,
      JSON.stringify(input.payload),
      input.actorId ?? null,
      now(),
    )
  return Number(info.lastInsertRowid)
}
