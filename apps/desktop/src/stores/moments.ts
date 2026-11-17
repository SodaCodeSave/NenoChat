import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Post, PostComment } from '@nenochat/shared'
import { postApi } from '@/api/posts'

/** 内存里最多保留的动态条数：动态是浏览型内容，老帖子滚出去就好 */
const MAX_POSTS = 150
/** 每条帖子在内存里保留的评论上限：取最近一段，评论总数仍以服务端的 commentCount 为准 */
const MAX_COMMENTS_PER_POST = 30

/** 动态列表按 createdAt 倒序，直接截掉尾部最老的 */
function trimPosts(list: Post[]): Post[] {
  return list.length > MAX_POSTS ? list.slice(0, MAX_POSTS) : list
}

/** 评论按时间正序追加，保留最近的若干条 */
function trimComments(list: PostComment[]): PostComment[] {
  return list.length > MAX_COMMENTS_PER_POST ? list.slice(list.length - MAX_COMMENTS_PER_POST) : list
}

/**
 * 动态空间状态。
 * 在线优先：首屏从服务端拉，之后由 WS 事件增量维护；
 * 不做本地 SQLite 镜像（动态是浏览型内容，不需要离线可写）。
 */
export const useMomentsStore = defineStore('moments', () => {
  const posts = ref<Post[]>([])
  const comments = ref<Record<string, PostComment[]>>({})
  const loading = ref(false)
  const publishing = ref(false)
  const hasMore = ref(false)
  const error = ref<string | null>(null)

  const isEmpty = computed(() => !loading.value && posts.value.length === 0)

  async function load(reset = false): Promise<void> {
    if (loading.value) return
    loading.value = true
    error.value = null
    try {
      const result = await postApi.feed(reset ? undefined : posts.value[posts.value.length - 1]?.createdAt)
      posts.value = trimPosts(reset ? result.posts : mergePosts(posts.value, result.posts))
      hasMore.value = result.hasMore
    } catch (e) {
      error.value = e instanceof Error ? e.message : '读取动态失败'
    } finally {
      loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || loading.value) return
    await load(false)
  }

  function mergePosts(current: Post[], incoming: Post[]): Post[] {
    const map = new Map(current.map((post) => [post.id, post]))
    for (const post of incoming) {
      const existing = map.get(post.id)
      map.set(post.id, existing ? { ...existing, ...post } : post)
    }
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async function publish(content: string, attachmentIds: string[]): Promise<Post> {
    publishing.value = true
    error.value = null
    try {
      const result = await postApi.create({ content, attachmentIds, visibility: 'friends' })
      onCreated(result.post)
      return result.post
    } catch (e) {
      error.value = e instanceof Error ? e.message : '发布失败'
      throw e
    } finally {
      publishing.value = false
    }
  }

  async function remove(postId: string): Promise<void> {
    await postApi.remove(postId)
    onRemoved(postId)
  }

  /** 点赞先本地翻转，失败再回滚，避免每次点击都等网络 */
  async function toggleLike(post: Post): Promise<void> {
    const next = !post.likedByMe
    const previous = { liked: post.likedByMe, count: post.likeCount }
    post.likedByMe = next
    post.likeCount = Math.max(0, post.likeCount + (next ? 1 : -1))

    try {
      const result = await postApi.like(post.id, next)
      post.likeCount = result.likeCount
      post.likedByMe = result.liked
    } catch (e) {
      post.likedByMe = previous.liked
      post.likeCount = previous.count
      error.value = e instanceof Error ? e.message : '点赞失败'
    }
  }

  async function loadComments(postId: string): Promise<void> {
    if (comments.value[postId]) return
    try {
      const result = await postApi.comments(postId)
      comments.value[postId] = trimComments(result.comments)
      // 计数用全量长度而不是截断后的列表长度
      const post = posts.value.find((item) => item.id === postId)
      if (post) post.commentCount = result.comments.length
    } catch (e) {
      error.value = e instanceof Error ? e.message : '读取评论失败'
    }
  }

  async function addComment(postId: string, content: string): Promise<void> {
    const result = await postApi.comment(postId, { content })
    onCommentCreated(result.comment)
  }

  async function removeComment(postId: string, commentId: string): Promise<void> {
    await postApi.removeComment(commentId)
    onCommentRemoved(postId, commentId)
  }

  /* --------------------------- WS 事件入口 --------------------------- */

  function onCreated(post: Post): void {
    posts.value = trimPosts(mergePosts(posts.value, [post]))
  }

  function onUpdated(post: Post): void {
    const index = posts.value.findIndex((item) => item.id === post.id)
    if (index === -1) {
      onCreated(post)
      return
    }
    // 保留本端的 likedByMe，服务端推来的快照是按事件接收者算的，可能属于别人
    const current = posts.value[index]!
    posts.value[index] = { ...current, ...post, likedByMe: current.likedByMe }
  }

  function onRemoved(postId: string): void {
    posts.value = posts.value.filter((post) => post.id !== postId)
    delete comments.value[postId]
  }

  function onLikeChanged(payload: {
    postId: string
    userId: string
    liked: boolean
    likeCount: number
  }): void {
    const post = posts.value.find((item) => item.id === payload.postId)
    if (!post) return
    post.likeCount = payload.likeCount
  }

  function onCommentCreated(comment: PostComment): void {
    const post = posts.value.find((item) => item.id === comment.postId)
    const list = comments.value[comment.postId]

    if (list) {
      // 已经展开评论区：追加并只保留最近的若干条，同时避免 WS 回显造成重复
      if (!list.some((item) => item.id === comment.id)) {
        comments.value[comment.postId] = trimComments([...list, comment])
        // commentCount 以服务端推来的累计值为准，不被内存截断列表拉低
        if (post) post.commentCount = Math.max(post.commentCount, comments.value[comment.postId]!.length)
      }
      return
    }

    // 评论没展开时拿不到列表，只能按事件累加
    if (post) post.commentCount += 1
  }

  function onCommentRemoved(postId: string, commentId: string): void {
    const list = comments.value[postId]
    if (list) comments.value[postId] = list.filter((item) => item.id !== commentId)
    const post = posts.value.find((item) => item.id === postId)
    if (post) post.commentCount = Math.max(0, post.commentCount - (list ? 1 : 0))
  }

  function reset(): void {
    posts.value = []
    comments.value = {}
    hasMore.value = false
    error.value = null
  }

  return {
    posts,
    comments,
    loading,
    publishing,
    hasMore,
    error,
    isEmpty,
    load,
    loadMore,
    publish,
    remove,
    toggleLike,
    loadComments,
    addComment,
    removeComment,
    onCreated,
    onUpdated,
    onRemoved,
    onLikeChanged,
    onCommentCreated,
    onCommentRemoved,
    reset,
  }
})
