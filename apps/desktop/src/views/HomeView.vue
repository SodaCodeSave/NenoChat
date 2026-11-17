<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/ui/Icon.vue'
import NewChatDialog from '@/components/layout/NewChatDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useServersStore } from '@/stores/servers'
import { useSyncStore } from '@/stores/sync'

const router = useRouter()
const auth = useAuthStore()
const servers = useServersStore()
const conversations = useConversationsStore()
const sync = useSyncStore()

const dialogOpen = ref(false)

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

const statusText = computed(() => {
  switch (sync.status) {
    case 'live':
      return '实时连接正常'
    case 'catching-up':
      return '正在补齐离线消息…'
    case 'connecting':
      return '正在建立连接…'
    case 'offline':
      return '当前离线，消息会在恢复后自动同步'
    default:
      return '尚未建立实时连接'
  }
})

function open(id: string): void {
  void router.push(`/c/${id}`)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4"
      data-tauri-drag-region
    >
      <h1 class="text-[14px] font-semibold text-text-strong">消息</h1>
      <span class="rounded bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-muted">
        {{ servers.current?.name ?? '未连接' }}
      </span>
    </header>

    <div class="scroll-area flex-1 px-6 py-10">
      <div class="mx-auto max-w-md text-center">
        <div
          class="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-accent-soft text-accent"
        >
          <Icon name="message" :size="30" />
        </div>
        <h2 class="text-[18px] font-semibold text-text-strong">
          {{ greeting }}，{{ auth.user?.displayName ?? '朋友' }}
        </h2>
        <p class="mt-1 text-[12.5px] text-muted">{{ statusText }}</p>

        <div class="mt-6 grid grid-cols-2 gap-2">
          <button
            type="button"
            class="flex flex-col items-start gap-1 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-accent"
            @click="dialogOpen = true"
          >
            <Icon name="plus" :size="16" class="text-accent" />
            <span class="text-[13px] font-medium text-text-strong">发起会话</span>
            <span class="text-[11.5px] text-muted">私聊或创建群聊</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-start gap-1 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-accent"
            @click="router.push('/contacts')"
          >
            <Icon name="users" :size="16" class="text-accent" />
            <span class="text-[13px] font-medium text-text-strong">通讯录</span>
            <span class="text-[11.5px] text-muted">搜索并添加好友</span>
          </button>
        </div>

        <div v-if="conversations.ordered.length > 0" class="mt-6 text-left">
          <p class="mb-2 text-[11px] font-medium tracking-wide text-muted">最近会话</p>
          <button
            v-for="item in conversations.ordered.slice(0, 6)"
            :key="item.id"
            type="button"
            class="mb-1 flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left hover:border-accent"
            @click="open(item.id)"
          >
            <Icon
              :name="item.type === 'ai' ? 'sparkles' : item.type === 'group' ? 'users' : 'message'"
              :size="14"
              class="text-muted"
            />
            <span class="min-w-0 flex-1 truncate text-[13px] text-text">
              {{ item.name ?? item.partnerName ?? '未命名会话' }}
            </span>
            <span v-if="(item.unreadCount ?? 0) > 0" class="text-[11px] text-accent">
              {{ item.unreadCount }}
            </span>
          </button>
        </div>

        <button
          type="button"
          class="mt-6 text-[12px] text-muted underline-offset-2 hover:text-accent hover:underline"
          @click="router.push('/settings')"
        >
          打开设置
        </button>
      </div>
    </div>

    <NewChatDialog v-if="dialogOpen" @close="dialogOpen = false" @created="open" />
  </div>
</template>
