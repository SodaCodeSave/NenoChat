import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@nenochat/shared'

const { forwardMock } = vi.hoisted(() => ({ forwardMock: vi.fn() }))

vi.mock('@/api/endpoints', () => ({
  messageApi: {
    page: vi.fn(),
    forward: forwardMock,
  },
}))

vi.mock('@/platform/db', () => ({
  hasLocalDb: () => false,
}))

vi.mock('@/db/dao/messages', () => ({
  confirmPending: vi.fn(),
  deleteByNonce: vi.fn(),
  deleteConversationMessages: vi.fn(),
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

function makeMessage(id: string, conversationId: string, seq: number, content: string): Message {
  const now = Date.now()
  return {
    id,
    conversationId,
    senderId: 'u1',
    senderType: 'user',
    type: 'text',
    content,
    meta: { forwardedFrom: '某会话' },
    replyToId: null,
    seq,
    clientNonce: null,
    createdAt: now,
    updatedAt: now,
    localStatus: 'synced',
  } as unknown as Message
}

/**
 * 转发结果合并：REST 响应先进内存，自己的 WS message.created 随后到达，
 * 两路按 id 幂等合并，不能出现重复行。
 */
describe('messages store 批量转发', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    forwardMock.mockReset()
  })

  it('转发结果合并进目标会话并返回条数', async () => {
    const store = useMessagesStore()
    const forwarded = makeMessage('fwd-1', 'c2', 1, '转发来的消息')
    forwardMock.mockResolvedValue({
      results: [
        { conversationId: 'c2', messages: [forwarded, makeMessage('fwd-2', 'c2', 2, '第二条')] },
      ],
    })

    const count = await store.forwardMessages(['m1', 'm2'], ['c2'])

    expect(count).toBe(2)
    expect(forwardMock).toHaveBeenCalledWith(['m1', 'm2'], ['c2'])
    expect(store.messagesOf('c2').map((m) => m.id)).toEqual(['fwd-1', 'fwd-2'])
    expect(store.messagesOf('c2')[0]?.meta?.forwardedFrom).toBe('某会话')
  })

  it('WS 重复推送同一条转发消息不会显示两条', async () => {
    const store = useMessagesStore()
    const forwarded = makeMessage('fwd-1', 'c2', 1, '转发来的消息')
    forwardMock.mockResolvedValue({
      results: [{ conversationId: 'c2', messages: [forwarded] }],
    })

    await store.forwardMessages(['m1'], ['c2'])
    // 模拟随后到达的 message.created 广播（同 id 同内容）
    await store.applyCreated(forwarded)

    expect(store.messagesOf('c2')).toHaveLength(1)
  })

  it('多个目标会话各自拿到自己的消息', async () => {
    const store = useMessagesStore()
    forwardMock.mockResolvedValue({
      results: [
        { conversationId: 'c2', messages: [makeMessage('fwd-a', 'c2', 1, '到 c2')] },
        { conversationId: 'c3', messages: [makeMessage('fwd-b', 'c3', 1, '到 c3')] },
      ],
    })

    const count = await store.forwardMessages(['m1'], ['c2', 'c3'])

    expect(count).toBe(2)
    expect(store.messagesOf('c2').map((m) => m.id)).toEqual(['fwd-a'])
    expect(store.messagesOf('c3').map((m) => m.id)).toEqual(['fwd-b'])
  })
})
