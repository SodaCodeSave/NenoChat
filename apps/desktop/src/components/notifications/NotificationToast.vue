<script setup lang="ts">
import Icon from '@/components/ui/Icon.vue'
import { useNotificationsStore } from '@/stores/notifications'

const notifications = useNotificationsStore()

function openToast(): void {
  if (notifications.toast) void notifications.open(notifications.toast)
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="notifications.toast"
      class="fixed right-3 z-50 flex w-[320px] max-w-[calc(100vw-1.5rem)] cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-surface p-3 shadow-[var(--shadow-soft)] bottom-[calc(var(--mobile-tab-h)+var(--safe-bottom)+0.75rem)] md:bottom-4 md:right-4"
      @click="openToast"
    >
      <span class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
        <Icon name="bell" :size="15" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="truncate text-[13px] font-medium text-text-strong">{{ notifications.toast.title }}</p>
        <p class="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
          {{ notifications.toast.body || '你收到一条新消息' }}
        </p>
      </div>
      <button
        type="button"
        class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
        title="关闭"
        @click.stop="notifications.dismissToast()"
      >
        <Icon name="close" :size="13" />
      </button>
    </div>
  </Teleport>
</template>
