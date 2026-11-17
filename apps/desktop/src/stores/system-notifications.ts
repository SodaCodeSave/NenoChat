import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message, NotificationLevel } from '@nenochat/shared'
import {
  messageNotificationKind,
  notificationPreview,
  shouldShowSystemNotification,
  systemNotificationBody,
} from '@nenochat/shared/notifications/rules'
import { router } from '@/app/router'
import {
  getNotificationPermission,
  isAppWindowFocused,
  onSystemNotificationClick,
  playNotificationSound,
  requestNotificationPermission,
  sendSystemNotification,
  type SystemNotificationPermission,
} from '@/platform/system-notification'
import { useAuthStore } from './auth'
import { useConversationsStore } from './conversations'

const SENT_CACHE_LIMIT = 300

function levelOf(value?: string | null): NotificationLevel | null {
  return value === 'all' || value === 'mentions' || value === 'none'
    ? (value as NotificationLevel)
    : null
}

/**
 * 系统通知：直接消费 message.created，按设置与免打扰决定是否弹窗。
 * 不保存通知历史，主页的未读状态就是唯一的消息入口。
 */
export const useSystemNotificationsStore = defineStore('systemNotifications', () => {
  const permission = ref<SystemNotificationPermission>('default')

  let clickBound = false
  const sentMessages = new Set<string>()

  function remember(messageId: string): void {
    sentMessages.add(messageId)
    if (sentMessages.size <= SENT_CACHE_LIMIT) return
    const oldest = sentMessages.values().next().value
    if (oldest) sentMessages.delete(oldest)
  }

  /** 启动时注册一次点击回调，并读取当前系统权限 */
  async function init(): Promise<void> {
    if (!clickBound) {
      clickBound = true
      onSystemNotificationClick(({ conversationId }) => {
        if (conversationId) void router.push(`/c/${conversationId}`)
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

  /** 新消息到达：门控通过才调用系统通知 */
  async function onMessageCreated(message: Message): Promise<void> {
    const auth = useAuthStore()
    const settings = auth.notificationSettings
    if (!settings || !auth.user) return
    if (message.deletedAt) return
    if (sentMessages.has(message.id)) return

    const conversations = useConversationsStore()
    const conversation = conversations.byId.get(message.conversationId)
    const mentioned =
      message.meta?.mentionAll === true ||
      (message.meta?.mentions ?? []).includes(auth.user.id)

    const kind = messageNotificationKind({
      conversationType: conversation?.type ?? 'direct',
      senderType: message.senderType,
      senderId: message.senderId,
      selfId: auth.user.id,
      mentioned,
      proactive: message.meta?.ai?.proactive === true,
      aiIndex: message.aiIndex ?? message.meta?.ai?.index ?? null,
    })
    if (!kind) return

    const focused = await isAppWindowFocused()
    const allowed = shouldShowSystemNotification({
      kind,
      settings,
      conversationLevel: levelOf(conversation?.notificationLevel),
      mentioned,
      conversationVisible: conversations.activeId === message.conversationId,
      appFocused: focused,
    })
    if (!allowed) return

    remember(message.id)
    const preview = notificationPreview(message.type, message.content)
    const delivered = await sendSystemNotification({
      title: conversation?.name || conversation?.partnerName || '新消息',
      body: systemNotificationBody(settings.showPreview, preview),
      conversationId: message.conversationId,
      silent: !settings.soundEnabled,
    })
    if (!delivered && settings.soundEnabled) playNotificationSound()
  }

  /** 设置页的测试通知，用来确认 Windows 授权与系统设置是否放行 */
  async function sendTest(): Promise<boolean> {
    const settings = useAuthStore().notificationSettings
    return sendSystemNotification({
      title: 'NenoChat',
      body: systemNotificationBody(settings?.showPreview ?? true, '这是一条测试通知'),
      silent: !(settings?.soundEnabled ?? true),
    })
  }

  return {
    permission,
    init,
    requestPermission,
    refreshPermission,
    onMessageCreated,
    sendTest,
  }
})
