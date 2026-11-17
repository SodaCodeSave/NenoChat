import { z } from 'zod'
import type { Conversation, Message, PublicUser } from '../entities'

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1, '请输入搜索内容').max(120),
  scope: z.enum(['all', 'messages', 'users', 'conversations']).default('all'),
  conversationId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type SearchQuery = z.infer<typeof SearchQuerySchema>

export interface SearchMessageHit {
  message: Message
  conversationId: string
  conversationName?: string | null
  conversationType?: string | null
  senderName?: string | null
}

export interface SearchResponse {
  query: string
  messages: SearchMessageHit[]
  users: PublicUser[]
  conversations: Conversation[]
}
