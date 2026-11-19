import { useAuthStore } from '@/stores/auth'
import { useAiStore } from '@/stores/ai'
import { useContactsStore } from '@/stores/contacts'
import { useConversationsStore } from '@/stores/conversations'
import { useMembersStore } from '@/stores/members'
import { useMessagesStore } from '@/stores/messages'
import { useSystemNotificationsStore } from '@/stores/system-notifications'
import { useServersStore } from '@/stores/servers'
import { useSyncStore } from '@/stores/sync'
import { hasLocalDb } from '@/platform/db'
import { initFileCache } from '@/platform/file-cache'

export type BootstrapStage = 'starting' | 'server' | 'auth' | 'cache' | 'realtime' | 'ready' | 'error'

/** 启动时预载消息的会话数上限：只保最近一屏，避免冷启动把全部历史都拉一遍 */
const PRELOAD_RECENT = 10

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
    // 附件缓存索引先就绪，消息列表渲染时才能优先命中本地 blob
    void initFileCache()
    const conversations = useConversationsStore()
    await conversations.hydrate()
    // 本地镜像先出，再后台刷新，保证列表不会空屏
    void conversations.refresh()
      .catch(() => undefined)
      // 只预载最近一屏会话的消息，剩下的点开时再按需拉取
      .then(() => useMessagesStore().preload(conversations.ordered.slice(0, PRELOAD_RECENT).map((c) => c.id)))
    // 角色列表供通讯录与 AI 分区使用，离线时读本地镜像
    void useAiStore().load().catch(() => undefined)
    // 好友关系决定私聊标题是否带临时标记，启动即拉取
    void useContactsStore().load().catch(() => undefined)

    // 挂好系统通知点击回调并同步当前权限；通知本身由 message.created 直接触发
    void useSystemNotificationsStore().init()

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
  useMembersStore().reset()
  useContactsStore().reset()
  useSyncStore().disconnect()
  useSyncStore().reset()
  if (!hasLocalDb()) {
    // 浏览器模式没有本地库，切换服务器后需要重新拉取
    void useConversationsStore().refresh().catch(() => undefined)
  }
}
