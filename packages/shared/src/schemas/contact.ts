import { z } from 'zod'

/** 发起好友申请；message 会展示给对方 */
export const FriendRequestSchema = z.object({
  userId: z.string().min(1),
  message: z.string().trim().max(120).optional(),
})

/** 备注名，空字符串表示清除 */
export const ContactAliasSchema = z.object({
  alias: z.string().trim().max(32).nullable().optional(),
})

/** 直接把别人的 AI 角色加进通讯录（仅限自己的角色） */
export const AddPersonaContactSchema = z.object({
  personaId: z.string().min(1),
})
