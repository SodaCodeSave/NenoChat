<script setup lang="ts">
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import type { MemberWithUser } from '@/stores/members'
import { useMembersStore } from '@/stores/members'

const props = defineProps<{
  groups: Array<{ key: string; label: string; members: MemberWithUser[] }>
  /** 手机端以抽屉形式出现，占满容器宽度 */
  mobile?: boolean
}>()

const emit = defineEmits<{
  (e: 'mention', userId: string, displayName: string): void
  (e: 'open-profile', userId: string): void
  (e: 'close'): void
}>()

const members = useMembersStore()
</script>

<template>
  <aside
    class="flex flex-col bg-surface-2"
    :class="props.mobile ? 'w-full' : 'w-[232px] shrink-0 border-l border-line'"
  >
    <header
      class="flex items-center gap-1.5 border-b border-line px-3 py-3"
      :class="props.mobile ? 'pt-[calc(0.75rem+var(--safe-top))]' : ''"
    >
      <Icon name="users" :size="15" class="text-muted" />
      <h2 class="text-[12.5px] font-medium text-text">成员</h2>
      <span class="ml-auto text-[11px] text-muted">
        {{ groups.reduce((sum, g) => sum + g.members.length, 0) }}
      </span>
      <IconButton v-if="props.mobile" icon="close" label="关闭" :size="16" @click="emit('close')" />
    </header>

    <div class="scroll-area flex-1 px-2 py-2 pb-[var(--safe-bottom)]">
      <div v-for="group in groups" :key="group.key" class="mb-2">
        <p class="px-1.5 py-1 text-[10.5px] font-medium tracking-wide text-muted">
          {{ group.label }} — {{ group.members.length }}
        </p>
        <button
          v-for="member in group.members"
          :key="member.userId"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-surface-3 active:bg-surface-3"
          @click="emit('open-profile', member.userId)"
        >
          <Avatar
            :name="members.displayName(member)"
            :src="member.user?.avatarUrl ?? null"
            :seed="member.userId"
            :size="26"
            :online="Boolean(members.online[member.userId])"
          />
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">
            {{ members.displayName(member) }}
          </span>
          <span
            v-if="member.role !== 'member'"
            class="rounded bg-accent-soft px-1 text-[10px] text-accent"
          >
            {{ member.role === 'owner' ? '群主' : '管理' }}
          </span>
          <span
            v-if="member.muteUntil && member.muteUntil > Date.now()"
            class="text-[10px] text-danger"
          >
            禁言
          </span>
        </button>
      </div>
    </div>
  </aside>
</template>
