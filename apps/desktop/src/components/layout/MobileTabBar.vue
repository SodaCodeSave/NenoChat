<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/ui/Icon.vue'
import Badge from '@/components/ui/Badge.vue'
import type { IconName } from '@/components/ui/icons'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const conversations = useConversationsStore()

const tabs: Array<{ key: 'messages' | 'contacts' | 'moments' | 'me'; icon: IconName; label: string; to: string }> = [
  { key: 'messages', icon: 'message', label: '消息', to: '/' },
  { key: 'contacts', icon: 'users', label: '通讯录', to: '/contacts' },
  { key: 'moments', icon: 'compass', label: '动态', to: '/moments' },
  { key: 'me', icon: 'user', label: '我的', to: '/settings' },
]

const active = computed(() => {
  if (route.path.startsWith('/contacts')) return 'contacts'
  if (route.path.startsWith('/moments')) return 'moments'
  if (route.path.startsWith('/settings')) return 'me'
  return 'messages'
})

function go(tab: { key: string; to: string }): void {
  ui.mobileTab = tab.key as typeof ui.mobileTab
  void router.push(tab.to)
}
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface/95 pb-[var(--safe-bottom)] backdrop-blur"
  >
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      class="relative flex h-[var(--mobile-tab-h)] flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] transition-colors active:bg-surface-2"
      :class="active === tab.key ? 'text-accent' : 'text-muted'"
      :aria-current="active === tab.key ? 'page' : undefined"
      @click="go(tab)"
    >
      <Icon :name="tab.icon" :size="21" />
      <span>{{ tab.label }}</span>
      <span
        v-if="tab.key === 'messages' && conversations.totalUnread > 0"
        class="absolute top-1.5 right-1/4"
      >
        <Badge :count="conversations.totalUnread" />
      </span>
    </button>
  </nav>
</template>
