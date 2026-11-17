import {
  SEARCH_FTS_MIN_CHARS,
  type Conversation,
  type Message,
  type PublicUser,
  type SearchMessageHit,
  type SearchResponse,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as messagesRepo from '../db/repo/messages'
import * as conversationsRepo from '../db/repo/conversations'
import * as usersRepo from '../db/repo/users'

interface MessageHitRow extends messagesRepo.MessageRow {
  conversation_name: string | null
  conversation_type: string | null
  sender_name: string | null
}

/** FTS5 的查询串需要整体加引号，否则 - " * 等字符会被当成语法 */
function ftsQuery(keyword: string): string {
  return `"${keyword.replace(/"/g, '""')}"`
}

function searchMessages(
  db: DB,
  userId: string,
  keyword: string,
  limit: number,
  conversationId?: string,
): SearchMessageHit[] {
  const membership = `JOIN conversation_members cm
       ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.left_at IS NULL`

  const select = `SELECT m.*, c.name AS conversation_name, c.type AS conversation_type,
                         u.display_name AS sender_name
                  FROM %FROM%
                  JOIN conversations c ON c.id = m.conversation_id
                  LEFT JOIN users u ON u.id = m.sender_id
                  ${membership}
                  WHERE %WHERE%`

  const scopeFilter = conversationId ? ' AND m.conversation_id = ?' : ''
  const scopeParams = conversationId ? [conversationId] : []

  const rows = (() => {
    // trigram 分词要求 ≥3 个字符，短查询直接走 LIKE（小服务器数据量下足够）
    if ([...keyword].length >= SEARCH_FTS_MIN_CHARS) {
      const sql = select
        .replace('%FROM%', 'message_fts f JOIN messages m ON m.id = f.message_id')
        .replace(
          '%WHERE%',
          `message_fts MATCH ? AND m.deleted_at IS NULL AND c.deleted_at IS NULL${scopeFilter}`,
        )
      return db
        .prepare(`${sql} ORDER BY m.created_at DESC LIMIT ?`)
        .all(userId, ftsQuery(keyword), ...scopeParams, limit) as MessageHitRow[]
    }

    const like = `%${keyword.replace(/[%_]/g, '')}%`
    const sql = select
      .replace('%FROM%', 'messages m')
      .replace(
        '%WHERE%',
        `m.content LIKE ? AND m.deleted_at IS NULL AND c.deleted_at IS NULL${scopeFilter}`,
      )
    return db
      .prepare(`${sql} ORDER BY m.created_at DESC LIMIT ?`)
      .all(userId, like, ...scopeParams, limit) as MessageHitRow[]
  })()

  return rows.map((row) => ({
    message: messagesRepo.mapMessage(row),
    conversationId: row.conversation_id,
    conversationName: row.conversation_name,
    conversationType: row.conversation_type,
    senderName: row.sender_name,
  }))
}

function searchUsers(db: DB, userId: string, keyword: string, limit: number): PublicUser[] {
  return usersRepo.search(db, keyword, userId, limit).map(usersRepo.mapPublicUser)
}

function searchConversations(db: DB, userId: string, keyword: string, limit: number): Conversation[] {
  const like = `%${keyword.replace(/[%_]/g, '')}%`
  const rows = db
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
       WHERE c.deleted_at IS NULL AND c.name IS NOT NULL AND c.name LIKE ?
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(userId, like, limit) as conversationsRepo.ConversationRow[]

  return rows.map(conversationsRepo.mapConversation)
}

export function search(
  db: DB,
  userId: string,
  query: { q: string; scope: 'all' | 'messages' | 'users' | 'conversations'; conversationId?: string; limit: number },
): SearchResponse {
  const keyword = query.q.trim()
  const limit = query.limit
  const wantMessages = query.scope === 'all' || query.scope === 'messages'
  const wantUsers = query.scope === 'all' || query.scope === 'users'
  const wantConversations = query.scope === 'all' || query.scope === 'conversations'

  return {
    query: keyword,
    messages: wantMessages
      ? searchMessages(db, userId, keyword, limit, query.conversationId)
      : [],
    users: wantUsers ? searchUsers(db, userId, keyword, limit) : [],
    conversations: wantConversations ? searchConversations(db, userId, keyword, limit) : [],
  }
}
