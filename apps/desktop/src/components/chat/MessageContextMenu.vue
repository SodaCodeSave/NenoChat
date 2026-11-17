<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Message } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'

const props = defineProps<{
  message: Message
  x: number
  y: number
  isOwn: boolean
  canPin: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'reply'): void
  (e: 'edit'): void
  (e: 'pin'): void
  (e: 'recall'): void
  (e: 'copied'): void
}>()

const menu = ref<HTMLElement | null>(null)
const confirming = ref(false)

/** 菜单不能超出视口 */
const position = computed(() => {
  const width = 168
  const height = confirming.value ? 116 : 190
  return {
    left: `${Math.min(props.x, window.innerWidth - width - 12)}px`,
    top: `${Math.min(props.y, window.innerHeight - height - 12)}px`,
  }
})

const canEdit = computed(
  () => props.isOwn && props.message.type === 'text' && !props.message.deletedAt,
)

async function copyText(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.message.content)
    emit('copied')
  } catch {
    /* 无剪贴板权限时静默失败，不打断操作 */
  }
  emit('close')
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (menu.value && !menu.value.contains(event.target as Node)) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="fixed z-50 w-[168px] rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-soft)]"
      :style="position"
    >
      <template v-if="!confirming">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
          @click="emit('reply'); emit('close')"
        >
          <Icon name="reply" :size="14" /> 回复
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
          @click="copyText"
        >
          <Icon name="copy" :size="14" /> 复制文本
        </button>
        <button
          v-if="canEdit"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
          @click="emit('edit'); emit('close')"
        >
          <Icon name="edit" :size="14" /> 编辑
        </button>
        <button
          v-if="canPin"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
          @click="emit('pin'); emit('close')"
        >
          <Icon name="pin" :size="14" /> {{ message.pinnedAt ? '取消置顶' : '置顶' }}
        </button>
        <div class="my-1 h-px bg-line" />
        <button
          v-if="isOwn"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-danger hover:bg-danger/10"
          @click="confirming = true"
        >
          <Icon name="trash" :size="14" /> 撤回
        </button>
        <button
          v-else
          type="button"
          class="w-full px-3 py-1.5 text-left text-[12.5px] text-muted"
          @click="emit('close')"
        >
          关闭
        </button>
      </template>

      <template v-else>
        <p class="px-3 py-1.5 text-[12px] text-text">撤回这条消息？</p>
        <div class="flex gap-1 px-2 pb-1">
          <button
            type="button"
            class="flex-1 rounded-lg bg-danger px-2 py-1 text-[12px] font-medium text-white"
            @click="emit('recall'); emit('close')"
          >
            撤回
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg border border-line px-2 py-1 text-[12px] text-muted hover:text-text"
            @click="confirming = false"
          >
            取消
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>
