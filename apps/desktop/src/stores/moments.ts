import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Post, PostComment } from '@nenochat/shared'
import { postApi } from '@/api/posts'

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
      posts.value = reset ? result.posts : mergePosts(posts.value, result.posts)
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
      comments.value[postId] = result.comments
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
    posts.value = mergePosts(posts.value, [post])
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
      // 已经展开评论区：以列表长度为准，同时避免 WS 回显造成重复
      if (!list.some((item) => item.id === comment.id)) {
        comments.value[comment.postId] = [...list, comment]
        if (post) post.commentCount = comments.value[comment.postId]!.length
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
