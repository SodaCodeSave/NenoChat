import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalNetworkPermissionError,
  ensureLocalNetworkAccess,
  localNetworkState,
  nativeBridgeAvailable,
  nativeDiagnostics,
  openLocalNetworkSettings,
  requestLocalNetworkAccess,
  requiresLocalNetworkAccess,
  webviewChromiumVersion,
} from './local-network'

type Bridge = {
  status: () => string
  request: () => void
  openSettings: () => void
  diagnostics?: () => string
}

/** 模拟 Android WebView 注入的 JS 桥 */
function installBridge(bridge: Partial<Bridge>): Bridge {
  const full: Bridge = {
    status: () => 'granted',
    request: () => {},
    openSettings: () => {},
    ...bridge,
  }
  ;(globalThis as unknown as { window: unknown }).window = { NenoLocalNetwork: full }
  return full
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  vi.useRealTimers()
})

describe('requiresLocalNetworkAccess', () => {
  it('私网 IPv4 与回环地址需要权限', () => {
    for (const url of [
      'http://192.168.1.10:8787',
      'http://10.0.0.5',
      'http://172.16.3.4',
      'http://169.254.1.1',
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      'http://0.0.0.0:8787',
    ]) {
      expect(requiresLocalNetworkAccess(url), url).toBe(true)
    }
  })

  it('IPv6 回环、唯一本地与链路本地地址需要权限', () => {
    for (const url of ['http://[::1]:8787', 'http://[fd12:3456::1]', 'http://[fe80::1]']) {
      expect(requiresLocalNetworkAccess(url), url).toBe(true)
    }
  })

  it('.local 域名与无协议前缀的地址同样识别', () => {
    expect(requiresLocalNetworkAccess('http://nas.local:8787')).toBe(true)
    expect(requiresLocalNetworkAccess('192.168.1.10:8787')).toBe(true)
  })

  it('公网地址、非私网地址与空串不需要权限', () => {
    for (const url of [
      'https://chat.example.com',
      'http://172.32.3.4',
      'http://8.8.8.8',
      'http://[2001:db8::1]',
      '',
      '   ',
      'not a url',
    ]) {
      expect(requiresLocalNetworkAccess(url), url).toBe(false)
    }
  })
})

describe('localNetworkState', () => {
  it('没有原生桥时视为不受限', async () => {
    await expect(localNetworkState()).resolves.toBe('unsupported')
  })

  it('透传原生侧状态，未知值退化为 unsupported', async () => {
    installBridge({ status: () => 'denied' })
    await expect(localNetworkState()).resolves.toBe('denied')

    installBridge({ status: () => 'whatever' })
    await expect(localNetworkState()).resolves.toBe('unsupported')
  })
})

describe('requestLocalNetworkAccess', () => {
  it('没有原生桥时直接返回 unsupported', async () => {
    await expect(requestLocalNetworkAccess()).resolves.toBe('unsupported')
  })

  it('等待原生侧回传结果', async () => {
    installBridge({
      request: () => {
        queueMicrotask(() => window.__nenoLocalNetworkResult?.('granted'))
      },
    })
    await expect(requestLocalNetworkAccess()).resolves.toBe('granted')
    // 兑现后清理回调，避免下一次请求拿到过期结果
    expect(window.__nenoLocalNetworkResult).toBeUndefined()
  })

  it('原生侧迟迟不回传时回落到状态查询', async () => {
    vi.useFakeTimers()
    installBridge({ status: () => 'granted' })
    const pending = requestLocalNetworkAccess()
    await vi.advanceTimersByTimeAsync(180_000)
    await expect(pending).resolves.toBe('granted')
  })
})

