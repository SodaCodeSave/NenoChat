import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/platform/device', () => ({ isTauri: () => true }))

/** localStorage 在 node 环境不存在，这里补一个最简实现 */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  })
  return store
}

async function freshSecureStore() {
  vi.resetModules()
  return import('@/platform/secure-store')
}

beforeEach(() => {
  installStorage()
  invokeMock.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('安全存储的钥匙串降级', () => {
  it('钥匙串可用时直接读写，不落本地存储', async () => {
    const { setSecret, getSecret } = await freshSecureStore()
    invokeMock.mockImplementation(async (_cmd, { account }) => {
      if (account === 'k1') return 'token-a'
      return ''
    })
    await setSecret('k1', 'token-a')
    expect(invokeMock).toHaveBeenCalledWith('secret_set', { account: 'k1', value: 'token-a' })
    expect(await getSecret('k1')).toBe('token-a')
    expect(localStorage.getItem('nenochat.secret.k1')).toBeNull()
  })

  it('移动端钥匙串写入失败时降级到本地存储', async () => {
    const { setSecret, getSecret } = await freshSecureStore()
    invokeMock.mockRejectedValue('当前平台不支持系统钥匙串')
    await setSecret('k2', 'token-b')
    expect(localStorage.getItem('nenochat.secret.k2')).toBe('token-b')
    expect(await getSecret('k2')).toBe('token-b')
  })

  it('钥匙串无条目时回读本地存储里的降级值', async () => {
    const { getSecret } = await freshSecureStore()
    invokeMock.mockResolvedValue('')
    localStorage.setItem('nenochat.secret.k3', 'token-c')
    expect(await getSecret('k3')).toBe('token-c')
  })

  it('删除时钥匙串失败也要清掉本地降级值', async () => {
    const { setSecret, deleteSecret, getSecret } = await freshSecureStore()
    invokeMock.mockRejectedValue('当前平台不支持系统钥匙串')
    await setSecret('k4', 'token-d')
    invokeMock.mockClear()
    invokeMock.mockRejectedValue('删除失败')
    await deleteSecret('k4')
    expect(localStorage.getItem('nenochat.secret.k4')).toBeNull()
    expect(await getSecret('k4')).toBe('')
  })
})
