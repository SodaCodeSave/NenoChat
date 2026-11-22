import { API_PREFIX, type Skill } from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export interface SkillInput {
  name: string
  description?: string
  content?: string
  enabled?: boolean
}

export const skillApi = {
  list: () => http.get<{ skills: Skill[] }>(p('/skills')),
  create: (body: SkillInput) => http.post<{ skill: Skill }>(p('/skills'), body),
  update: (id: string, body: Partial<SkillInput>) =>
    http.patch<{ skill: Skill }>(p(`/skills/${id}`), body),
  remove: (id: string) => http.delete<{ ok: boolean }>(p(`/skills/${id}`)),
}
