<script setup lang="ts">
import Icon from '@/components/ui/Icon.vue'
import { useUiStore } from '@/stores/ui'

/**
 * 多选模式的顶部工具栏：替换 ChatHeader 显示已选数量与批量操作。
 * 「生成截图」未选中任何消息时禁用，与转发的可用条件一致。
 */
defineProps<{ count: number }>()

const emit = defineEmits<{
  (e: 'cancel'): void
  (e: 'forward'): void
  (e: 'screenshot'): void
}>()

const ui = useUiStore()
</script>

<template>
  <header
    class="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3"
    :class="
      ui.isMobile
        ? 'min-h-[calc(3.25rem+var(--safe-top))] pt-[var(--safe-top)]'
        : 'h-14'
    "
    data-tauri-drag-region
  >
    <button
      type="button"
      class="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
      title="退出多选"
      aria-label="退出多选"
      @click="emit('cancel')"
    >
      <Icon name="close" :size="18" />
    </button>

    <p class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-strong">
      已选 {{ count }} 条
    </p>

    <button
      type="button"
      class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12.5px] text-text hover:bg-surface-2 disabled:opacity-40"
      :disabled="count === 0"
      @click="emit('screenshot')"
    >
      <Icon name="camera" :size="15" /> 生成截图
    </button>
    <button
      type="button"
      class="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
      :disabled="count === 0"
      @click="emit('forward')"
    >
      <Icon name="forward" :size="15" /> 转发
    </button>
  </header>
</template>
