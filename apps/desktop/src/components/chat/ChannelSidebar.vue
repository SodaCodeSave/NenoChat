<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import Avatar from '@/components/ui/Avatar.vue'
import type { Channel } from '@nenochat/shared'
import type { ConversationSummary } from '@/api/endpoints'
import { conversationTitle, conversationSeed, conversationAvatar } from '@/composables/conversation'

const props = defineProps<{
  conversation: ConversationSummary
  groups: Array<{ category: string; channels: Channel[] }>
  activeChannelId?: string | null
  memberCount?: number
}>()

const emit = defineEmits<{
  (e: 'select', channelId: string): void
  (e: 'open-settings'): void
  (e: 'create-channel'): void
}>()

const collapsed = ref<Record<string, boolean>>({})
const announcementOpen = ref(false)

const title = computed(() => conversationTitle(props.conversation))
const hasAnnouncement = computed(() => Boolean(props.conversation.announcement))

function toggle(category: string): void {
  collapsed.value[category] = !collapsed.value[category]
}
</script>

<template>
  <aside class="flex w-[236px] shrink-0 flex-col border-r border-line bg-surface-2">
    <!-- 群头部 -->
    <button
      type="button"
      class="flex items-center gap-2 border-b border-line px-3 py-3 text-left transition-colors hover:bg-surface-3"
      @click="emit('open-settings')"
    >
      <Avatar
        :name="title"
        :src="conversationAvatar(props.conversation)"
        :seed="conversationSeed(props.conversation)"
        :size="32"
        square
      />
      <div class="min-w-0 flex-1">
        <p class="truncate text-[13.5px] font-medium text-text-strong">{{ title }}</p>
        <p class="text-[11px] text-muted">{{ memberCount ?? 0 }} 位成员</p>
      </div>
      <Icon name="chevronDown" :size="14" class="text-muted" />
    </button>

    <!-- 群公告 -->
    <div v-if="hasAnnouncement" class="border-b border-line px-2 py-2">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded-lg bg-surface px-2 py-1.5 text-left"
        @click="announcementOpen = !announcementOpen"
      >
        <Icon name="megaphone" :size="13" class="text-accent" />
        <span class="flex-1 text-[11.5px] font-medium text-text">群公告</span>
        <Icon :name="announcementOpen ? 'chevronDown' : 'chevronRight'" :size="12" class="text-muted" />
      </button>
      <p
        class="mt-1 px-2 text-[12px] leading-[1.5] whitespace-pre-wrap text-muted"
        :class="announcementOpen ? '' : 'line-clamp-2'"
      >
        {{ props.conversation.announcement }}
      </p>
    </div>

    <!-- 频道列表 -->
    <div class="scroll-area flex-1 px-2 py-2">
      <div v-for="group in groups" :key="group.category || '__root'" class="mb-1">
        <div class="flex items-center gap-1 px-1.5 py-1">
          <button
            type="button"
            class="flex flex-1 items-center gap-1 text-[10.5px] font-medium tracking-wide text-muted uppercase"
            @click="toggle(group.category)"
          >
            <Icon
              :name="collapsed[group.category] ? 'chevronRight' : 'chevronDown'"
              :size="11"
            />
            {{ group.category || '频道' }}
          </button>
          <button
            type="button"
            class="rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
            title="新建频道"
            @click="emit('create-channel')"
          >
            <Icon name="plus" :size="12" />
          </button>
        </div>

        <template v-if="!collapsed[group.category]">
          <button
            v-for="channel in group.channels"
            :key="channel.id"
            type="button"
            class="relative flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors"
            :class="
              channel.id === activeChannelId
                ? 'bg-surface text-text-strong'
                : 'text-muted hover:bg-surface-3 hover:text-text'
            "
            @click="emit('select', channel.id)"
          >
            <span
              v-if="channel.id === activeChannelId"
              class="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
            />
            <Icon
              :name="channel.kind === 'announcement' ? 'megaphone' : 'hash'"
              :size="14"
              :class="channel.id === activeChannelId ? 'text-accent' : ''"
            />
            <span class="truncate text-[13px]">{{ channel.name }}</span>
          </button>
        </template>
      </div>
    </div>
  </aside>
</template>
