import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Post, PostComment } from '@nenochat/shared'

const { feedMock, commentsMock, likeMock, getMock } = vi.hoisted(() => ({
  feedMock: vi.fn(),
  commentsMock: vi.fn(),
  likeMock: vi.fn(),
  getMock: vi.fn(),
}))

vi.mock('@/api/posts', () => ({
  postApi: {
    feed: feedMock,
    comments: commentsMock,
    like: likeMock,
    get: getMock,
  },
}))

const { useMomentsStore } = await import('@/stores/moments')

function makePost(id: string, overrides: Partial<Post> = {}): Post {
  const now = Date.now()
  return {
    id,
    authorId: 'u1',
    personaId: null,
    content: `动态 ${id}`,
    visibility: 'friends',
    likeCount: 0,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
    likers: [],
    author: { id: 'u1', username: 'alice', displayName: '爱丽丝', avatarUrl: null, bio: null },
    ...overrides,
  } as Post
}

function makeComment(id: string, postId: string): PostComment {
  const now = Date.now()
  return {
    id,
    postId,
    authorId: 'u2',
    personaId: null,
    content: `评论 ${id}`,
    createdAt: now,
    updatedAt: now,
    author: { id: 'u2', username: 'bob', displayName: '鲍勃', avatarUrl: null, bio: null },
  } as PostComment
}

describe('moments store 截图式信息流', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    feedMock.mockReset()
    commentsMock.mockReset()
    likeMock.mockReset()
    getMock.mockReset()
    commentsMock.mockResolvedValue({ comments: [] })
  })

  it('加载信息流时同步拉取评论，评论区默认展开', async () => {
    feedMock.mockResolvedValue({ posts: [makePost('p1')], hasMore: false })
    commentsMock.mockResolvedValue({ comments: [makeComment('c1', 'p1')] })

    const store = useMomentsStore()
    await store.load(true)

    expect(commentsMock).toHaveBeenCalledWith('p1')
    expect(store.comments.p1).toHaveLength(1)
    expect(store.posts[0]?.commentCount).toBe(1)
  })

  it('点赞成功后用服务端名单覆盖本地，失败时回滚', async () => {
    const post = makePost('p2')
    feedMock.mockResolvedValue({ posts: [post], hasMore: false })
    const store = useMomentsStore()
    await store.load(true)

    likeMock.mockResolvedValueOnce({ liked: true, likeCount: 1, likers: [{ id: 'u2', name: '鲍勃' }] })
    await store.toggleLike(post)
    expect(store.posts[0]?.likers.map((liker) => liker.name)).toEqual(['鲍勃'])

    likeMock.mockRejectedValueOnce(new Error('网络错误'))
    await store.toggleLike(post).catch(() => undefined)
    expect(store.posts[0]?.likedByMe).toBe(true)
    expect(store.posts[0]?.likers.map((liker) => liker.name)).toEqual(['鲍勃'])
  })

  it('WS 点赞事件同步点赞名单', () => {
    const store = useMomentsStore()
    const post = makePost('p3')
    store.onCreated(post)
    store.onLikeChanged({
      postId: 'p3',
      userId: 'u2',
      liked: true,
      likeCount: 1,
      likers: [{ id: 'u2', name: '鲍勃' }],
    })

    expect(store.posts.find((item) => item.id === 'p3')?.likers[0]?.name).toBe('鲍勃')
  })

  it('旧服务端不下发 likers 时补齐为空数组，避免视图读取 length 崩溃', async () => {
    const legacy = makePost('p5', { likers: undefined as unknown as Post['likers'] })
    feedMock.mockResolvedValue({ posts: [legacy], hasMore: false })
    const store = useMomentsStore()

    await store.load(true)

    expect(store.posts[0]?.likers).toEqual([])
    store.onLikeChanged({
      postId: 'p5',
      userId: 'u2',
      liked: true,
      likeCount: 1,
      likers: undefined as unknown as Post['likers'],
    })
    expect(store.posts[0]?.likers).toEqual([])
  })

  it('分享卡片跳转时按 id 拉取不在当前页的帖子', async () => {
    const target = makePost('p4')
    getMock.mockResolvedValue({ post: target })
    const store = useMomentsStore()

    const result = await store.focus('p4')

    expect(getMock).toHaveBeenCalledWith('p4')
    expect(result?.id).toBe('p4')
    expect(store.posts.some((post) => post.id === 'p4')).toBe(true)
  })
})
