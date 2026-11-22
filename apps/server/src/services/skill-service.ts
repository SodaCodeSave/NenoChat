import type { ChatToolDef, Skill } from '@nenochat/shared'
import type { DB } from '../db'
import * as repo from '../db/repo/skills'
import { err } from '../util/errors'

export interface SkillCreatePayload {
  name: string
  description?: string
  content?: string
  enabled?: boolean
}

export interface SkillPatchPayload {
  name?: string
  description?: string
  content?: string
  enabled?: boolean
}

function toPublic(row: repo.SkillRow): Skill {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    content: row.content,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listSkills(db: DB, ownerId: string): Promise<Skill[]> {
  const rows = await repo.listSkills(db, ownerId)
  return rows.map(toPublic)
}

export async function findOwnedSkill(db: DB, ownerId: string, id: string): Promise<repo.SkillRow> {
  const row = await repo.findSkill(db, id)
  if (!row || row.owner_id !== ownerId) throw err.notFound('技能不存在')
  return row
}

export async function createSkill(db: DB, ownerId: string, input: SkillCreatePayload): Promise<Skill> {
  const row = await repo.createSkill(db, {
    ownerId,
    name: input.name,
    description: input.description ?? '',
    content: input.content ?? '',
    enabled: input.enabled ?? true,
  })
  return toPublic(row)
}

export async function updateSkill(db: DB, ownerId: string, id: string, patch: SkillPatchPayload): Promise<Skill> {
  await findOwnedSkill(db, ownerId, id)
  const row = await repo.updateSkill(db, id, patch)
  return toPublic(row)
}

export async function deleteSkill(db: DB, ownerId: string, id: string): Promise<void> {
  await findOwnedSkill(db, ownerId, id)
  await repo.softDeleteSkill(db, id)
}

/** 技能目录系统块：只给名字和一句话描述，正文留给 read_skill 按需取 */
export function renderSkillCatalog(skills: repo.SkillRow[]): string {
  const lines = skills.map((s) => `- ${s.name}：${s.description || '（无描述）'}`)
  return [
    '【可用技能】',
    '当用户的请求与下列技能相关时，先调用 read_skill 工具（name 参数填技能名）获取完整说明，再严格按说明执行；无关时不要调用。',
    ...lines,
  ].join('\n')
}

export const READ_SKILL_TOOL_DEF: ChatToolDef = {
  type: 'function',
  function: {
    name: 'read_skill',
    description: '读取一个技能的完整说明（Markdown）。调用前先看系统提示词里的【可用技能】目录。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称，必须与目录中列出的名称一致' },
      },
      required: ['name'],
    },
  },
}

/** 按名称解析启用中的技能，找不到返回 null（交由工具层以文本告知模型） */
export async function resolveSkillContent(db: DB, ownerId: string, name: string): Promise<string | null> {
  const skills = await repo.listEnabledSkills(db, ownerId)
  const wanted = name.trim()
  if (!wanted) return null
  const row =
    skills.find((s) => s.name === wanted) ??
    skills.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
  return row ? row.content : null
}
