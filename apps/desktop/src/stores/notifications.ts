import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppNotification, NotificationLevel } from '@nenochat/shared'
import {
  shouldShowSystemNotification,
  systemNotificationBody,
  type NotificationKind,
} from '@nenochat/shared/notifications/rules'
import { notificationApi } from '@/api/endpoints'
import { router } from '@/app/router'
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  upsertNotification,
} from '@/db/dao/notifications'
import { hasLocalDb } from '@/platform/db'
import {
  getNotificationPermission,
  onSystemNotificationClick,
  playNotificationSound,
  requestNotificationPermission,
  sendSystemNotification,
  type SystemNotificationPermission,
} from '@/platform/system-notification'
import { useAuthStore } from './auth'
import { useConversationsStore } from './conversations'
import { useServersStore } from './servers'

const PAGE_SIZE = 50

function levelOf(value?: string | null): NotificationLevel | null {
  return value === 'all' || value === 'mentions' || value === 'none'
    ? (value as NotificationLevel)
    : null
}

function kindOf(notification: AppNotification): NotificationKind {
  switch (notification.type) {
    case 'mention':
      return 'mention'
    case 'group':
    case 'group_ai':
      return notification.type
    case 'ai_proactive':
      return 'ai_proactive'
    case 'dm':
      return 'direct'
    default:
      return 'system'
  }
}

/**
 * 通知中心与系统通知。
 * 服务端负责落库与下发，这里只做展示、已读同步以及「要不要打扰」的最终判定。
 */
