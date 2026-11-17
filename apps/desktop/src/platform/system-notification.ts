import { isTauri } from './device'

/** 系统通知能力：Tauri 原生通知优先，浏览器降级到 Notification API 或应用内提示 */

export type SystemNotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export interface SystemNotificationInput {
  title: string
  body: string
  conversationId?: string | null
  notificationId?: string | null
}

export interface SystemNotificationClickPayload {
  conversationId?: string | null
  notificationId?: string | null
}

let clickHandler: ((payload: SystemNotificationClickPayload) => void) | null = null
let actionListenerReady = false
/** 浏览器端的点击回调按通知实例挂载，这里记录 id 与通知对象，方便取消 */
const browserNotifications = new Map<string, Notification>()

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
    const { onAction } = await import('@tauri-apps/plugin-notification')
    await onAction((event) => {
      if (event.actionId !== 'tap') return
      const extra = event.notification?.extra ?? {}
      dispatchClick({
        conversationId: typeof extra.conversationId === 'string' ? extra.conversationId : null,
        notificationId: typeof extra.notificationId === 'string' ? extra.notificationId : null,
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
 * 调用系统通知。
 * 返回 native 表示已交给操作系统；fallback 表示当前环境不可用，调用方应改用应用内提示。
 */
export async function sendSystemNotification(
  input: SystemNotificationInput,
): Promise<'native' | 'fallback'> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification')
      if (!(await isPermissionGranted())) return 'fallback'
      await ensureTauriActionListener()
      sendNotification({
        title: input.title,
        body: input.body,
        extra: {
          conversationId: input.conversationId ?? '',
          notificationId: input.notificationId ?? '',
        },
      })
      return 'native'
    } catch (e) {
      console.warn('[notification] 发送原生通知失败', e)
      return 'fallback'
    }
  }

  if (typeof window === 'undefined' || !('Notification' in window)) return 'fallback'
  if (Notification.permission !== 'granted') return 'fallback'

  try {
    const notification = new Notification(input.title, { body: input.body })
    const key = input.notificationId ?? String(Date.now())
    browserNotifications.set(key, notification)
    notification.onclick = () => {
      window.focus()
      dispatchClick({
        conversationId: input.conversationId ?? null,
        notificationId: input.notificationId ?? null,
      })
      notification.close()
    }
    notification.onclose = () => {
      browserNotifications.delete(key)
    }
    return 'native'
  } catch (e) {
    console.warn('[notification] 浏览器通知发送失败', e)
    return 'fallback'
  }
}

/** 浏览器降级提示音：短促两声，不依赖音频资源文件 */
export function playNotificationSound(): void {
  if (isTauri()) return
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
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
    /* 静默失败，提示音不是必要能力 */
  }
}
