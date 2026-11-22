import { ulid } from '@nenochat/shared'
import { all, one, run, type Executor } from '../index'
import { now } from '../../util/clock'

export interface SkillRow {
  id: string
  owner_id: string
  name: string
  description: string
  content: string
  enabled: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export async function listSkills(db: Executor, ownerId: string): Promise<SkillRow[]> {
  return all<SkillRow>(
    db,
    `SELECT * FROM skills
     WHERE owner_id = ? AND deleted_at IS NULL
     ORDER BY created_at`,
    [ownerId],
  )
}

export async function listEnabledSkills(db: Executor, ownerId: string): Promise<SkillRow[]> {
  return all<SkillRow>(
    db,
    `SELECT * FROM skills
     WHERE owner_id = ? AND enabled = 1 AND deleted_at IS NULL
     ORDER BY created_at`,
    [ownerId],
  )
}

export async function findSkill(db: Executor, id: string): Promise<SkillRow | undefined> {
  return one<SkillRow>(db, 'SELECT * FROM skills WHERE id = ? AND deleted_at IS NULL', [id])
}

export interface CreateSkillInput {
  ownerId: string
  name: string
  description: string
  content: string
  enabled: boolean
}

export async function createSkill(db: Executor, input: CreateSkillInput): Promise<SkillRow> {
  const ts = now()
  const id = ulid()
  const row = await one<SkillRow>(
    db,
    `INSERT INTO skills
       (id, owner_id, name, description, content, enabled, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     RETURNING *`,
    [id, input.ownerId, input.name, input.description, input.content, input.enabled ? 1 : 0, ts, ts],
  )
  if (!row) throw new Error('创建技能后回读失败')
  return row
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  content?: string
  enabled?: boolean
}

export async function updateSkill(db: Executor, id: string, patch: UpdateSkillInput): Promise<SkillRow> {
  const current = await findSkill(db, id)
  if (!current) throw new Error('技能不存在')

  const row = await one<SkillRow>(
    db,
    `UPDATE skills
     SET name = ?, description = ?, content = ?, enabled = ?, updated_at = ?
     WHERE id = ?
     RETURNING *`,
    [
      patch.name ?? current.name,
      patch.description ?? current.description,
      patch.content ?? current.content,
      patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
      now(),
      id,
    ],
  )
  if (!row) throw new Error('更新技能后回读失败')
  return row
}

export async function softDeleteSkill(db: Executor, id: string): Promise<void> {
  await run(db, 'UPDATE skills SET deleted_at = ?, updated_at = ? WHERE id = ?', [now(), now(), id])
}
