<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import type { ConversationSummary } from '@/api/endpoints'

import { useConversationTitle } from '@/composables/conversation'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{
  conversation: ConversationSummary
  typingNames?: string[]
  memberCount?: number
  showMembers?: boolean
  /** 右侧日程面板是否展开 */
  scheduleActive?: boolean
  backable?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-members'): void
  (e: 'open-memory'): void
  (e: 'toggle-schedule'): void
  (e: 'open-settings'): void
  (e: 'back'): void
}>()

const ui = useUiStore()
const isGroup = computed(() => props.conversation.type === 'group')
const isAi = computed(() => props.conversation.type === 'ai')

const titleOf = useConversationTitle()
const title = computed(() => titleOf(props.conversation))

const subtitle = computed(() => {
  if (props.typingNames && props.typingNames.length > 0) {
    const names = props.typingNames.slice(0, 3).join('、')
    return `${names} 正在输入…`
  }
  if (isGroup.value) {
    return `${props.memberCount ?? 0} 位成员`
  }
  // AI 会话名下一律留空：这行原本写着「AI 角色 · 会主动找你」之类的说明
  if (isAi.value) return ''
  return '私聊'
})
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
      v-if="backable"
      type="button"
      class="rounded-md p-1.5 text-muted active:bg-surface-2"
      title="返回"
      @click="emit('back')"
    >
      <Icon name="arrowLeft" :size="20" />
    </button>

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        <h1 class="truncate text-[14px] font-semibold text-text-strong">{{ title }}</h1>
        <span
          v-if="isAi"
          class="rounded bg-mention-soft px-1.5 py-0.5 text-[10px] font-medium text-mention"
        >
          AI
        </span>
      </div>
      <p v-if="subtitle" class="truncate text-[11.5px] text-muted">{{ subtitle }}</p>
    </div>

    <div class="flex items-center gap-0.5">
      <IconButton
        v-if="isAi"
        icon="memory"
        label="记忆"
        :size="17"
        :active="showMembers"
        @click="emit('open-memory')"
      />
      <IconButton
        v-if="isAi"
        icon="calendar"
        label="今日日程"
        :size="17"
        :active="scheduleActive"
        @click="emit('toggle-schedule')"
      />
      <IconButton v-if="!ui.isMobile" icon="search" label="搜索（即将开放）" :size="17" />
      <IconButton
        v-if="isGroup"
        icon="panelRight"
        label="成员列表"
        :size="17"
        :active="showMembers"
        @click="emit('toggle-members')"
      />
      <IconButton icon="settings" label="会话设置" :size="17" @click="emit('open-settings')" />
    </div>
  </header>
</template>
