import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * localStorage 与 document 在 node 环境不存在，补最简桩。
 * ui store 创建即 applyTheme()，所以两个桩都必须在 useUiStore() 之前装好。
 */
const storage = new Map<string, string>()
const customVars: Map<string, string> = new Map()
const root = {
  classList: { toggle: vi.fn() },
  dataset: {} as Record<string, string>,
  style: {
    setProperty: vi.fn((name: string, value: string) => void customVars.set(name, value)),
    removeProperty: vi.fn((name: string) => void customVars.delete(name)),
  },
}
const mediaQueryList = {
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}

function installStubs(): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  })
  vi.stubGlobal('document', { documentElement: root })
  vi.stubGlobal('window', { matchMedia: vi.fn(() => mediaQueryList) })
}

/** 每次重建模块，保证 localStorage 初值读进 store 而不是上一次的内存态 */
async function freshUi() {
  vi.resetModules()
  const mod = await import('./ui')
  setActivePinia(createPinia())
  return mod
}

const CUSTOM_ACCENT_VARS = [
  '--accent-custom',
  '--accent-soft-custom',
  '--accent-custom-dark',
  '--accent-soft-custom-dark',
] as const

beforeEach(() => {
  storage.clear()
  customVars.clear()
  root.dataset = {}
  installStubs()
})

describe('聊天背景与主题色跟随', () => {
  it('setChatBackground 写入状态与 localStorage，并把 accent 切到 custom 档', async () => {
    const { useUiStore } = await freshUi()
    const ui = useUiStore()

    ui.setChatBackground('/files/backgrounds/a/b/hash.png', '#7c5cff')

    expect(ui.chatBgUrl).toBe('/files/backgrounds/a/b/hash.png')
    expect(ui.chatBgAccent).toBe('#7c5cff')
    expect(storage.get('nenochat.chatBgUrl')).toBe('/files/backgrounds/a/b/hash.png')
    expect(storage.get('nenochat.chatBgAccent')).toBe('#7c5cff')
    expect(root.dataset.accent).toBe('custom')
    for (const name of [
      '--accent-custom',
      '--accent-soft-custom',
      '--accent-custom-dark',
      '--accent-soft-custom-dark',
    ]) {
      expect(customVars.get(name)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('关闭主题色随背景后回退到手动主题色并清理内联变量', async () => {
    const { useUiStore } = await freshUi()
    const ui = useUiStore()

    ui.setChatBackground('/files/bg.png', '#7c5cff')
    ui.setAccentFollowBg(false)

    expect(storage.get('nenochat.accentFollowBg')).toBe('false')
    expect(root.dataset.accent).toBe('blue')
    for (const name of CUSTOM_ACCENT_VARS) expect(customVars.has(name)).toBe(false)
    // 背景图本身不受开关影响
    expect(ui.chatBgUrl).toBe('/files/bg.png')
  })

  it('清除背景恢复手动主题色并删掉镜像', async () => {
    const { useUiStore } = await freshUi()
    const ui = useUiStore()

    ui.setChatBackground('/files/bg.png', '#16a34a')
    ui.setChatBackground(null, null)

    expect(ui.chatBgUrl).toBeNull()
    expect(ui.chatBgAccent).toBeNull()
    expect(storage.has('nenochat.chatBgUrl')).toBe(false)
    expect(storage.has('nenochat.chatBgAccent')).toBe(false)
    expect(root.dataset.accent).toBe('blue')
    for (const name of CUSTOM_ACCENT_VARS) expect(customVars.has(name)).toBe(false)
  })

  it('applyServerBackground 只覆盖背景字段，不碰本地 theme/accent', async () => {
    storage.set('nenochat.theme', 'dark')
    storage.set('nenochat.accent', 'violet')
    const { useUiStore } = await freshUi()
    const ui = useUiStore()
    expect(ui.theme).toBe('dark')
    expect(ui.accent).toBe('violet')

    ui.applyServerBackground({ chatBgUrl: '/files/bg.png', chatBgAccent: '#ea7317' })

    expect(ui.chatBgUrl).toBe('/files/bg.png')
    expect(ui.chatBgAccent).toBe('#ea7317')
    expect(ui.theme).toBe('dark')
    expect(ui.accent).toBe('violet')
    expect(root.dataset.accent).toBe('custom')
  })

  it('启动时跟随开关默认开、非法主色被忽略，localStorage 有历史值时读回', async () => {
    storage.set('nenochat.chatBgUrl', '/files/bg.png')
    storage.set('nenochat.chatBgAccent', '#ZZZZZZ')
    const { useUiStore } = await freshUi()
    const ui = useUiStore()

    expect(ui.accentFollowBg).toBe(true)
    expect(ui.chatBgUrl).toBe('/files/bg.png')
    // 非法主色不生效，accent 回退到手动档
    expect(ui.chatBgAccent).toBeNull()
    expect(root.dataset.accent).toBe('blue')
  })

  it('clearServerBackground 清空背景（登出路径）', async () => {
    const { useUiStore } = await freshUi()
    const ui = useUiStore()

    ui.setChatBackground('/files/bg.png', '#db2f85')
    ui.clearServerBackground()

    expect(ui.chatBgUrl).toBeNull()
    expect(ui.chatBgAccent).toBeNull()
    expect(root.dataset.accent).toBe('blue')
  })
})
