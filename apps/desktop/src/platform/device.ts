/**
 * 运行环境探测：同一份代码既跑在 Tauri 窗口里，也跑在浏览器里。
 * 浏览器模式没有本地 SQLite、系统钥匙串与原生通知，相关能力需降级。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export const isBrowser = !isTauri()

/** 当前平台标识，用于设备信息上报 */
export function platformName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  if (/mac os x/i.test(ua)) return 'darwin'
  if (/win/i.test(ua)) return 'win32'
  if (/linux/i.test(ua)) return 'linux'
  return 'web'
}

/** 生成并持久化设备 id，同一浏览器/安装包内保持不变 */
const DEVICE_KEY = 'nenochat.deviceId'

export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
    const id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-6)}`
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    return `dev-ephemeral`
  }
}

export function deviceName(): string {
  const platform = platformName()
  const map: Record<string, string> = {
    win32: 'Windows 桌面端',
    darwin: 'macOS 桌面端',
    linux: 'Linux 桌面端',
    android: 'Android 浏览器',
    ios: 'iOS 浏览器',
    web: '浏览器',
  }
  return map[platform] ?? '未知设备'
}
