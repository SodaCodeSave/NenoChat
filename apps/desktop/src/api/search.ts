import { API_PREFIX, type SearchResponse } from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export const searchApi = {
  query: (q: string, scope: 'all' | 'messages' | 'users' | 'conversations' = 'all', limit = 20) =>
    http.get<SearchResponse>(p('/search'), { query: { q, scope, limit } }),
}