export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<AppNotification[]>([])
  const unreadTotal = ref(0)
  const hasMore = ref(false)
  const loading = ref(false)
  const panelOpen = ref(false)
  const toast = ref<AppNotification | null>(null)
  const permission = ref<SystemNotificationPermission>('default')

  const serverId = computed(() => useServersStore().currentId ?? '')
  const unreadCount = computed(() => items.value.reduce((sum, item) => sum + (item.isRead ? 0 : 1), 0))

  let toastTimer: number | null = null
  let clickBound = false
  const notifiedIds = new Set<string>()

  function persist(notification: AppNotification): void {
    if (!hasLocalDb() || !serverId.value) return
    void upsertNotification(serverId.value, notification)
  }

  async function hydrate(): Promise<void> {
    if (!hasLocalDb() || !serverId.value) return
    items.value = await listNotifications(serverId.value, PAGE_SIZE)
    unreadTotal.value = await countUnreadNotifications(serverId.value)
  }

  async function refresh(): Promise<void> {
    if (!serverId.value) return
    loading.value = true
    try {
      const result = await notificationApi.list({ limit: PAGE_SIZE })
      items.value = result.notifications
      unreadTotal.value = result.unreadCount
      hasMore.value = result.hasMore
      if (hasLocalDb() && serverId.value) {
        for (const notification of result.notifications) {
          await upsertNotification(serverId.value, notification)
        }
      }
    } catch {
      /* 离线时继续用本地镜像 */
    } finally {
      loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || loading.value) return
    const before = items.value[items.value.length - 1]?.createdAt
    if (!before) return
    loading.value = true
    try {
      const result = await notificationApi.list({ limit: PAGE_SIZE, before })
      const known = new Set(items.value.map((item) => item.id))
      items.value = [...items.value, ...result.notifications.filter((item) => !known.has(item.id))]
      hasMore.value = result.hasMore
    } catch {
      /* 忽略翻页失败 */
    } finally {
      loading.value = false
    }
  }

  /** 统一处理新增或已读状态变化，保持未读总数与列表一致 */
  function applyUpdated(notification: AppNotification): void {
    const index = items.value.findIndex((item) => item.id === notification.id)
    if (index >= 0) {
      const previous = items.value[index]!
      if (!previous.isRead && notification.isRead) unreadTotal.value = Math.max(0, unreadTotal.value - 1)
      if (previous.isRead && !notification.isRead) unreadTotal.value += 1
      items.value[index] = notification
    } else {
      items.value = [notification, ...items.value]
      if (!notification.isRead) unreadTotal.value += 1
    }
    persist(notification)
  }

  /** 实时推送：先入列表，再决定是否弹系统通知 */
  function receive(notification: AppNotification): void {
    const isNew = !items.value.some((item) => item.id === notification.id)
    applyUpdated(notification)
    if (isNew && !notification.isRead) void maybeNotify(notification)
  }

  function showToast(notification: AppNotification): void {
    toast.value = notification
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toast.value = null
      toastTimer = null
    }, 6000)
  }

  function dismissToast(): void {
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = null
    toast.value = null
  }

  /** 系统通知门控：总开关、免打扰、会话静音、正在看的会话全部在这里收口 */
  async function maybeNotify(notification: AppNotification): Promise<void> {
    const auth = useAuthStore()
    const settings = auth.notificationSettings
    if (!settings) return
    if (notifiedIds.has(notification.id)) return

    const conversations = useConversationsStore()
    const conversation = notification.conversationId
      ? conversations.byId.get(notification.conversationId)
      : undefined
    const visible = Boolean(
      notification.conversationId && conversations.activeId === notification.conversationId,
    )
    const focused =
      typeof document === 'undefined' ||
      (document.visibilityState === 'visible' && document.hasFocus())

    const allowed = shouldShowSystemNotification({
      kind: kindOf(notification),
      settings,
      conversationLevel: levelOf(conversation?.notificationLevel),
      mentioned: notification.type === 'mention',
      conversationVisible: visible,
      appFocused: focused,
    })
    if (!allowed) return

    notifiedIds.add(notification.id)
    const result = await sendSystemNotification({
      title: notification.title,
      body: systemNotificationBody(settings.showPreview, notification.body),
      conversationId: notification.conversationId,
      notificationId: notification.id,
    })

    // 浏览器未授权或环境不支持时，降级为应用内提示
    if (result === 'fallback') {
      showToast(notification)
      if (settings.soundEnabled) playNotificationSound()
    }
  }

  async function markRead(ids: string[]): Promise<void> {
    const targets = items.value.filter((item) => ids.includes(item.id) && !item.isRead)
    if (targets.length === 0) return
    const changedIds = targets.map((item) => item.id)
    for (const item of targets) item.isRead = true
    unreadTotal.value = Math.max(0, unreadTotal.value - targets.length)

    if (hasLocalDb() && serverId.value) await markNotificationsRead(serverId.value, changedIds)
    try {
      const result = await notificationApi.markRead({ ids: changedIds })
      for (const notification of result.notifications) {
        const index = items.value.findIndex((item) => item.id === notification.id)
        if (index >= 0) items.value[index] = notification
      }
    } catch {
      /* 断网时先本地已读，重连后由同步记录纠正 */
    }
  }

  async function markAllRead(): Promise<void> {
    const unread = items.value.filter((item) => !item.isRead)
    if (unread.length === 0 && unreadTotal.value === 0) return
    for (const item of items.value) item.isRead = true
    unreadTotal.value = 0

    if (hasLocalDb() && serverId.value) await markAllNotificationsRead(serverId.value)
    try {
      const result = await notificationApi.markRead({ all: true })
      for (const notification of result.notifications) {
        const index = items.value.findIndex((item) => item.id === notification.id)
        if (index >= 0) items.value[index] = notification
      }
    } catch {
      /* 同上，离线可用 */
    }
  }

  /** 点击通知：标记已读并跳到对应会话 */
  async function open(notification: AppNotification): Promise<void> {
    panelOpen.value = false
    dismissToast()
    if (!notification.isRead) await markRead([notification.id])
    if (notification.conversationId) void router.push(`/c/${notification.conversationId}`)
  }

  function openById(notificationId?: string | null, conversationId?: string | null): void {
    panelOpen.value = false
    dismissToast()
    const target = notificationId ? items.value.find((item) => item.id === notificationId) : undefined
    if (target) {
      void open(target)
      return
    }
    if (conversationId) void router.push(`/c/${conversationId}`)
  }

  /** 启动时注册一次系统通知点击回调，并读取当前权限 */
  async function initSystemNotifications(): Promise<void> {
    if (!clickBound) {
      clickBound = true
      onSystemNotificationClick(({ notificationId, conversationId }) => {
        openById(notificationId, conversationId)
      })
    }
    permission.value = await getNotificationPermission()
  }

  async function requestPermission(): Promise<SystemNotificationPermission> {
    permission.value = await requestNotificationPermission()
    return permission.value
  }

  async function refreshPermission(): Promise<void> {
    permission.value = await getNotificationPermission()
  }

  function togglePanel(open?: boolean): void {
    panelOpen.value = open ?? !panelOpen.value
  }

  function reset(): void {
    items.value = []
    unreadTotal.value = 0
    hasMore.value = false
    panelOpen.value = false
    dismissToast()
    notifiedIds.clear()
  }

  return {
    items,
    unreadTotal,
    unreadCount,
    hasMore,
    loading,
    panelOpen,
    toast,
    permission,
    hydrate,
    refresh,
    loadMore,
    receive,
    applyUpdated,
    markRead,
    markAllRead,
    open,
    openById,
    initSystemNotifications,
    requestPermission,
    refreshPermission,
    togglePanel,
    dismissToast,
    reset,
  }
})
