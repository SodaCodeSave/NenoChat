import { z } from 'zod'

export const SkillCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(200).default(''),
  content: z.string().max(30000).default(''),
  enabled: z.boolean().optional(),
})

export const SkillPatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(200).optional(),
  content: z.string().max(30000).optional(),
  enabled: z.boolean().optional(),
})

export type SkillCreateInput = z.infer<typeof SkillCreateSchema>
export type SkillPatchInput = z.infer<typeof SkillPatchSchema>
