<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Message } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{
  message: Message
  x: number
  y: number
  isOwn: boolean
  canPin: boolean
}>()

const ui = useUiStore()

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
/** 长按弹出后，抬手产生的合成 click 不能立刻把面板关掉 */
const openedAt = ref(Date.now())

watch(
  () => props.message.id,
  () => {
    confirming.value = false
    openedAt.value = Date.now()
  },
)

function requestClose(): void {
  if (Date.now() - openedAt.value < 350) return
  emit('close')
}

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

/** 手机端底部面板的条目样式，桌面端保持紧凑浮层 */
const itemClass = computed(() =>
  ui.isMobile
    ? 'flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] text-text active:bg-surface-2'
    : 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2',
)
const dangerClass = computed(() =>
  ui.isMobile
    ? 'flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] text-danger active:bg-danger/10'
    : 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-danger hover:bg-danger/10',
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

function onDocumentPointerDown(event: PointerEvent): void {
  if (ui.isMobile) return
  if (menu.value && !menu.value.contains(event.target as Node)) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.isMobile" class="animate-fade-in fixed inset-0 z-50 bg-black/40" @click.self="requestClose" />

    <div
      ref="menu"
      class="fixed z-50 border-line bg-surface"
      :class="
        ui.isMobile
          ? 'animate-sheet-up inset-x-0 bottom-0 rounded-t-2xl border-t pb-[var(--safe-bottom)]'
          : 'animate-rise-in w-[168px] rounded-xl border py-1 shadow-[var(--shadow-soft)]'
      "
      :style="ui.isMobile ? undefined : position"
    >
      <p
        v-if="ui.isMobile"
        class="border-b border-line px-4 py-2.5 text-center text-[12px] text-muted"
      >
        消息操作
      </p>

      <template v-if="!confirming">
        <button type="button" :class="itemClass" @click="emit('reply'); emit('close')">
          <Icon name="reply" :size="ui.isMobile ? 17 : 14" /> 回复
        </button>
        <button type="button" :class="itemClass" @click="copyText">
          <Icon name="copy" :size="ui.isMobile ? 17 : 14" /> 复制文本
        </button>
        <button
          v-if="canEdit"
          type="button"
          :class="itemClass"
          @click="emit('edit'); emit('close')"
        >
          <Icon name="edit" :size="ui.isMobile ? 17 : 14" /> 编辑
        </button>
        <button
          v-if="canPin"
          type="button"
          :class="itemClass"
          @click="emit('pin'); emit('close')"
        >
          <Icon name="pin" :size="ui.isMobile ? 17 : 14" />
          {{ message.pinnedAt ? '取消置顶' : '置顶' }}
        </button>
        <div class="my-1 h-px bg-line" />
        <button v-if="isOwn" type="button" :class="dangerClass" @click="confirming = true">
          <Icon name="trash" :size="ui.isMobile ? 17 : 14" /> 撤回
        </button>
        <button v-else type="button" :class="itemClass" @click="emit('close')">
          关闭
        </button>
        <button
          v-if="ui.isMobile"
          type="button"
          class="w-full border-t border-line py-3.5 text-[15px] text-muted active:bg-surface-2"
          @click="emit('close')"
        >
          取消
        </button>
      </template>

      <template v-else>
        <p class="px-3 py-1.5 text-[12px] text-text" :class="ui.isMobile ? 'px-4 pt-3 text-[14px]' : ''">
          撤回这条消息？
        </p>
        <div class="flex gap-1 px-2 pb-1" :class="ui.isMobile ? 'px-4 pb-3 pt-2' : ''">
          <button
            type="button"
            class="flex-1 rounded-lg bg-danger px-2 py-1 text-[12px] font-medium text-white"
            :class="ui.isMobile ? 'py-2.5 text-[14px]' : ''"
            @click="emit('recall'); emit('close')"
          >
            撤回
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg border border-line px-2 py-1 text-[12px] text-muted hover:text-text"
            :class="ui.isMobile ? 'py-2.5 text-[14px]' : ''"
            @click="confirming = false"
          >
            取消
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>
