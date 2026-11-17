import { isTauri, platformName } from './device'

/**
 * 任务栏/底座角标。
 * macOS/Linux 走 Tauri 的 setBadgeCount；Windows 官方不支持数字角标，
 * 退化为窗口标题前缀，至少让任务栏悬停与 Alt+Tab 能看到未读数。
 */
export async function setAppBadge(count: number): Promise<void> {
  const value = Math.max(0, Math.floor(count))

  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const current = getCurrentWindow()
      if (platformName() === 'win32') {
        await current.setTitle(value > 0 ? `(${value}) NenoChat` : 'NenoChat')
        return
      }
      await current.setBadgeCount(value > 0 ? value : undefined)
      return
    } catch {
      /* 平台或权限不支持时保持安静，界面内仍有未读角标 */
      return
    }
  }

  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (value > 0) await nav.setAppBadge?.(value)
    else await nav.clearAppBadge?.()
  } catch {
    /* 浏览器不支持时忽略 */
  }
}
