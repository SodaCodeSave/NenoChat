import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/platform/device', () => ({
  isTauri: () => true,
  deviceId: () => 'dev-test',
  deviceName: () => '测试机',
  platformName: () => 'win32',
}))
vi.mock('@/platform/db', () => ({ hasLocalDb: () => true }))
vi.mock('@/platform/file-cache', () => ({ clearAttachmentCache: vi.fn() }))
vi.mock('@/platform/local-network', () => ({ ensureLocalNetworkAccess: vi.fn() }))
vi.mock('@/db/dao/servers', () => ({
  listServers: vi.fn(async () => []),
  upsertServer: vi.fn(),
  touchServer: vi.fn(),
  removeServerCascade: vi.fn(),
}))

const info = { baseUrl: 'http://127.0.0.1:54321', wsUrl: 'ws://127.0.0.1:54321/ws', token: 'tok' }

/** localStorage 在 node 环境不存在，这里补一个最简实现 */
function installStorage(): void {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  })
}

/** 每次重建模块，避免 local-server 的 invoke 结果缓存串到下一个用例 */
async function freshServers() {
  vi.resetModules()
  const mod = await import('./servers')
  setActivePinia(createPinia())
  return mod
}

beforeEach(() => {
  installStorage()
  invokeMock.mockReset()
})

describe('一体化版服务器列表', () => {
  it('内置服务端实例复用统一的服务器结构', async () => {
    const { localServerInstance, LOCAL_SERVER_ID } = await freshServers()
    const instance = localServerInstance(info)
    expect(instance.id).toBe(LOCAL_SERVER_ID)
    expect(instance.baseUrl).toBe(info.baseUrl)
    expect(instance.wsUrl).toBe(info.wsUrl)
    expect(instance.name).toBeTruthy()
  })

  it('有内置服务端时列表只保留它，并把它设为当前', async () => {
    invokeMock.mockResolvedValue(info)
    const { useServersStore, LOCAL_SERVER_ID } = await freshServers()

    const store = useServersStore()
    await store.hydrate()

    expect(store.integrated).toBe(true)
    expect(store.servers).toHaveLength(1)
    expect(store.servers[0]!.id).toBe(LOCAL_SERVER_ID)
    expect(store.currentId).toBe(LOCAL_SERVER_ID)
    expect(store.localToken).toBe('tok')
  })

  it('普通联网版读本地服务器列表，不进入一体化模式', async () => {
    invokeMock.mockResolvedValue(null)
    const { useServersStore } = await freshServers()

    const store = useServersStore()
    await store.hydrate()

    expect(store.integrated).toBe(false)
    expect(store.servers).toHaveLength(0)
  })

  it('内置服务端起不来时标记一体化并抛出，交给启动流程报错', async () => {
    invokeMock.mockRejectedValue(new Error('内置服务端启动超时'))
    const { useServersStore } = await freshServers()

    const store = useServersStore()
    await expect(store.hydrate()).rejects.toThrow('启动超时')
    expect(store.integrated).toBe(true)
  })

  it('一体化模式下不允许添加、移除或切换服务器', async () => {
    invokeMock.mockResolvedValue(info)
    const { useServersStore, LOCAL_SERVER_ID } = await freshServers()

    const store = useServersStore()
    await store.hydrate()

    await expect(store.add('http://example.com')).rejects.toThrow()
    await store.remove(LOCAL_SERVER_ID)
    await store.setCurrent('srv-remote')

    expect(store.servers).toHaveLength(1)
    expect(store.currentId).toBe(LOCAL_SERVER_ID)
  })
})