describe('ensureLocalNetworkAccess', () => {
  it('公网地址直接放行，不触碰原生桥', async () => {
    const bridge = installBridge({ status: () => 'denied' })
    const spy = vi.spyOn(bridge, 'status')
    await expect(ensureLocalNetworkAccess('https://chat.example.com')).resolves.toBe('granted')
    expect(spy).not.toHaveBeenCalled()
  })

  it('已授权时放行', async () => {
    installBridge({ status: () => 'granted' })
    await expect(ensureLocalNetworkAccess('http://192.168.1.10:8787')).resolves.toBe('granted')
  })

  it('非交互模式下缺权限直接抛错，不弹系统框', async () => {
    const request = vi.fn()
    installBridge({ status: () => 'prompt', request })
    await expect(
      ensureLocalNetworkAccess('http://192.168.1.10:8787', { interactive: false }),
    ).rejects.toBeInstanceOf(LocalNetworkPermissionError)
    expect(request).not.toHaveBeenCalled()
  })

  it('交互模式下弹框并接受授权', async () => {
    const request = vi.fn(() => {
      queueMicrotask(() => window.__nenoLocalNetworkResult?.('granted'))
    })
    installBridge({ status: () => 'prompt', request })
    await expect(ensureLocalNetworkAccess('http://192.168.1.10:8787')).resolves.toBe('granted')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('用户拒绝时抛错并带上状态，便于引导去系统设置', async () => {
    installBridge({
      status: () => 'denied',
      request: () => {
        queueMicrotask(() => window.__nenoLocalNetworkResult?.('denied'))
      },
    })
    const failure = ensureLocalNetworkAccess('http://192.168.1.10:8787')
    await expect(failure).rejects.toMatchObject({ state: 'denied' })
    await expect(failure).rejects.toThrow('附近的设备')
  })
})

describe('openLocalNetworkSettings', () => {
  it('调用原生侧跳转应用设置页', () => {
    const openSettings = vi.fn()
    installBridge({ openSettings })
    openLocalNetworkSettings()
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('没有原生桥时静默忽略', () => {
    expect(() => openLocalNetworkSettings()).not.toThrow()
  })
})

describe('nativeBridgeAvailable', () => {
  it('有桥为 true，无桥为 false', () => {
    expect(nativeBridgeAvailable()).toBe(false)
    installBridge({})
    expect(nativeBridgeAvailable()).toBe(true)
  })
})

describe('nativeDiagnostics', () => {
  it('没有桥或原生侧未提供诊断时返回 null', () => {
    expect(nativeDiagnostics()).toBeNull()
    installBridge({})
    expect(nativeDiagnostics()).toBeNull()
  })

  it('解析原生侧 JSON，缺字段补默认值', () => {
    installBridge({
      diagnostics: () =>
        JSON.stringify({
          sdk: 37,
          release: '17',
          model: 'Xiaomi 15',
          permissionDeclared: true,
          permissionGranted: false,
          status: 'prompt',
          webviewVersion: '154.0.1.2',
        }),
    })

    expect(nativeDiagnostics()).toMatchObject({
      sdk: 37,
      release: '17',
      model: 'Xiaomi 15',
      permissionDeclared: true,
      permissionGranted: false,
      status: 'prompt',
      webviewVersion: '154.0.1.2',
      appVersion: '',
      webviewPackage: '',
    })
  })

  it('原生返回非法 JSON 时返回 null', () => {
    installBridge({ diagnostics: () => 'not json' })
    expect(nativeDiagnostics()).toBeNull()
  })
})

describe('webviewChromiumVersion', () => {
  it('从 UA 取 Chromium 主版本', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 17; 23127PN0CC Build/BP2A.250705.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.7339.51 Mobile Safari/537.36'
    vi.stubGlobal('navigator', { userAgent: ua })
    expect(webviewChromiumVersion()).toBe('154')
    vi.unstubAllGlobals()
  })

  it('UA 里没有 Chrome 时返回空串', () => {
    vi.stubGlobal('navigator', { userAgent: 'Node.js/22' })
    expect(webviewChromiumVersion()).toBe('')
    vi.unstubAllGlobals()
  })
})
