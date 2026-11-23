import { beforeEach, describe, expect, it, vi } from 'vitest'

const stores = vi.hoisted(() => ({
  conversationsReset: vi.fn(),
  conversationsRefresh: vi.fn(async () => undefined),
  messagesReset: vi.fn(),
  membersReset: vi.fn(),
  contactsReset: vi.fn(),
  aiReset: vi.fn(),
  syncDisconnect: vi.fn(),
  syncReset: vi.fn(),
  hasLocalDb: vi.fn(() => true),
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ bootstrap: vi.fn(), bindServer: vi.fn() }) }))
vi.mock('@/stores/ai', () => ({ useAiStore: () => ({ reset: stores.aiReset, load: vi.fn() }) }))
vi.mock('@/stores/contacts', () => ({ useContactsStore: () => ({ reset: stores.contactsReset, load: vi.fn() }) }))
vi.mock('@/stores/conversations', () => ({
  useConversationsStore: () => ({
    reset: stores.conversationsReset,
    refresh: stores.conversationsRefresh,
    hydrate: vi.fn(),
    ordered: [],
  }),
}))
vi.mock('@/stores/members', () => ({ useMembersStore: () => ({ reset: stores.membersReset }) }))
vi.mock('@/stores/messages', () => ({ useMessagesStore: () => ({ reset: stores.messagesReset, preload: vi.fn() }) }))
vi.mock('@/stores/system-notifications', () => ({ useSystemNotificationsStore: () => ({ init: vi.fn() }) }))
vi.mock('@/stores/servers', () => ({
  useServersStore: () => ({ hydrate: vi.fn(), current: null, integrated: false }),
}))
vi.mock('@/stores/sync', () => ({
  useSyncStore: () => ({ connect: vi.fn(), disconnect: stores.syncDisconnect, reset: stores.syncReset }),
}))
vi.mock('@/platform/db', () => ({ hasLocalDb: stores.hasLocalDb }))
vi.mock('@/platform/file-cache', () => ({ initFileCache: vi.fn() }))

import { resetWorkspace } from '@/app/bootstrap'

beforeEach(() => {
  vi.clearAllMocks()
  stores.hasLocalDb.mockReturnValue(true)
})

/** 切服/登出必须清掉跟着服务器走的内存态，否则新服务器会看到旧服务器的角色 */
describe('resetWorkspace', () => {
  it('切换服务器时清空角色、服务商与互动设置', () => {
    resetWorkspace()
    expect(stores.aiReset).toHaveBeenCalledTimes(1)
  })

  it('同时清掉会话、成员、通讯录与实时连接', () => {
    resetWorkspace()
    expect(stores.conversationsReset).toHaveBeenCalledTimes(1)
    expect(stores.messagesReset).toHaveBeenCalledTimes(1)
    expect(stores.membersReset).toHaveBeenCalledTimes(1)
    expect(stores.contactsReset).toHaveBeenCalledTimes(1)
    expect(stores.syncDisconnect).toHaveBeenCalledTimes(1)
    expect(stores.syncReset).toHaveBeenCalledTimes(1)
  })
})
