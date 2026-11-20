import {
  SEARCH_FTS_MIN_CHARS,
  type Conversation,
  type Message,
  type PublicUser,
  type SearchMessageHit,
  type SearchResponse,
} from '@nenochat/shared'
import type { Executor } from '../db'
import { all } from '../db'
import * as messagesRepo from '../db/repo/messages'
import * as conversationsRepo from '../db/repo/conversations'
import * as usersRepo from '../db/repo/users'

interface MessageHitRow extends messagesRepo.MessageRow {
  conversation_name: string | null
  conversation_type: string | null
  sender_name: string | null
}

function searchMessages(
  db: Executor,
  userId: string,
  keyword: string,
  limit: number,
  conversationId?: string,
): Promise<SearchMessageHit[]> {
  const membership = `JOIN conversation_members cm
       ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.left_at IS NULL`

  const select = `SELECT m.*, c.name AS conversation_name, c.type AS conversation_type,
                         u.display_name AS sender_name
                  FROM messages m
                  JOIN conversations c ON c.id = m.conversation_id
                  LEFT JOIN users u ON u.id = m.sender_id
                  ${membership}
                  WHERE m.content ILIKE ? AND m.deleted_at IS NULL AND c.deleted_at IS NULL${scopeFilter(conversationId)}`

  const scopeParams = conversationId ? [conversationId] : []

  const rows = (async () => {
    const like = `%${keyword.replace(/[%_]/g, '')}%`

    // 全库短词搜索会退化成无索引扫描，只允许限定会话使用；
    // 常规长度（≥3 字符）走 pg_trgm GIN 索引加速的 ILIKE
    if ([...keyword].length < SEARCH_FTS_MIN_CHARS && !conversationId) return [] as MessageHitRow[]

    return all<MessageHitRow>(
      db,
      `${select} ORDER BY m.created_at DESC LIMIT ?`,
      [userId, like, ...scopeParams, limit],
    )
  })()

  return rows.then((rs) =>
    rs.map((row) => ({
      message: messagesRepo.mapMessage(row),
      conversationId: row.conversation_id,
      conversationName: row.conversation_name,
      conversationType: row.conversation_type,
      senderName: row.sender_name,
    })),
  )
}

function scopeFilter(conversationId?: string): string {
  return conversationId ? ' AND m.conversation_id = ?' : ''
}

async function searchUsers(db: Executor, userId: string, keyword: string, limit: number): Promise<PublicUser[]> {
  const rows = await usersRepo.search(db, keyword, userId, limit)
  return rows.map(usersRepo.mapPublicUser)
}

async function searchConversations(
  db: Executor,
  userId: string,
  keyword: string,
  limit: number,
): Promise<Conversation[]> {
  const like = `%${keyword.replace(/[%_]/g, '')}%`
  const rows = await all<conversationsRepo.ConversationRow>(
    db,
    `SELECT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
       WHERE c.deleted_at IS NULL AND c.name IS NOT NULL AND c.name ILIKE ?
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    [userId, like, limit],
  )

  return rows.map(conversationsRepo.mapConversation)
}

export async function search(
  db: Executor,
  userId: string,
  query: { q: string; scope: 'all' | 'messages' | 'users' | 'conversations'; conversationId?: string; limit: number },
): Promise<SearchResponse> {
  const keyword = query.q.trim()
  const limit = query.limit
  const wantMessages = query.scope === 'all' || query.scope === 'messages'
  const wantUsers = query.scope === 'all' || query.scope === 'users'
  const wantConversations = query.scope === 'all' || query.scope === 'conversations'

  return {
    query: keyword,
    messages: wantMessages
      ? await searchMessages(db, userId, keyword, limit, query.conversationId)
      : [],
    users: wantUsers ? await searchUsers(db, userId, keyword, limit) : [],
    conversations: wantConversations ? await searchConversations(db, userId, keyword, limit) : [],
  }
}
