<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from '@/components/ui/form/Dialog.vue'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import type { ConversationSummary } from '@/api/endpoints'
import {
  conversationAvatar,
  conversationSeed,
  useConversationTitle,
} from '@/composables/conversation'
import { useConversationsStore } from '@/stores/conversations'

/**
 * 转发目标选择：列出全部会话（可搜索），多选后确认转发。
 * 实际转发由父组件的 perform 回调执行，对话框管理提交态与错误展示。
 */
const props = defineProps<{
  messageCount?: number
  /** 执行转发：目标会话 id 列表；抛错时对话框内提示并保持打开 */
  perform: (targets: string[]) => Promise<void>
}>()

const open = defineModel<boolean>('open', { default: false })

const conversations = useConversationsStore()
const titleOf = useConversationTitle()

const keyword = ref('')
const selected = ref<Set<string>>(new Set())
const submitting = ref(false)
const error = ref<string | null>(null)

/** 打开时重置选择并确保会话列表就绪（通常启动后已预载，这里兜底） */
watch(open, async (next) => {
  if (!next) return
  keyword.value = ''
  selected.value = new Set()
  error.value = null
  if (conversations.items.length === 0) {
    await conversations.refresh().catch(() => undefined)
  }
})

/** 关键词过滤：会话名 / 对方昵称，输入即筛，无需请求 */
const candidates = computed<ConversationSummary[]>(() => {
  const query = keyword.value.trim().toLowerCase()
  const list = conversations.ordered
  if (!query) return list
  return list.filter((c) => titleOf(c).toLowerCase().includes(query))
})

function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

async function submit(): Promise<void> {
  if (selected.value.size === 0 || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await props.perform([...selected.value])
    open.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : '转发失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open" title="转发到" width="sm">
    <p v-if="messageCount" class="mb-2 text-[12px] text-muted">
      已选 {{ messageCount }} 条消息
    </p>

    <div class="relative mb-2">
      <Icon
        name="search"
        :size="14"
        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        v-model="keyword"
        type="text"
        placeholder="搜索会话"
        class="w-full rounded-lg border border-line bg-surface-2 py-1.5 pl-8 pr-3 text-[13px] text-text placeholder:text-muted focus:border-accent focus:outline-none"
      />
    </div>

    <div class="max-h-[300px] space-y-0.5 overflow-y-auto">
      <p v-if="candidates.length === 0" class="py-6 text-center text-[12.5px] text-muted">
        没有匹配的会话
      </p>
      <button
        v-for="conversation in candidates"
        :key="conversation.id"
        type="button"
        class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
        :class="selected.has(conversation.id) ? 'bg-accent-soft/50' : ''"
        @click="toggle(conversation.id)"
      >
        <Avatar
          :name="titleOf(conversation)"
          :src="conversationAvatar(conversation)"
          :seed="conversationSeed(conversation)"
          :size="34"
        />
        <span class="min-w-0 flex-1 truncate text-[13px] text-text-strong">
          {{ titleOf(conversation) }}
        </span>
        <span
          class="flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border transition-colors"
          :class="selected.has(conversation.id) ? 'border-accent bg-accent text-white' : 'border-muted/60 text-transparent'"
          aria-hidden="true"
        >
          <Icon name="check" :size="10" />
        </span>
      </button>
    </div>

    <p v-if="error" class="mt-2 text-[12px] text-danger">{{ error }}</p>

    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-muted hover:text-text"
        @click="open = false"
      >
        取消
      </button>
      <button
        type="button"
        class="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        :disabled="selected.size === 0 || submitting"
        @click="submit"
      >
        {{ submitting ? '发送中…' : `发送${selected.size > 0 ? `（${selected.size}）` : ''}` }}
      </button>
    </template>
  </Dialog>
</template>
