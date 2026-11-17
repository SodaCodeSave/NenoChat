import { z } from 'zod'

export const CreateStickerPackSchema = z.object({
  name: z.string().trim().min(1, '分组名不能为空').max(40),
})

export const UpdateStickerPackSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    allowAi: z.boolean().optional(),
  })
  .refine((input) => input.name !== undefined || input.allowAi !== undefined, {
    message: '至少要改一项',
  })

export const CreateStickerSchema = z.object({
  packId: z.string().min(1),
  attachmentId: z.string().min(1),
  keywords: z.array(z.string().trim().min(1).max(24)).max(10).default([]),
})
export type CreateStickerInput = z.infer<typeof CreateStickerSchema>

export const UpdateStickerKeywordsSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(24)).max(10),
})

export const StickerKeywordQuerySchema = z.object({
  q: z.string().trim().max(24).optional(),
})

/** AstrBot 表情包 zip 导入结果 */
export interface StickerPackImportResult {
  pack: StickerPackWithStickers['pack']
  /** 成功入库的表情张数 */
  imported: number
  /** 跳过的张数（格式不支持、单张超限等） */
  skipped: number
  /** 被跳过文件的名字，最多前 20 条，便于用户排查 */
  failures: string[]
}

export interface StickerPackWithStickers {
  pack: {
    id: string
    ownerId?: string | null
    name: string
    kind: 'emoji' | 'image'
    /** 是否允许 AI 角色挑选这个包里的表情 */
    allowAi: boolean
    position: number
    createdAt: number
    updatedAt: number
  }
  stickers: Array<{
    id: string
    packId: string
    kind: 'unicode' | 'image' | 'gif'
    value?: string | null
    attachmentId?: string | null
    url?: string | null
    keywords: string[]
    position: number
    createdAt: number
    updatedAt: number
  }>
}
