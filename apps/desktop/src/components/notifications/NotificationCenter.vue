<script setup lang="ts">
import { computed } from 'vue'
import type { AppNotification } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import type { IconName } from '@/components/ui/icons'
import { useNotificationsStore } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'

const notifications = useNotificationsStore()
const ui = useUiStore()

const iconByType: Record<AppNotification['type'], IconName> = {
  mention: 'at',
  dm: 'message',
  group: 'users',
  group_ai: 'sparkles',
  ai_proactive: 'sparkles',
  post_like: 'heart',
  post_comment: 'comment',
  system: 'bell',
}

function dayStart(offsetDays = 0): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime() - offsetDays * 24 * 60 * 60 * 1000
}

function dayLabel(timestamp: number): string {
  if (timestamp >= dayStart()) return '今天'
  if (timestamp >= dayStart(1)) return '昨天'
  const date = new Date(timestamp)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  if (timestamp >= dayStart(1)) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

const groups = computed(() => {
  const result: Array<{ label: string; items: AppNotification[] }> = []
  for (const item of notifications.items) {
    const label = dayLabel(item.createdAt)
    const last = result[result.length - 1]
    if (last && last.label === label) last.items.push(item)
    else result.push({ label, items: [item] })
  }
  return result
})
</script>

<template>
  <Teleport to="body">
    <div v-if="notifications.panelOpen" class="fixed inset-0 z-40" @click="notifications.togglePanel(false)">
      <div class="absolute inset-0 bg-black/30 md:bg-black/10" />

      <aside
        class="absolute inset-y-0 right-0 flex w-full flex-col border-line bg-surface shadow-2xl md:w-[380px] md:border-l"
        @click.stop
      >
        <header
          class="flex shrink-0 items-center gap-2 border-b border-line px-4 pb-2"
          :class="ui.isMobile ? 'pt-[calc(0.75rem+var(--safe-top))]' : 'h-14'"
        >
          <Icon name="bell" :size="18" class="text-accent" />
          <h2 class="text-[15px] font-semibold text-text-strong">通知中心</h2>
          <div class="ml-auto flex items-center gap-1">
            <button
              v-if="notifications.unreadTotal > 0"
              type="button"
              class="rounded-md px-2 py-1 text-[12px] text-accent hover:bg-accent-soft"
              @click="notifications.markAllRead()"
            >
              全部已读
            </button>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
              title="关闭"
              @click="notifications.togglePanel(false)"
            >
              <Icon name="close" :size="16" />
            </button>
          </div>
        </header>

        <div class="scroll-area flex-1 px-2 py-2">
          <p
            v-if="notifications.loading && notifications.items.length === 0"
            class="py-10 text-center text-[12.5px] text-muted"
          >
            加载中…
          </p>

          <div
            v-else-if="notifications.items.length === 0"
            class="mt-16 flex flex-col items-center gap-2 px-6 text-center text-[12.5px] text-muted"
          >
            <Icon name="bellOff" :size="30" class="opacity-40" />
            <p>还没有通知，新消息和 @ 提及会出现在这里</p>
          </div>

          <template v-else>
            <section v-for="group in groups" :key="group.label" class="mb-2">
              <p class="px-2 py-1 text-[11px] font-medium tracking-wide text-muted">{{ group.label }}</p>
              <button
                v-for="item in group.items"
                :key="item.id"
                type="button"
                class="mb-0.5 flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
                @click="notifications.open(item)"
              >
                <span
                  class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full"
                  :class="item.type === 'mention' ? 'bg-mention-soft text-mention' : 'bg-surface-2 text-muted'"
                >
                  <Icon :name="iconByType[item.type] ?? 'bell'" :size="15" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[13px] font-medium text-text-strong">{{ item.title }}</span>
                    <span
                      v-if="!item.isRead"
                      class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    />
                    <span class="ml-auto shrink-0 text-[10.5px] text-muted">{{ timeLabel(item.createdAt) }}</span>
                  </span>
                  <span class="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-muted">
                    {{ item.body || '点击查看' }}
                  </span>
                </span>
              </button>
            </section>

            <button
              v-if="notifications.hasMore"
              type="button"
              class="mb-4 mt-1 w-full rounded-lg py-2 text-[12px] text-muted hover:bg-surface-2 hover:text-text"
              :disabled="notifications.loading"
              @click="notifications.loadMore()"
            >
              {{ notifications.loading ? '加载中…' : '加载更多' }}
            </button>
          </template>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
