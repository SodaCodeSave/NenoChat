import { API_PREFIX, type Post, type PostComment } from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export const postApi = {
  feed: (before?: number, limit = 20) =>
    http.get<{ posts: Post[]; hasMore: boolean }>(p('/posts'), { query: { before, limit } }),
  get: (id: string) => http.get<{ post: Post }>(p(`/posts/${id}`)),
  create: (body: { content: string; attachmentIds: string[]; visibility?: string; personaId?: string }) =>
    http.post<{ post: Post }>(p('/posts'), body),
  remove: (id: string) => http.delete<{ ok: boolean }>(p(`/posts/${id}`)),
  like: (id: string, liked: boolean) =>
    http.post<{ liked: boolean; likeCount: number }>(p(`/posts/${id}/like`), { liked }),
  comments: (id: string) => http.get<{ comments: PostComment[] }>(p(`/posts/${id}/comments`)),
  comment: (id: string, body: { content: string; replyToCommentId?: string | null; personaId?: string }) =>
    http.post<{ comment: PostComment }>(p(`/posts/${id}/comments`), body),
  removeComment: (id: string) =>
    http.delete<{ postId: string }>(p(`/comments/${id}`)),
}
