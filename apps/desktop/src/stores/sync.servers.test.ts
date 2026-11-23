import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AiPersona, ChangeRecord } from '@nenochat/shared'

/** 当前服务器可变，用来模拟「切服后旧连接还在推事件」 */
const serverState = vi.hoisted(() => ({ id: 'srv-a' as string | null, store: null as any }))

const ws = vi.hoisted(() => {
  /** 订阅到的事件处理器，用来模拟「处理器已经卸掉但事件还在路上」 */
  const handlers = new Map<string, (payload: never) => void>()
  return {
    handlers,
    /** 每个事件订阅都要返回退订函数，disconnect 会逐个调用 */
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      handlers.set(event, handler)
      return () => {
        handlers.delete(event)
      }
    }),
    configure: vi.fn(),
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
  }
})

const aiStore = vi.hoisted(() => ({
  upsertLocal: vi.fn(),
  removeLocal: vi.fn(),
}))

const cursorDao = vi.hoisted(() => ({
  getCursor: vi.fn(async () => 0),
  setCursor: vi.fn(async () => undefined),
}))

vi.mock('@/realtime/ws-client', () => ({ wsClient: ws }))
vi.mock('@/platform/db', () => ({ hasLocalDb: () => true }))
vi.mock('@/db/dao/sync', () => cursorDao)
vi.mock('@/db/dao/ai', () => ({ upsertPersona: vi.fn(), deletePersona: vi.fn() }))
vi.mock('@/db/dao/users', () => ({ upsertUser: vi.fn() }))
vi.mock('@/db/dao/messages', () => ({ upsertMessagesBatched: vi.fn() }))
vi.mock('@/db/dao/conversations', () => ({
  markConversationsDeleted: vi.fn(),
  markMembersLeft: vi.fn(),
  upsertConversationsBatched: vi.fn(),
  upsertMembersBatched: vi.fn(),
}))

// 服务器 store 必须是响应式的：sync 里 serverId 是 computed，读普通对象不会跟着变
vi.mock('@/stores/servers', async () => {
  const { reactive } = await import('vue')
  const store = reactive({
    currentId: serverState.id,
    get current() {
      return { id: store.currentId, wsUrl: 'ws://example/ws' }
    },
  })
  serverState.store = store
  return { useServersStore: () => store }
})

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ devicePayload: () => ({ id: 'dev-1' }), accessToken: 'tok', user: { id: 'u-me' } }),
}))
vi.mock('@/stores/conversations', () => ({
  useConversationsStore: () => ({
    upsertLocal: vi.fn(),
    remove: vi.fn(),
    refresh: vi.fn(),
    bumpUnread: vi.fn(),
    noteLastMessage: vi.fn(),
    noteUpdatedMessage: vi.fn(),
    byId: new Map(),
  }),
}))
vi.mock('@/stores/messages', () => ({
  useMessagesStore: () => ({ mergeIncoming: vi.fn(), removeConversation: vi.fn(), flushOutbox: vi.fn() }),
}))
vi.mock('@/stores/members', () => ({
  useMembersStore: () => ({ upsertLocal: vi.fn(), removeLocal: vi.fn(), setOnline: vi.fn() }),
}))
vi.mock('@/stores/typing', () => ({ useTypingStore: () => ({ applyTyping: vi.fn() }) }))
vi.mock('@/stores/moments', () => ({ useMomentsStore: () => ({}) }))
vi.mock('@/stores/ai', () => ({ useAiStore: () => aiStore }))
vi.mock('@/stores/debug', () => ({ useDebugStore: () => ({}) }))
vi.mock('@/stores/contacts', () => ({ useContactsStore: () => ({ upsert: vi.fn() }) }))
vi.mock('@/stores/system-notifications', () => ({
  useSystemNotificationsStore: () => ({ onMessageCreated: vi.fn() }),
}))

import { useSyncStore } from '@/stores/sync'

function persona(id: string, name: string): AiPersona {
  return { id, name } as unknown as AiPersona
}

function personaChange(personaId: string, name: string): ChangeRecord {
  return {
    seq: 1,
    entity: 'ai_persona',
    entityId: personaId,
    op: 'upsert',
    conversationId: null,
    userId: null,
    payload: persona(personaId, name),
    createdAt: 1,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  serverState.store.currentId = 'srv-a'
  aiStore.upsertLocal.mockReset()
  aiStore.removeLocal.mockReset()
  cursorDao.setCursor.mockReset()
  ws.close.mockReset()
})

/**
 * 切服时 setCurrent 先改 currentId、随后才断连，
 * 这中间旧连接推来的角色增量不能写进新服务器的 store 与镜像。
 */
describe('sync 增量归属校验', () => {
  it('同一台服务器的角色增量正常应用', async () => {
    const sync = useSyncStore()
    await sync.connect()

    await sync.applyChanges([personaChange('p-a', '小雪')])

    expect(aiStore.upsertLocal).toHaveBeenCalledTimes(1)
  })

  it('切服后旧连接推来的角色增量被丢弃', async () => {
    const sync = useSyncStore()
    await sync.connect()

    serverState.store.currentId = 'srv-b'
    await sync.applyChanges([personaChange('p-a', '小雪')])

    expect(aiStore.upsertLocal).not.toHaveBeenCalled()
  })

  it('断线后旧连接推来的批次连游标都不再推进', async () => {
    const sync = useSyncStore()
    await sync.connect()
    // 事件已经派发出去了，处理器这时候才被卸掉
    const onBatch = ws.handlers.get('sync.batch')!
    sync.disconnect()

    onBatch({ changes: [personaChange('p-a', '小雪')], nextCursor: 42, hasMore: false } as never)
    await Promise.resolve()

    expect(aiStore.upsertLocal).not.toHaveBeenCalled()
    expect(cursorDao.setCursor).not.toHaveBeenCalled()
    expect(sync.cursor).toBe(0)
  })
})
