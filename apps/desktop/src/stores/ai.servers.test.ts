import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AiPersona, AiProvider } from '@nenochat/shared'

/** 服务器 id 允许在用例中途切走，模拟「切换服务器」 */
const serverState = vi.hoisted(() => ({ currentId: 'srv-a' as string | null }))

const api = vi.hoisted(() => ({
  providers: vi.fn(),
  personas: vi.fn(),
  settings: vi.fn(),
  providerModels: vi.fn(),
}))

const dao = vi.hoisted(() => ({
  listPersonas: vi.fn(),
  upsertPersona: vi.fn(),
  prunePersonas: vi.fn(),
}))

vi.mock('@/api/ai', () => ({ aiApi: api }))

vi.mock('@/db/dao/ai', () => ({
  listPersonas: dao.listPersonas,
  upsertPersona: dao.upsertPersona,
  prunePersonas: dao.prunePersonas,
}))

vi.mock('@/platform/db', () => ({ hasLocalDb: () => true }))

vi.mock('@/stores/servers', () => ({
  useServersStore: () => serverState,
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({}) }))
vi.mock('@/stores/messages', () => ({ useMessagesStore: () => ({}) }))
vi.mock('@/stores/conversations', () => ({
  useConversationsStore: () => ({ byId: new Map() }),
}))

import { useAiStore } from '@/stores/ai'

