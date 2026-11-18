import { isTauri, platformName } from './device'

/** 系统通知能力：Tauri 原生通知优先，浏览器开发环境退回 Notification API */

/** Windows 走自建 AUMID 的原生命令，其余平台继续用通知插件 */
function isWindowsDesktop(): boolean {
  return isTauri() && platformName() === 'win32'
}

export type SystemNotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export interface SystemNotificationInput {
  title: string
  body: string
  conversationId?: string | null
  /** true 时不播放系统提示音 */
  silent?: boolean
}

export interface SystemNotificationClickPayload {
  conversationId?: string | null
}

let clickHandler: ((payload: SystemNotificationClickPayload) => void) | null = null
let actionListenerReady = false

export function onSystemNotificationClick(
  handler: (payload: SystemNotificationClickPayload) => void,
): void {
  clickHandler = handler
}

function dispatchClick(payload: SystemNotificationClickPayload): void {
  clickHandler?.(payload)
}

/** Tauri 的点击事件全局注册一次即可，extra 里带着会话 id */
async function ensureTauriActionListener(): Promise<void> {
  if (actionListenerReady || !isTauri()) return
  actionListenerReady = true
  try {
    if (isWindowsDesktop()) {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<string>('system-notification://click', (event) => {
        dispatchClick({ conversationId: event.payload || null })
      })
      return
    }
    const { onAction } = await import('@tauri-apps/plugin-notification')
    await onAction((event) => {
      if (event.actionId !== 'tap') return
      const extra = event.notification?.extra ?? {}
      dispatchClick({
        conversationId: typeof extra.conversationId === 'string' ? extra.conversationId : null,
      })
    })
  } catch (e) {
    console.warn('[notification] 注册点击监听失败', e)
  }
}

export async function getNotificationPermission(): Promise<SystemNotificationPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
      return (await isPermissionGranted()) ? 'granted' : 'default'
    } catch {
      return 'unsupported'
    }
  }
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission as SystemNotificationPermission
}

/** 主动申请权限；只有用户在设置里打开通知时才调用，避免启动即弹窗 */
export async function requestNotificationPermission(): Promise<SystemNotificationPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
      if (await isPermissionGranted()) return 'granted'
      const result = await requestPermission()
      return result === 'granted' ? 'granted' : 'denied'
    } catch {
      return 'unsupported'
    }
  }
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default'
  } catch {
    return 'unsupported'
  }
}

/**
 * 当前应用窗口是否在前台。
 * 不能用 document.hasFocus()：WebView2 在宿主窗口失焦后仍可能返回 true，
 * 会把后台消息误判成「正在看」而抑制系统通知。
 */
export async function isAppWindowFocused(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return await getCurrentWindow().isFocused()
    } catch {
      // 读不到状态时按「不在前台」处理，宁可多弹一次也不要漏通知
      return false
    }
  }
  return (
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  )
}

/** 调用系统通知；返回 false 表示当前环境无法展示 */
export async function sendSystemNotification(input: SystemNotificationInput): Promise<boolean> {
  if (isTauri()) {
    if (isWindowsDesktop()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await ensureTauriActionListener()
        await invoke('show_system_notification', {
          title: input.title,
          body: input.body,
          silent: input.silent ?? false,
          conversationId: input.conversationId ?? null,
        })
        return true
      } catch (e) {
        console.warn('[notification] 发送系统通知失败', e)
        return false
      }
    }
    try {
      const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification')
      if (!(await isPermissionGranted())) return false
      await ensureTauriActionListener()
      await sendNotification({
        title: input.title,
        body: input.body,
        silent: input.silent,
        extra: { conversationId: input.conversationId ?? '' },
      })
      return true
    } catch (e) {
      console.warn('[notification] 发送原生通知失败', e)
      return false
    }
  }

  if (typeof window === 'undefined' || !('Notification' in window)) return false
  if (Notification.permission !== 'granted') return false

  try {
    const notification = new Notification(input.title, {
      body: input.body,
      silent: input.silent,
    })
    notification.onclick = () => {
      window.focus()
      dispatchClick({ conversationId: input.conversationId ?? null })
      notification.close()
    }
    return true
  } catch (e) {
    console.warn('[notification] 浏览器通知发送失败', e)
    return false
  }
}

/** 浏览器开发环境的提示音；Tauri 由系统通知自带声音 */
export function playNotificationSound(): void {
  if (isTauri()) return
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const context = new Ctx()
    const play = (at: number, frequency: number): void => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = frequency
      oscillator.type = 'sine'
      gain.gain.setValueAtTime(0.0001, context.currentTime + at)
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + at + 0.16)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(context.currentTime + at)
      oscillator.stop(context.currentTime + at + 0.18)
    }
    play(0, 880)
    play(0.18, 1170)
    window.setTimeout(() => void context.close(), 600)
  } catch {
    /* 提示音不是必要能力 */
  }
}
