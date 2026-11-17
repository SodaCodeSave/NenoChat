import { z } from 'zod'
import { ConversationType, NotificationLevel, Role } from '../enums'

export const CreateConversationSchema = z.object({
  type: z.enum([ConversationType.Direct, ConversationType.Group, ConversationType.Ai]),
  /** direct 时为目标用户 id */
  targetUserId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(64).optional(),
  memberIds: z.array(z.string().min(1)).max(200).optional(),
  avatarUrl: z.string().max(512).nullable().optional(),
  /** ai 时使用 */
  personaId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
})
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>

export const UpdateConversationSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  avatarUrl: z.string().max(512).nullable().optional(),
  announcement: z.string().max(4000).nullable().optional(),
})

export const AddMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(200),
})

/** 转让群主：目标必须是当前群里的成员 */
export const TransferOwnerSchema = z.object({
  userId: z.string().min(1),
})

export const UpdateMemberSchema = z.object({
  role: z.enum([Role.Member, Role.Admin]).optional(),
  nickname: z.string().trim().max(32).nullable().optional(),
  allow: z.number().int().min(0).optional(),
  deny: z.number().int().min(0).optional(),
  muteUntil: z.number().int().nullable().optional(),
  notificationLevel: z.enum([
    NotificationLevel.All,
    NotificationLevel.Mentions,
    NotificationLevel.None,
  ]).nullable().optional(),
})

export const PinConversationSchema = z.object({
  pinned: z.boolean(),
})

export const CreateChannelSchema = z.object({
  name: z.string().trim().min(1).max(32),
  topic: z.string().max(1024).nullable().optional(),
  kind: z.enum(['text', 'announcement']).optional(),
  category: z.string().trim().max(32).nullable().optional(),
})

export const UpdateChannelSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  topic: z.string().max(1024).nullable().optional(),
  category: z.string().trim().max(32).nullable().optional(),
  position: z.number().int().min(0).optional(),
})

export const ReorderChannelsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        category: z.string().nullable(),
        position: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(200),
})