function persona(id: string, name: string): AiPersona {
  return { id, name } as unknown as AiPersona
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function provider(id: string): AiProvider {
  return { id, isDefault: false } as unknown as AiProvider
}

beforeEach(() => {
  setActivePinia(createPinia())
  serverState.currentId = 'srv-a'
  api.providers.mockReset().mockResolvedValue({ providers: [] })
  api.personas.mockReset().mockResolvedValue({ personas: [] })
  api.settings.mockReset().mockResolvedValue({ settings: { proactiveEnabled: false } })
  api.providerModels.mockReset().mockResolvedValue({ models: [] })
  dao.listPersonas.mockReset().mockResolvedValue([])
  dao.upsertPersona.mockReset().mockResolvedValue(undefined)
  dao.prunePersonas.mockReset().mockResolvedValue(undefined)
})

/**
 * 幽灵角色回归：角色、服务商与互动设置都属于某一台服务器，
 * 切服后列表里不能再出现上一台服务器（或已删除）的角色。
 */
describe('ai store 跨服务器角色隔离', () => {
  it('切换服务器后角色列表换成新服务器的角色', async () => {
    const store = useAiStore()
    api.personas.mockResolvedValueOnce({ personas: [persona('p-a', '小雪')] })
    await store.load()
    expect(store.personas.map((p) => p.id)).toEqual(['p-a'])

    serverState.currentId = 'srv-b'
    api.personas.mockResolvedValueOnce({ personas: [persona('p-b', '阿岚')] })
    await store.load()

    expect(store.personas.map((p) => p.id)).toEqual(['p-b'])
    expect(store.personas.map((p) => p.name)).toEqual(['阿岚'])
  })

  it('切到没有角色的服务器时列表清空，不残留上一台服务器的角色', async () => {
    const store = useAiStore()
    api.personas.mockResolvedValueOnce({ personas: [persona('p-a', '小雪')] })
    await store.load()

    serverState.currentId = 'srv-b'
    api.personas.mockResolvedValueOnce({ personas: [] })
    await store.load()

    expect(store.personas).toEqual([])
    expect(store.loaded).toBe(true)
  })

  it('新服务器拉取失败时不保留上一台服务器的角色', async () => {
    const store = useAiStore()
    api.personas.mockResolvedValueOnce({ personas: [persona('p-a', '小雪')] })
    await store.load()

    serverState.currentId = 'srv-b'
    api.personas.mockRejectedValueOnce(new Error('网络不可用'))
    await store.load()

    expect(store.personas).toEqual([])
    // 没拉到就保持未加载状态，下次打开还会重试
    expect(store.loaded).toBe(false)
    expect(dao.listPersonas).toHaveBeenCalledWith('srv-b')
  })

  it('两个服务器有同名角色时只展示当前服务器那一个', async () => {
    const store = useAiStore()
    api.personas.mockResolvedValueOnce({ personas: [persona('p-a', '小雪')] })
    await store.load()
    expect(store.personas[0]?.id).toBe('p-a')

    serverState.currentId = 'srv-b'
    api.personas.mockResolvedValueOnce({ personas: [persona('p-b', '小雪')] })
    await store.load()

    expect(store.personas).toHaveLength(1)
    expect(store.personas[0]?.id).toBe('p-b')
  })

  it('reset 作废 loaded 标记，下一次 load 按当前服务器重新拉取', async () => {
    const store = useAiStore()
    api.personas.mockResolvedValueOnce({ personas: [persona('p-a', '小雪')] })
    api.settings.mockResolvedValueOnce({ settings: { proactiveEnabled: true } })
    await store.load()
    expect(store.globalSettings).not.toBeNull()

    // 切服时先清空（bootstrap.resetWorkspace 会调到这里）
    serverState.currentId = 'srv-b'
    store.reset()

    expect(store.personas).toEqual([])
    expect(store.providers).toEqual([])
    expect(store.globalSettings).toBeNull()
    expect(store.loaded).toBe(false)

    api.personas.mockResolvedValueOnce({ personas: [persona('p-b', '阿岚')] })
    await store.load()
    expect(store.personas.map((p) => p.id)).toEqual(['p-b'])
  })

  it('旧服务器的迟到响应不会盖掉新服务器的角色', async () => {
    const store = useAiStore()
    const slow = deferred<{ personas: AiPersona[] }>()
    api.personas.mockReturnValueOnce(slow.promise)

    const first = store.load()
    // 等旧服务器的请求真的发出去，再切服
    await vi.waitFor(() => expect(api.personas).toHaveBeenCalledTimes(1))

    serverState.currentId = 'srv-b'
    api.personas.mockResolvedValueOnce({ personas: [persona('p-b', '阿岚')] })
    await store.load()
    expect(store.personas.map((p) => p.id)).toEqual(['p-b'])

    // 旧服务器的响应这时候才回来
    slow.resolve({ personas: [persona('p-a', '小雪')] })
    await first

    expect(store.personas.map((p) => p.id)).toEqual(['p-b'])
    // 新服务器的加载已经成功，旧响应不能把它打回未加载状态
    expect(store.loaded).toBe(true)
  })

  it('旧服务器的迟到全局设置不会覆盖新服务器的互动设置', async () => {
    const store = useAiStore()
    const slowSettings = deferred<{ settings: { proactiveEnabled: boolean } }>()
    api.settings.mockReturnValueOnce(slowSettings.promise)

    const first = store.load()
    await vi.waitFor(() => expect(api.settings).toHaveBeenCalledTimes(1))

    serverState.currentId = 'srv-b'
    api.settings.mockResolvedValueOnce({ settings: { proactiveEnabled: false } })
    await store.load()
    expect(store.globalSettings?.proactiveEnabled).toBe(false)

    slowSettings.resolve({ settings: { proactiveEnabled: true } })
    await first

    expect(store.globalSettings?.proactiveEnabled).toBe(false)
  })

  it('角色拉取成功后清理镜像里已删除的角色', async () => {
    const store = useAiStore()
    api.personas.mockResolvedValueOnce({
      personas: [persona('p-a', '小雪'), persona('p-2', '阿岚')],
    })
    await store.load()

    expect(dao.upsertPersona).toHaveBeenCalledTimes(2)
    expect(dao.prunePersonas).toHaveBeenCalledWith('srv-a', ['p-a', 'p-2'])
  })

  it('服务商与模型缓存也随服务器作废', async () => {
    const store = useAiStore()
    api.providers.mockResolvedValueOnce({ providers: [provider('prov-a')] })
    await store.load()
    await store.loadModels('prov-a')
    expect(store.providers.map((p) => p.id)).toEqual(['prov-a'])
    expect(store.modelsByProvider['prov-a']).toEqual([])

    serverState.currentId = 'srv-b'
    api.providers.mockResolvedValueOnce({ providers: [provider('prov-b')] })
    await store.load()

    expect(store.providers.map((p) => p.id)).toEqual(['prov-b'])
    expect(store.modelsByProvider['prov-a']).toBeUndefined()
  })
})
