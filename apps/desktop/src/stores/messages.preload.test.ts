import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@nenochat/shared'

const { pageMock } = vi.hoisted(() => ({ pageMock: vi.fn() }))

vi.mock('@/api/endpoints', () => ({
  messageApi: {
    page: pageMock,
  },
}))

vi.mock('@/platform/db', () => ({
  hasLocalDb: () => false,
}))

vi.mock('@/db/dao/messages', () => ({
  confirmPending: vi.fn(),
  deleteByNonce: vi.fn(),
  insertPending: vi.fn(),
  listMessages: vi.fn(),
  markFailed: vi.fn(),
  upsertMessage: vi.fn(),
}))

vi.mock('@/realtime/ws-client', () => ({
  wsClient: {
    isOnline: () => false,
    request: vi.fn(),
  },
}))

const { useMessagesStore } = await import('@/stores/messages')

function makeMessage(id: string, seq: number, content: string): Message {
  const now = Date.now()
  return {
    id,
    conversationId: 'c1',
    channelId: null,
    senderId: 'u1',
    senderType: 'user',
    type: 'text',
    content,
    meta: null,
    replyToId: null,
    seq,
    clientNonce: null,
    createdAt: now,
    updatedAt: now,
    localStatus: 'synced',
  } as unknown as Message
}

/**
 * 回归：bucket 首次创建时必须回读响应式代理，否则 loadInitial /
 * preload 的后续赋值不触发订阅方（侧边栏预览、消息列表）刷新。
 */
describe('messages store 预载与响应式', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    pageMock.mockReset()
  })

  it('预载完成后侧边栏预览应从「还没有消息」变为最近一条', async () => {
    const store = useMessagesStore()
    pageMock.mockResolvedValue({ messages: [makeMessage('m1', 1, 'hello')], hasMore: false })

    // 模拟侧边栏组件：先渲染一次，此时 bucket 还不存在
    const preview = computed(() => store.lastMessageOf('c1'))
    expect(preview.value).toBeNull()
    await nextTick()

    // 启动预载：bucket 在 loading 期间被创建，数据随后异步写入
    await store.loadInitial('c1')
    await nextTick()

    expect(preview.value?.id).toBe('m1')
    expect(preview.value?.content).toBe('hello')
  })

  it('preload 跳过已加载的会话，避免重复请求', async () => {
    const store = useMessagesStore()
    pageMock.mockResolvedValue({ messages: [], hasMore: false })

    await store.preload(['c1'])
    await store.preload(['c1', 'c2'])

    expect(pageMock).toHaveBeenCalledTimes(2)
  })

  it('preload 单个会话失败不影响其余会话', async () => {
    const store = useMessagesStore()
    pageMock.mockImplementation((conversationId: string) => {
      if (conversationId === 'bad') return Promise.reject(new Error('network'))
      return Promise.resolve({ messages: [], hasMore: false })
    })

    await expect(store.preload(['bad', 'good'])).resolves.toBeUndefined()
    expect(store.buckets['good']?.loaded).toBe(true)
  })
})
