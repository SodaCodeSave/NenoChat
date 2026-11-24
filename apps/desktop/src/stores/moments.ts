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
 * 兼容旧服务端/旧数据：likers 字段可能缺失，统一补齐成数组，
 * 避免视图层读 length 时报错。
 */
function normalizePost(post: Post): Post {
  return { ...post, likers: Array.isArray(post.likers) ? post.likers : [] }
}

/**
 * 动态空间状态。
 * 在线优先：首屏从服务端拉，之后由 WS 事件增量维护；
 * 不做本地 SQLite 镜像（动态是浏览型内容，不需要离线可写）。
 */
export const useMomentsStore = defineStore('moments', () => {
  const posts = ref<Post[]>([])
  const comments = ref<Record<string, PostComment[]>>({})
  const commentLoading = new Set<string>()
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
      const incoming = result.posts.map(normalizePost)
      posts.value = trimPosts(reset ? incoming : mergePosts(posts.value, incoming))
      hasMore.value = result.hasMore
      // 评论默认展开：信息流拿到帖子后就把评论区拉下来
      await Promise.all(incoming.map((post) => loadComments(post.id)))
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

  /** 从分享卡片跳回来时定位帖子：不在当前页就按 id 拉取后插进列表 */
  async function focus(postId: string): Promise<Post | null> {
    let post = posts.value.find((item) => item.id === postId) ?? null
    if (!post) {
      try {
        const result = await postApi.get(postId)
        const normalized = normalizePost(result.post)
        onCreated(normalized)
        post = normalized
      } catch (e) {
        error.value = e instanceof Error ? e.message : '动态已不存在'
        return null
      }
    }
    await loadComments(post.id)
    return post
  }

  function mergePosts(current: Post[], incoming: Post[]): Post[] {
    const map = new Map(current.map((post) => [post.id, post]))
    for (const post of incoming) {
      const existing = map.get(post.id)
      const incomingPost = normalizePost(post)
      map.set(post.id, existing ? { ...existing, ...incomingPost } : incomingPost)
    }
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async function publish(content: string, attachmentIds: string[]): Promise<Post> {
    publishing.value = true
    error.value = null
    try {
      const result = await postApi.create({ content, attachmentIds, visibility: 'friends' })
      const post = normalizePost(result.post)
      onCreated(post)
      return post
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
    // 始终改 store 里的对象：调用方可能拿着的是旧的快照，直接改它不会触发视图更新
    const index = posts.value.findIndex((item) => item.id === post.id)
    const target = index >= 0 ? posts.value[index]! : post
    const next = !target.likedByMe
    const previous = { liked: target.likedByMe, count: target.likeCount, likers: target.likers }
    target.likedByMe = next
    target.likeCount = Math.max(0, target.likeCount + (next ? 1 : -1))
    target.likers = Array.isArray(target.likers) ? target.likers : []

    try {
      const result = await postApi.like(post.id, next)
      target.likeCount = result.likeCount
      target.likedByMe = result.liked
      target.likers = Array.isArray(result.likers) ? result.likers : []
    } catch (e) {
      target.likedByMe = previous.liked
      target.likeCount = previous.count
      target.likers = Array.isArray(previous.likers) ? previous.likers : []
      error.value = e instanceof Error ? e.message : '点赞失败'
    }
  }

  async function loadComments(postId: string): Promise<void> {
    if (comments.value[postId] || commentLoading.has(postId)) return
    commentLoading.add(postId)
    try {
      const result = await postApi.comments(postId)
      comments.value[postId] = trimComments(result.comments)
      // 计数用全量长度而不是截断后的列表长度
      const post = posts.value.find((item) => item.id === postId)
      if (post) post.commentCount = result.comments.length
    } catch (e) {
      error.value = e instanceof Error ? e.message : '读取评论失败'
    } finally {
      commentLoading.delete(postId)
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
    void loadComments(post.id)
  }

  function onUpdated(post: Post): void {
    const index = posts.value.findIndex((item) => item.id === post.id)
    if (index === -1) {
      onCreated(post)
      return
    }
    // 保留本端的 likedByMe，服务端推来的快照是按事件接收者算的，可能属于别人
    const current = posts.value[index]!
    posts.value[index] = { ...current, ...normalizePost(post), likedByMe: current.likedByMe }
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
    likers: Post['likers']
  }): void {
    const post = posts.value.find((item) => item.id === payload.postId)
    if (!post) return
    post.likeCount = payload.likeCount
    post.likers = Array.isArray(payload.likers) ? payload.likers : []
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
    commentLoading.clear()
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
    focus,
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
