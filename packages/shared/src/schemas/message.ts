import { z } from 'zod'
import { MESSAGE_PAGE_MAX, MESSAGE_PAGE_SIZE } from '../constants'
import { MessageType } from '../enums'

export const MessageMetaSchema = z
  .object({
    mentions: z.array(z.string()).max(50).optional(),
    mentionAll: z.boolean().optional(),
    attachments: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(['image', 'file', 'sticker', 'voice', 'avatar']),
          filename: z.string(),
          mime: z.string(),
          size: z.number(),
          width: z.number().nullable().optional(),
          height: z.number().nullable().optional(),
          duration: z.number().nullable().optional(),
          url: z.string(),
          thumbUrl: z.string().nullable().optional(),
          description: z.string().max(1000).nullable().optional(),
        }),
      )
      .max(9)
      .optional(),
    stickerId: z.string().optional(),
    emoji: z.string().optional(),
    clientNonce: z.string().optional(),
    replyTo: z
      .object({
        id: z.string().min(1),
        senderId: z.string().nullable().optional(),
        senderType: z.enum(['user', 'ai', 'system']).optional(),
        senderName: z.string().max(64),
        preview: z.string().max(200),
        type: z.enum(['text', 'image', 'file', 'sticker', 'voice', 'system']).optional(),
      })
      .optional(),
    forwardedFrom: z.string().max(120).optional(),
    momentCard: z
      .object({
        postId: z.string().min(1),
        authorName: z.string().max(64),
        authorAvatarUrl: z.string().max(500).nullable().optional(),
        excerpt: z.string().max(200).default(''),
        coverUrl: z.string().max(500).nullable().optional(),
      })
      .optional(),
  })

/** 批量转发：把若干条消息复制到若干个目标会话 */
export const ForwardMessagesSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(50),
  targetConversationIds: z.array(z.string().min(1)).min(1).max(10),
})
export type ForwardMessagesInput = z.infer<typeof ForwardMessagesSchema>

export const SendMessageSchema = z.object({
  conversationId: z.string().min(1),
  clientNonce: z.string().min(1).max(64),
  type: z
    .enum([MessageType.Text, MessageType.Image, MessageType.File, MessageType.Sticker, MessageType.Voice])
    .default(MessageType.Text),
  content: z.string().max(8000, '单条消息过长').default(''),
  meta: MessageMetaSchema.optional(),
  replyToId: z.string().min(1).nullable().optional(),
})
export type SendMessageInput = z.infer<typeof SendMessageSchema>

export const EditMessageSchema = z.object({
  content: z.string().min(1).max(8000),
})

export const PinMessageSchema = z.object({
  pinned: z.boolean(),
})

export const MarkReadSchema = z.object({
  messageSeq: z.number().int().min(0),
  messageId: z.string().min(1).nullable().optional(),
})

export const MessagePageQuerySchema = z.object({
  before: z.coerce.number().int().min(0).optional(),
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).default(MESSAGE_PAGE_SIZE),
})

export const TypingSchema = z.object({
  conversationId: z.string().min(1),
  state: z.enum(['start', 'stop']),
})
