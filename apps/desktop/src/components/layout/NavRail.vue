<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Avatar from '@/components/ui/Avatar.vue'
import Badge from '@/components/ui/Badge.vue'
import Icon from '@/components/ui/Icon.vue'
import type { IconName } from '@/components/ui/icons'
import { useAuthStore } from '@/stores/auth'
import { useContactsStore } from '@/stores/contacts'
import { useConversationsStore } from '@/stores/conversations'
import { useNotificationsStore } from '@/stores/notifications'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const contacts = useContactsStore()
const conversations = useConversationsStore()
const notifications = useNotificationsStore()
const sync = useSyncStore()

onMounted(() => {
  void contacts.load()
})

interface NavItem {
  key: 'messages' | 'contacts' | 'moments'
  icon: IconName
  label: string
  to: string
}

const items: NavItem[] = [
  { key: 'messages', icon: 'message', label: '消息', to: '/' },
  { key: 'contacts', icon: 'users', label: '通讯录', to: '/contacts' },
  { key: 'moments', icon: 'compass', label: '动态', to: '/moments' },
]

const activeKey = computed(() => {
  if (route.path.startsWith('/contacts')) return 'contacts'
  if (route.path.startsWith('/moments')) return 'moments'
  return 'messages'
})

const connectionTone = computed(() => {
  switch (sync.status) {
    case 'live':
      return { color: 'bg-success', label: '实时同步中' }
    case 'catching-up':
      return { color: 'bg-accent', label: '正在同步消息…' }
    case 'connecting':
      return { color: 'bg-muted', label: '正在连接…' }
    case 'offline':
      return { color: 'bg-danger', label: '离线，消息将在恢复后同步' }
    default:
      return { color: 'bg-muted', label: '未连接' }
  }
})
</script>

<template>
  <nav
    class="flex w-[64px] shrink-0 flex-col items-center gap-1 border-r border-line bg-rail py-3"
  >
    <!-- 头像入口 -->
    <button
      type="button"
      class="relative mb-2"
      title="我的账号"
      @click="router.push('/settings/account')"
    >
      <Avatar
        :name="auth.user?.displayName ?? '我'"
        :src="auth.user?.avatarUrl ?? null"
        :seed="auth.user?.id"
        :size="38"
        ring
      />
      <span
        class="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-rail"
        :class="connectionTone.color"
        :title="connectionTone.label"
      />
    </button>

    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="group relative flex h-11 w-11 flex-col items-center justify-center rounded-xl transition-colors"
      :class="
        activeKey === item.key
          ? 'bg-surface text-accent shadow-sm'
          : 'text-muted hover:bg-rail-active hover:text-text'
      "
      :title="item.label"
      @click="router.push(item.to)"
    >
      <Icon :name="item.icon" :size="20" />
      <span class="mt-0.5 text-[10px] leading-none">{{ item.label }}</span>

      <span
        v-if="item.key === 'messages' && conversations.totalUnread > 0"
        class="absolute -top-0.5 right-0.5"
      >
        <Badge :count="conversations.totalUnread" />
      </span>
      <span
        v-else-if="item.key === 'messages' && conversations.totalMentions > 0"
        class="absolute -top-0.5 right-0.5"
      >
        <Badge :count="conversations.totalMentions" tone="mention" />
      </span>
      <span
        v-else-if="item.key === 'contacts' && contacts.incomingCount > 0"
        class="absolute -top-0.5 right-0.5"
      >
        <Badge :count="contacts.incomingCount" tone="mention" />
      </span>
    </button>

    <div class="mt-auto flex flex-col items-center gap-1">
      <button
        type="button"
        class="relative grid h-9 w-9 place-items-center rounded-xl transition-colors"
        :class="
          notifications.panelOpen
            ? 'bg-surface text-accent shadow-sm'
            : 'text-muted hover:bg-rail-active hover:text-text'
        "
        title="通知中心"
        @click="notifications.togglePanel()"
      >
        <Icon name="bell" :size="18" />
        <span v-if="notifications.unreadTotal > 0" class="absolute -top-0.5 right-0">
          <Badge :count="notifications.unreadTotal" />
        </span>
      </button>
      <button
        type="button"
        class="grid h-9 w-9 place-items-center rounded-xl text-muted transition-colors hover:bg-rail-active hover:text-text"
        title="搜索（Ctrl+K）"
        @click="ui.commandOpen = true"
      >
        <Icon name="search" :size="18" />
      </button>
      <button
        type="button"
        class="grid h-9 w-9 place-items-center rounded-xl text-muted transition-colors hover:bg-rail-active hover:text-text"
        :title="ui.resolvedTheme === 'dark' ? '切换到浅色' : '切换到深色'"
        @click="ui.toggleTheme()"
      >
        <Icon :name="ui.resolvedTheme === 'dark' ? 'sun' : 'moon'" :size="18" />
      </button>
      <button
        type="button"
        class="grid h-9 w-9 place-items-center rounded-xl text-muted transition-colors hover:bg-rail-active hover:text-text"
        title="设置"
        @click="router.push('/settings')"
      >
        <Icon name="settings" :size="18" />
      </button>
    </div>
  </nav>
</template>
