<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import Avatar from '@/components/ui/Avatar.vue'
import Badge from '@/components/ui/Badge.vue'
import Icon from '@/components/ui/Icon.vue'
import type { ConversationSummary } from '@/api/endpoints'
import {
  conversationAvatar,
  conversationSeed,
  conversationTitle,
  formatListTime,
  messagePreview,
} from '@/composables/conversation'
import { useMessagesStore } from '@/stores/messages'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{ conversation: ConversationSummary; active?: boolean }>()
const emit = defineEmits<{ (e: 'select', id: string): void; (e: 'context', payload: { id: string; x: number; y: number }): void }>()

const messages = useMessagesStore()
const conversations = useConversationsStore()
const ui = useUiStore()

const title = computed(() => conversationTitle(props.conversation))
const preview = computed(() => {
  const last = messages.lastMessageOf(props.conversation.id)
  if (last) return messagePreview(last)
  return props.conversation.type === 'ai' ? '开始和 AI 聊天吧' : '还没有消息'
})

const isAi = computed(() => props.conversation.type === 'ai')
const pinned = computed(() => Boolean(props.conversation.pinnedAt))
const unread = computed(() => props.conversation.unreadCount ?? 0)
const mentions = computed(() => props.conversation.mentionCount ?? 0)

function openContextMenu(event: MouseEvent): void {
  if (ui.isMobile) return
  event.preventDefault()
  emit('context', { id: props.conversation.id, x: event.clientX, y: event.clientY })
}

/* ------------------------- 手机端长按菜单 ------------------------- */

let pressTimer = 0
let startX = 0
let startY = 0
let longPressed = false

function clearPress(): void {
  window.clearTimeout(pressTimer)
  pressTimer = 0
}

function onTouchStart(event: TouchEvent): void {
  if (!ui.isMobile) return
  const touch = event.touches[0]
  if (!touch) return
  startX = touch.clientX
  startY = touch.clientY
  longPressed = false
  clearPress()
  pressTimer = window.setTimeout(() => {
    longPressed = true
    emit('context', { id: props.conversation.id, x: startX, y: startY })
    // 部分 WebView 长按后不会再派发 click，兜底恢复，避免吞掉下一次点击
    window.setTimeout(() => {
      longPressed = false
    }, 600)
  }, 450)
}

function onTouchMove(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch || !pressTimer) return
  if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) clearPress()
}

function onTap(): void {
  // 长按已经弹出菜单，抬手时不要再触发进入会话
  if (longPressed) {
    longPressed = false
    return
  }
  emit('select', props.conversation.id)
}

onBeforeUnmount(clearPress)

async function togglePin(event: MouseEvent): Promise<void> {
  event.stopPropagation()
  await conversations.pin(props.conversation.id, !pinned.value)
}
</script>

<template>
  <div
    class="group relative flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors active:bg-surface-3"
    :class="[
      props.active ? 'bg-accent-soft' : 'hover:bg-surface-2',
      isAi && !props.active ? 'bg-surface-2/60' : '',
    ]"
    @click="onTap"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend="clearPress"
    @touchcancel="clearPress"
    @contextmenu="openContextMenu"
  >
    <Avatar
      :name="title"
      :src="conversationAvatar(props.conversation)"
      :seed="conversationSeed(props.conversation)"
      :size="40"
      :square="props.conversation.type === 'group'"
    />

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1">
        <span class="truncate text-[13.5px] font-medium text-text-strong">{{ title }}</span>
        <Icon v-if="isAi" name="sparkles" :size="12" class="text-mention" />
        <Icon v-if="pinned" name="pin" :size="12" class="text-muted" />
        <span class="ml-auto shrink-0 text-[11px] text-muted">
          {{ formatListTime(props.conversation.lastMessageAt ?? props.conversation.updatedAt) }}
        </span>
      </div>
      <div class="mt-0.5 flex items-center gap-1">
        <span class="truncate text-[12px] text-muted">{{ preview }}</span>
        <span class="ml-auto flex shrink-0 items-center gap-1">
          <Badge v-if="mentions > 0" :count="mentions" tone="mention" />
          <Badge v-else-if="unread > 0" :count="unread" />
        </span>
      </div>
    </div>

    <button
      v-if="!ui.isMobile"
      type="button"
      class="absolute top-1.5 right-1.5 hidden rounded-md bg-surface/80 p-1 text-muted backdrop-blur group-hover:block hover:text-text"
      :title="pinned ? '取消置顶' : '置顶会话'"
      @click.stop="togglePin"
    >
      <Icon name="pin" :size="13" />
    </button>
  </div>
</template>
