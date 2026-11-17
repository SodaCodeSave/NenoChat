import { useAuthStore } from '@/stores/auth'
import { useAiStore } from '@/stores/ai'
import { useChannelsStore } from '@/stores/channels'
import { useContactsStore } from '@/stores/contacts'
import { useConversationsStore } from '@/stores/conversations'
import { useMembersStore } from '@/stores/members'
import { useMessagesStore } from '@/stores/messages'
import { useNotificationsStore } from '@/stores/notifications'
import { useServersStore } from '@/stores/servers'
import { useSyncStore } from '@/stores/sync'
import { hasLocalDb } from '@/platform/db'

export type BootstrapStage = 'starting' | 'server' | 'auth' | 'cache' | 'realtime' | 'ready' | 'error'

/**
 * 启动顺序：服务器 → 登录态 → 本地镜像 → 实时连接。
 * 首屏始终先读本地 SQLite，网络只做增强，断网也能看到历史。
 */
export async function bootstrap(
  onStage: (stage: BootstrapStage, detail?: string) => void = () => {},
): Promise<boolean> {
  try {
    onStage('server')
    const servers = useServersStore()
    await servers.hydrate()

    if (!servers.current) {
      onStage('ready')
      return false
    }

    onStage('auth')
    const auth = useAuthStore()
    auth.bindServer()
    const restored = await auth.bootstrap()
    if (!restored) {
      onStage('ready')
      return false
    }

    onStage('cache')
    const conversations = useConversationsStore()
    await conversations.hydrate()
    // 本地镜像先出，再后台刷新，保证列表不会空屏
    void conversations.refresh()
      .catch(() => undefined)
      .then(() => useMessagesStore().preload(conversations.ordered.map((c) => c.id)))
    // 角色列表供通讯录与 AI 分区使用，离线时读本地镜像
    void useAiStore().load().catch(() => undefined)

    // 通知中心先出本地缓存，再后台刷新；同时挂好系统通知点击回调
    const notifications = useNotificationsStore()
    await notifications.hydrate()
    void notifications.refresh().catch(() => undefined)
    void notifications.initSystemNotifications()

    onStage('realtime')
    const sync = useSyncStore()
    sync.connect().catch((e) => {
      console.warn('[bootstrap] 实时连接失败，稍后自动重试', e)
    })

    onStage('ready')
    return true
  } catch (e) {
    onStage('error', e instanceof Error ? e.message : '启动失败')
    return false
  }
}

/** 切换服务器或退出登录时清空所有内存态，避免两个服务器的数据串台 */
export function resetWorkspace(): void {
  useConversationsStore().reset()
  useMessagesStore().reset()
  useChannelsStore().reset()
  useMembersStore().reset()
  useContactsStore().reset()
  useNotificationsStore().reset()
  useSyncStore().disconnect()
  useSyncStore().reset()
  if (!hasLocalDb()) {
    // 浏览器模式没有本地库，切换服务器后需要重新拉取
    void useConversationsStore().refresh().catch(() => undefined)
  }
}
