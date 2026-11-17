import type { CreateCommentInput, CreatePostInput, Post, PostComment } from '@nenochat/shared'
import type { DB } from '../db'
import { withTx } from '../db/tx'
import * as postsRepo from '../db/repo/posts'
import * as aiRepo from '../db/repo/ai'
import * as momentRepo from '../db/repo/moment-ai'
import * as attachmentsRepo from '../db/repo/attachments'
import { err } from '../util/errors'
import { localDayKey, serverTzOffsetMinutes } from './proactive-rules'
import { hub } from '../ws/hub'
import {
  emitPostCommentCreated,
  emitPostCreated,
  emitPostRemoved,
  emitPostUpdated,
} from '../ws/emitter'

/** 动态是全服可见的广场，广播给所有在线用户 */
function onlineUsers(): string[] {
  return hub().onlineUserIds()
}

/** 以角色名义发布时必须确认这个角色是本人的，否则就是冒名 */
function assertPersonaOwned(db: DB, userId: string, personaId: string | undefined): void {
  if (!personaId) return
  const persona = aiRepo.findPersona(db, personaId)
  if (!persona || persona.owner_id !== userId) throw err.forbidden('只能使用自己的 AI 角色')
}

/**
 * 角色这次发布成功，把调度器预留的那条动作标成完成。
 * 预留不存在（例如客户端事件重放）时这里什么也不做。
 */
function settlePersonaAction(
  db: DB,
  personaId: string,
  kind: 'post' | 'comment',
  postId: string,
): void {
  momentRepo.markStatus(db, {
    personaId,
    kind,
    postId,
    dayKey: localDayKey(Date.now(), serverTzOffsetMinutes()),
    status: 'done',
  })
}

function assertAttachmentsOwned(db: DB, userId: string, ids: string[]): void {
  for (const id of ids) {
    const row = attachmentsRepo.findById(db, id)
    if (!row) throw err.validation('附件不存在或已删除')
    if (row.owner_id !== userId) throw err.forbidden('不能引用他人的附件')
    if (!row.mime.startsWith('image/')) throw err.validation('动态配图必须是图片')
  }
}

export function createPost(db: DB, userId: string, input: CreatePostInput): Post {
  if (input.content.trim().length === 0 && input.attachmentIds.length === 0) {
    throw err.validation('动态内容不能为空')
  }

  assertPersonaOwned(db, userId, input.personaId)
  assertAttachmentsOwned(db, userId, input.attachmentIds)

  const row = withTx(db, () =>
    postsRepo.create(db, {
      authorId: userId,
      personaId: input.personaId ?? null,
      content: input.content.trim(),
      visibility: input.visibility,
      attachmentIds: input.attachmentIds,
    }),
  )

  const post = postsRepo.loadOne(db, row.id, userId)
  if (!post) throw new Error('创建动态后回读失败')

  if (input.personaId) settlePersonaAction(db, input.personaId, 'post', '')

  emitPostCreated(onlineUsers(), post)
  return post
}

export function listFeed(
  db: DB,
  userId: string,
  query: { before?: number | null; limit: number },
): { posts: Post[]; hasMore: boolean } {
  // 多取一条用来判断是否还有下一页
  const rows = postsRepo.listFeed(db, userId, query.before ?? null, query.limit + 1)
  const hasMore = rows.length > query.limit
  return { posts: hasMore ? rows.slice(0, query.limit) : rows, hasMore }
}

export function getPost(db: DB, userId: string, postId: string): Post {
  const post = postsRepo.loadOne(db, postId, userId)
  if (!post) throw err.notFound('动态不存在')
  return post
}

export function deletePost(db: DB, userId: string, postId: string): void {
  const post = postsRepo.loadOne(db, postId, userId)
  if (!post) throw err.notFound('动态不存在')
  if (post.authorId !== userId) throw err.forbidden('只能删除自己的动态')

  withTx(db, () => postsRepo.softDelete(db, postId, Date.now()))
  emitPostRemoved(onlineUsers(), postId)
}

export function setLike(
  db: DB,
  userId: string,
  postId: string,
  liked: boolean,
): { liked: boolean; likeCount: number } {
  if (!postsRepo.loadOne(db, postId, userId)) throw err.notFound('动态不存在')

  const likeCount = withTx(db, () => postsRepo.setLike(db, postId, userId, liked))

  hub().sendToUsers(onlineUsers(), 'post.like.changed', {
    postId,
    userId,
    liked,
    likeCount,
  })

  return { liked, likeCount }
}

export function listComments(db: DB, postId: string): PostComment[] {
  return postsRepo.listComments(db, postId)
}

export function createComment(
  db: DB,
  userId: string,
  postId: string,
  input: CreateCommentInput,
): PostComment {
  const post = postsRepo.loadOne(db, postId, userId)
  if (!post) throw err.notFound('动态不存在')

  assertPersonaOwned(db, userId, input.personaId)

  if (input.replyToCommentId) {
    const target = postsRepo.findComment(db, input.replyToCommentId)
    if (!target || target.post_id !== postId) throw err.validation('被回复的评论不存在')
  }

  const row = withTx(db, () =>
    postsRepo.createComment(db, {
      postId,
      authorId: userId,
      personaId: input.personaId ?? null,
      content: input.content.trim(),
      replyToCommentId: input.replyToCommentId ?? null,
    }),
  )

  const comment = postsRepo
    .listComments(db, postId)
    .find((item) => item.id === row.id) ?? null
  if (!comment) throw new Error('创建评论后回读失败')

  if (input.personaId) settlePersonaAction(db, input.personaId, 'comment', postId)

  emitPostCommentCreated(onlineUsers(), comment)

  // 评论数变化要同步到关心这条动态的人
  const updated = postsRepo.loadOne(db, postId, userId)
  if (updated) emitPostUpdated([post.authorId, userId], updated)

  return comment
}

export function deleteComment(db: DB, userId: string, commentId: string): { postId: string } {
  const comment = postsRepo.findComment(db, commentId)
  if (!comment) throw err.notFound('评论不存在')

  const post = postsRepo.loadOne(db, comment.post_id, userId)
  if (!post) throw err.notFound('动态不存在')

  // 评论作者或动态作者都能删（后者用于管理自己的评论区）
  if (comment.author_id !== userId && post.authorId !== userId) {
    throw err.forbidden('只能删除自己的评论')
  }

  withTx(db, () => postsRepo.softDeleteComment(db, commentId, Date.now()))

  hub().sendToUsers(onlineUsers(), 'post.comment.removed', {
    postId: comment.post_id,
    commentId,
  })

  const updated = postsRepo.loadOne(db, comment.post_id, userId)
  if (updated) emitPostUpdated([post.authorId, userId], updated)

  return { postId: comment.post_id }
}
