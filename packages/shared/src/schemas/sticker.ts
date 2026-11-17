import { z } from 'zod'

export const CreateStickerPackSchema = z.object({
  name: z.string().trim().min(1, '分组名不能为空').max(40),
})

export const UpdateStickerPackSchema = z.object({
  name: z.string().trim().min(1).max(40),
})

export const CreateStickerSchema = z.object({
  packId: z.string().min(1),
  attachmentId: z.string().min(1),
  keywords: z.array(z.string().trim().min(1).max(24)).max(10).default([]),
})
export type CreateStickerInput = z.infer<typeof CreateStickerSchema>

export const StickerKeywordQuerySchema = z.object({
  q: z.string().trim().max(24).optional(),
})

export interface StickerPackWithStickers {
  pack: {
    id: string
    ownerId?: string | null
    name: string
    kind: 'emoji' | 'image'
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
