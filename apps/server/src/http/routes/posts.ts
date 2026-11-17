import type { FastifyInstance } from 'fastify'
import { CreateCommentSchema, CreatePostSchema, LikePostSchema, PostPageQuerySchema } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import * as postService from '../../services/post-service'

/**
 * 动态空间（广场）。
 * 可见性目前按「全服可见」实现：自建服务器本身就是小圈子，
 * visibility 字段保留给后续的好友分组过滤。
 */
export async function postRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/posts', async (request) => {
    const userId = await requireUserId(request)
    const query = parse(PostPageQuerySchema, request.query)
    return postService.listFeed(db, userId, {
      before: query.before ?? null,
      limit: query.limit,
    })
  })

  app.post('/posts', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(CreatePostSchema, request.body)
    return { post: postService.createPost(db, userId, input) }
  })

  app.get<{ Params: { id: string } }>('/posts/:id', async (request) => {
    const userId = await requireUserId(request)
    return { post: postService.getPost(db, userId, request.params.id) }
  })

  app.delete<{ Params: { id: string } }>('/posts/:id', async (request) => {
    const userId = await requireUserId(request)
    postService.deletePost(db, userId, request.params.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/posts/:id/like', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(LikePostSchema, request.body)
    return postService.setLike(db, userId, request.params.id, input.liked)
  })

  app.get<{ Params: { id: string } }>('/posts/:id/comments', async (request) => {
    await requireUserId(request)
    return { comments: postService.listComments(db, request.params.id) }
  })

  app.post<{ Params: { id: string } }>('/posts/:id/comments', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(CreateCommentSchema, request.body)
    return { comment: postService.createComment(db, userId, request.params.id, input) }
  })

  app.delete<{ Params: { id: string } }>('/comments/:id', async (request) => {
    const userId = await requireUserId(request)
    return postService.deleteComment(db, userId, request.params.id)
  })
}
