import { z } from 'zod'
import { POST_PAGE_SIZE } from '../constants'

export const CreatePostSchema = z.object({
  content: z.string().trim().max(5000).default(''),
  attachmentIds: z.array(z.string().min(1)).max(9).default([]),
  visibility: z.enum(['public', 'friends', 'private']).default('friends'),
  /** 以 AI 角色的名义发布，必须是本人名下的角色 */
  personaId: z.string().min(1).optional(),
})
export type CreatePostInput = z.infer<typeof CreatePostSchema>

export const PostPageQuerySchema = z.object({
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(POST_PAGE_SIZE),
})

export const LikePostSchema = z.object({
  liked: z.boolean(),
})

export const CreateCommentSchema = z.object({
  content: z.string().trim().min(1).max(1000),
  replyToCommentId: z.string().min(1).nullable().optional(),
  /** 以 AI 角色的名义评论，必须是本人名下的角色 */
  personaId: z.string().min(1).optional(),
})
export type CreateCommentInput = z.infer<typeof CreateCommentSchema>
