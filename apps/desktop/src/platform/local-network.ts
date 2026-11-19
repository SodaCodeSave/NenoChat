/**
 * 本地网络访问权限。
 * Android 17（targetSdk 37）起，应用访问局域网与回环地址需要 ACCESS_LOCAL_NETWORK
 * 运行时权限，未授权时系统在网卡层直接阻断请求。权限是应用级的，与具体地址无关；
 * 只有目标是私网/回环地址时才需要向用户索要。
 */
export type LocalNetworkState = 'granted' | 'denied' | 'prompt' | 'unsupported'

/** 原生侧通过 JS 桥注入的接口，仅 Android App 内存在 */
interface NativeLocalNetworkBridge {
  status(): string
  request(): void
  openSettings(): void
  diagnostics?(): string
}

/** 原生侧回传的环境信息，用于区分权限问题与安装包缺失桥接 */
export interface NativeDiagnostics {
  sdk: number
  release: string
  model: string
  appVersion: string
  permissionDeclared: boolean
  permissionGranted: boolean
  status: LocalNetworkState
  asked: boolean
  canAskAgain: boolean
  webviewPackage: string
  webviewVersion: string
}

declare global {
  interface Window {
    NenoLocalNetwork?: NativeLocalNetworkBridge
    __nenoLocalNetworkResult?: (state: string) => void
  }
}

/** 等待系统授权框回传的上限，超时后回落到主动查询状态 */
const REQUEST_TIMEOUT = 180_000

const KNOWN_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

function nativeBridge(): NativeLocalNetworkBridge | null {
  if (typeof window === 'undefined') return null
  // 桥只在 Android App 的 WebView 里注入，存在即代表能走原生权限
  const bridge = window.NenoLocalNetwork
  return bridge && typeof bridge.status === 'function' ? bridge : null
}

/** JS 桥是否存在：Android App 里应当为 true，缺了说明安装包没带上原生定制 */
export function nativeBridgeAvailable(): boolean {
  return nativeBridge() !== null
}

/** 读取原生环境信息，没有桥或解析失败时返回 null */
export function nativeDiagnostics(): NativeDiagnostics | null {
  const bridge = nativeBridge()
  if (!bridge || typeof bridge.diagnostics !== 'function') return null
  try {
    const raw = JSON.parse(bridge.diagnostics()) as Partial<NativeDiagnostics>
    return {
      sdk: Number(raw.sdk ?? 0),
      release: String(raw.release ?? ''),
      model: String(raw.model ?? ''),
      appVersion: String(raw.appVersion ?? ''),
      permissionDeclared: Boolean(raw.permissionDeclared),
      permissionGranted: Boolean(raw.permissionGranted),
      status: normalizeState(String(raw.status ?? '')),
      asked: Boolean(raw.asked),
      canAskAgain: Boolean(raw.canAskAgain),
      webviewPackage: String(raw.webviewPackage ?? ''),
      webviewVersion: String(raw.webviewVersion ?? ''),
    }
  } catch (e) {
    console.error('[local-network] 解析原生诊断信息失败', e)
    return null
  }
}

/** 从 UA 里取 Chromium 主版本号，用于判断 WebView 是否启用了本地网络限制 */
export function webviewChromiumVersion(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Chrome\/(\d+)/.exec(ua)?.[1] ?? ''
}

function normalizeState(raw: string): LocalNetworkState {
  return raw === 'granted' || raw === 'denied' || raw === 'prompt' || raw === 'unsupported'
    ? raw
    : 'unsupported'
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((part) => Number(part))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums as [number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  // fc00::/7 唯一本地地址、fe80::/10 链路本地地址
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
  return false
}

/** 目标地址是否落在本地网络（私网、回环、.local 域名）内 */
export function requiresLocalNetworkAccess(rawUrl: string): boolean {
  if (!rawUrl.trim()) return false
  let host: string
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`).hostname
  } catch {
    return false
  }
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!bare) return false
  if (KNOWN_LOCAL_HOSTS.has(bare)) return true
  if (bare.endsWith('.local') || bare.endsWith('.localhost')) return true
  return isPrivateIpv4(bare) || isPrivateIpv6(bare)
}

/** 查询当前授权状态，非 Android App 环境返回 unsupported（等同于不受限） */
export async function localNetworkState(): Promise<LocalNetworkState> {
  const bridge = nativeBridge()
  if (!bridge) return 'unsupported'
  try {
    return normalizeState(bridge.status())
  } catch (e) {
    console.error('[local-network] 读取权限状态失败', e)
    return 'unsupported'
  }
}

/**
 * 弹出系统授权框并等待用户选择。
 * 原生侧回调 window.__nenoLocalNetworkResult 时兑现 Promise；
 * 已经被拒绝且不再弹框时同样会立刻回传 denied，由调用方引导去设置页。
 */
export function requestLocalNetworkAccess(): Promise<LocalNetworkState> {
  const bridge = nativeBridge()
  if (!bridge) return Promise.resolve('unsupported')

  return new Promise<LocalNetworkState>((resolve) => {
    let settled = false
    const finish = (state: LocalNetworkState) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      delete window.__nenoLocalNetworkResult
      resolve(state)
    }
    const timer = setTimeout(() => {
      void localNetworkState().then(finish)
    }, REQUEST_TIMEOUT)

    window.__nenoLocalNetworkResult = (raw) => finish(normalizeState(raw))
    try {
      bridge.request()
    } catch (e) {
      console.error('[local-network] 请求权限失败', e)
      finish('denied')
    }
  })
}

function messageFor(state: LocalNetworkState): string {
  return state === 'denied'
    ? '系统已拒绝本地网络权限，请在「设置 → 应用 → NenoChat → 权限」中允许「附近的设备」后重试'
    : '访问局域网服务器需要本地网络权限，请允许「附近的设备」权限后重试'
}

export class LocalNetworkPermissionError extends Error {
  readonly state: LocalNetworkState

  constructor(state: LocalNetworkState) {
    super(messageFor(state))
    this.name = 'LocalNetworkPermissionError'
    this.state = state
  }
}

/**
 * 连接前的权限闸门：目标不是本地地址时直接放行。
 * interactive 为 true 时缺权限就弹系统框；为 false 时只检查，缺权限直接抛错，
 * 避免页面加载时的后台探测把用户打个措手不及。
 */
export async function ensureLocalNetworkAccess(
  rawUrl: string,
  options: { interactive?: boolean } = {},
): Promise<LocalNetworkState> {
  if (!requiresLocalNetworkAccess(rawUrl)) return 'granted'

  const current = await localNetworkState()
  if (current === 'granted' || current === 'unsupported') return 'granted'

  if (options.interactive !== false) {
    const granted = await requestLocalNetworkAccess()
    if (granted === 'granted' || granted === 'unsupported') return 'granted'
    throw new LocalNetworkPermissionError(granted)
  }

  throw new LocalNetworkPermissionError(current)
}

/** 跳转系统设置页，供用户手动开启「附近的设备」权限 */
export function openLocalNetworkSettings(): void {
  const bridge = nativeBridge()
  if (!bridge) return
  try {
    bridge.openSettings()
  } catch (e) {
    console.error('[local-network] 打开系统设置失败', e)
  }
}
