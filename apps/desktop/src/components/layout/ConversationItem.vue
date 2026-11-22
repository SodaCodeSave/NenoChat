<script setup lang="ts">
import { computed } from 'vue'
import Avatar from '@/components/ui/Avatar.vue'
import Badge from '@/components/ui/Badge.vue'
import Icon from '@/components/ui/Icon.vue'
import type { ConversationSummary } from '@/api/endpoints'
import {
  conversationAvatar,
  conversationSeed,
  formatListTime,
  useConversationTitle,
  messagePreview,
  messagePreviewFromSummary,
} from '@/composables/conversation'
import { useLongPress } from '@/composables/use-long-press'
import { useMessagesStore } from '@/stores/messages'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{ conversation: ConversationSummary; active?: boolean }>()
const emit = defineEmits<{ (e: 'select', id: string): void; (e: 'context', payload: { id: string; x: number; y: number }): void }>()

const messages = useMessagesStore()
const conversations = useConversationsStore()
const ui = useUiStore()

const titleOf = useConversationTitle()
const title = computed(() => titleOf(props.conversation))
const preview = computed(() => {
  // 已加载的消息桶优先（实时最新），没加载则用列表接口带的摘要，启动时全部会话都有预览
  const last = messages.lastMessageOf(props.conversation.id)
  if (last) return messagePreview(last)
  const fromSummary = messagePreviewFromSummary(props.conversation.lastMessageSummary)
  if (fromSummary) return fromSummary
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

const press = useLongPress((x, y) => emit('context', { id: props.conversation.id, x, y }))

function onTouchStart(event: TouchEvent): void {
  if (!ui.isMobile) return
  press.onTouchStart(event)
}

function onTap(): void {
  // 长按已经弹出菜单，抬手时不要再触发进入会话
  if (press.consumeLongPressed()) return
  emit('select', props.conversation.id)
}

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
    @touchmove.passive="press.onTouchMove"
    @touchend="press.onTouchEnd"
    @touchcancel="press.onTouchEnd"
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
