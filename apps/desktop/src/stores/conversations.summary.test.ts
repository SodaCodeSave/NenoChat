import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ConversationSummary } from '@/api/endpoints'
import type { LastMessageSummary, Message } from '@nenochat/shared'

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }))

vi.mock('@/api/endpoints', () => ({
  conversationApi: {
    list: listMock,
    pin: vi.fn(),
    deleteForMe: vi.fn(),
  },
  messageApi: {
    markRead: vi.fn(),
  },
}))

vi.mock('@/platform/db', () => ({ hasLocalDb: () => true }))

vi.mock('@/db/dao/conversations', () => ({
  listConversations: vi.fn(),
  listLastMessageSummaries: vi.fn(),
  applyConversationSummaries: vi.fn(),
  patchConversationUnread: vi.fn(),
  upsertConversation: vi.fn(),
  deleteConversation: vi.fn(),
}))

vi.mock('@/stores/servers', () => ({
  useServersStore: () => ({ currentId: 'srv-1' }),
}))

import { listConversations, listLastMessageSummaries, applyConversationSummaries } from '@/db/dao/conversations'
import { useConversationsStore } from '@/stores/conversations'

function summaryOf(content: string, patch: Partial<LastMessageSummary> = {}): LastMessageSummary {
  return { senderId: 'u1', type: 'text', content, attachmentName: null, deleted: false, ...patch }
}

function makeConversation(id: string, patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    type: 'direct',
    name: null,
    messageCount: 1,
    partnerId: 'u1',
    partnerName: '张三',
    lastMessageId: `m-${id}`,
    lastMessageAt: 1000,
    createdAt: 0,
    updatedAt: 1000,
    ...patch,
  } as ConversationSummary
}

function makeMessage(conversationId: string, id: string, content: string): Message {
  const now = Date.now()
  return {
    id,
    conversationId,
    senderId: 'u2',
    senderType: 'user',
    type: 'text',
    content,
    meta: null,
    replyToId: null,
    seq: 1,
    clientNonce: null,
    createdAt: now,
    updatedAt: now,
    localStatus: 'synced',
  } as unknown as Message
}

/**
 * 侧边栏预览回归：启动时预览来自会话列表摘要（服务端下发 + 本地镜像推导），
 * 不应依赖消息桶是否预载——超过预载窗口的会话也要直接显示最后一条消息。
 */
describe('conversations store 列表摘要', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(listConversations).mockReset()
    vi.mocked(listLastMessageSummaries).mockReset()
    vi.mocked(applyConversationSummaries).mockReset()
    listMock.mockReset()
  })

  it('hydrate 用本地镜像摘要补齐预览，镜像没有的保持空', async () => {
    vi.mocked(listConversations).mockResolvedValue([makeConversation('c1'), makeConversation('c2')])
    vi.mocked(listLastMessageSummaries).mockResolvedValue(new Map([['c1', summaryOf('镜像里的预览')]]))

    const store = useConversationsStore()
    await store.hydrate()

    expect(store.items[0]?.lastMessageSummary?.content).toBe('镜像里的预览')
    expect(store.items[1]?.lastMessageSummary).toBeUndefined()
  })

  it('refresh 用服务端摘要替换缺失的镜像预览', async () => {
    vi.mocked(listConversations).mockResolvedValue([makeConversation('c1')])
    vi.mocked(listLastMessageSummaries).mockResolvedValue(new Map())
    listMock.mockResolvedValue({
      conversations: [makeConversation('c1', { lastMessageSummary: summaryOf('服务端预览') })],
    })

    const store = useConversationsStore()
    await store.hydrate()
    await store.refresh()

    expect(store.items[0]?.lastMessageSummary?.content).toBe('服务端预览')
  })

  it('列表与内存一致时跳过重写，镜像推导的预览保留', async () => {
    const mirrorSummary = summaryOf('镜像里的预览')
    vi.mocked(listConversations).mockResolvedValue([makeConversation('c1', { lastMessageSummary: mirrorSummary })])
    vi.mocked(listLastMessageSummaries).mockResolvedValue(new Map([['c1', mirrorSummary]]))
    // 服务端返回内容一致的摘要（不同对象引用，模拟 JSON 反序列化）
    listMock.mockResolvedValue({
      conversations: [makeConversation('c1', { lastMessageSummary: summaryOf('镜像里的预览') })],
    })

    const store = useConversationsStore()
    await store.hydrate()
    const before = store.items[0]
    await store.refresh()

    expect(store.items[0]).toBe(before)
    expect(applyConversationSummaries).not.toHaveBeenCalled()
  })

  it('noteLastMessage 更新最后一条摘要；noteUpdatedMessage 只更新末条', () => {
    const store = useConversationsStore()
    store.upsertLocal(makeConversation('c1', { lastMessageId: 'm-old' }))

    store.noteLastMessage(makeMessage('c1', 'm-new', '刚发的新消息'))
    const target = store.byId.get('c1')!
    expect(target.lastMessageId).toBe('m-new')
    expect(target.lastMessageSummary).toMatchObject({ content: '刚发的新消息', deleted: false })

    // 撤回末条 → 摘要标记已撤回
    store.noteUpdatedMessage({ ...makeMessage('c1', 'm-new', ''), deletedAt: Date.now() })
    expect(target.lastMessageSummary).toMatchObject({ deleted: true })

    // 非末条的消息更新不影响摘要
    store.noteUpdatedMessage(makeMessage('c1', 'm-old', '旧消息被编辑'))
    expect(target.lastMessageSummary).toMatchObject({ deleted: true })
  })
})
