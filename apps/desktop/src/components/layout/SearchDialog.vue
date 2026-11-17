<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { SearchMessageHit, SearchResponse } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import { searchApi } from '@/api/search'
import { conversationApi } from '@/api/endpoints'
import { conversationTitle } from '@/composables/conversation'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const router = useRouter()
const conversations = useConversationsStore()

const keyword = ref('')
const result = ref<SearchResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const activeIndex = ref(0)
const input = ref<HTMLInputElement | null>(null)

type Item =
  | { kind: 'message'; hit: SearchMessageHit }
  | { kind: 'user'; id: string; name: string; username: string; avatarUrl?: string | null }
  | { kind: 'conversation'; id: string; name: string }

const items = computed<Item[]>(() => {
  if (!result.value) return []
  const list: Item[] = []
  for (const hit of result.value.messages) list.push({ kind: 'message', hit })
  for (const user of result.value.users) {
    list.push({
      kind: 'user',
      id: user.id,
      name: user.displayName,
      username: user.username,
      avatarUrl: user.avatarUrl,
    })
  }
  for (const conversation of result.value.conversations) {
    list.push({ kind: 'conversation', id: conversation.id, name: conversation.name ?? '私聊会话' })
  }
  return list
})

const hasResult = computed(
  () => Boolean(result.value) && items.value.length > 0,
)

let debounceTimer = 0
watch(keyword, () => {
  activeIndex.value = 0
  window.clearTimeout(debounceTimer)
  const q = keyword.value.trim()
  if (q.length === 0) {
    result.value = null
    return
  }
  debounceTimer = window.setTimeout(() => {
    void run(q)
  }, 220)
})

async function run(q: string): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const response = await searchApi.query(q)
    // 输入已经变了就丢弃这次结果，避免旧结果盖掉新结果
    if (keyword.value.trim() !== q) return
    result.value = response
  } catch (e) {
    error.value = e instanceof Error ? e.message : '搜索失败'
  } finally {
    loading.value = false
  }
}

async function openItem(item: Item): Promise<void> {
  if (item.kind === 'message') {
    const { message, conversationId } = item.hit
    await router.push({ path: `/c/${conversationId}`, query: { m: message.id } })
    close()
    return
  }

  if (item.kind === 'conversation') {
    await router.push(`/c/${item.id}`)
    close()
    return
  }

  try {
    const created = await conversationApi.create({ type: 'direct', targetUserId: item.id })
    await conversations.refresh()
    await router.push(`/c/${created.conversation.id}`)
    close()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法打开私聊'
  }
}

function move(delta: number): void {
  if (items.value.length === 0) return
  activeIndex.value = (activeIndex.value + delta + items.value.length) % items.value.length
}

function onKeydown(event: KeyboardEvent): void {
  if (!ui.commandOpen) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter') {
    const target = items.value[activeIndex.value]
    if (target) {
      event.preventDefault()
      void openItem(target)
    }
  }
}

function close(): void {
  ui.commandOpen = false
  keyword.value = ''
  result.value = null
  error.value = null
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat
}

/** 条目在扁平结果里的稳定键：消息按消息 id，其余按分区 + id */
function itemKeyOf(item: Item): string {
  if (item.kind === 'message') return `message:${item.hit.message.id}`
  return `${item.kind}:${item.id}`
}

/** items 已按 分区铺平，行高亮与悬停直接查表，避免每行 findIndex */
const indexByKey = computed(() => {
  const map = new Map<string, number>()
  items.value.forEach((item, index) => {
    map.set(itemKeyOf(item), index)
  })
  return map
})

function indexOf(item: Item): number {
  return indexByKey.value.get(itemKeyOf(item)) ?? -1
}

watch(
  () => ui.commandOpen,
  async (open) => {
    if (!open) return
    await nextTick()
    input.value?.focus()
  },
)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearTimeout(debounceTimer)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.commandOpen"
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-0 pt-[var(--safe-top)] md:px-4 md:pt-[10vh]"
      @click.self="close"
    >
      <div
        class="w-full max-w-xl overflow-hidden rounded-none border-0 bg-surface shadow-2xl md:rounded-2xl md:border md:border-line"
      >
        <div class="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" :size="16" class="text-muted" />
          <input
            ref="input"
            v-model="keyword"
            type="text"
            placeholder="搜索消息、联系人或会话…"
            class="h-11 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted"
          />
          <span v-if="loading" class="text-[11px] text-muted">搜索中…</span>
          <kbd class="hidden rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted md:inline-block">Esc</kbd>
          <button
            type="button"
            class="rounded-lg p-2 text-muted active:bg-surface-2 md:hidden"
            aria-label="关闭搜索"
            @click="close"
          >
            <Icon name="close" :size="17" />
          </button>
        </div>

        <div class="max-h-[calc(100dvh-var(--safe-top)-3rem)] overflow-y-auto pb-[var(--safe-bottom)] md:max-h-[60vh] md:pb-0">
          <p v-if="error" class="px-4 py-3 text-[12px] text-danger">{{ error }}</p>

          <div v-else-if="keyword.trim().length === 0" class="px-4 py-8 text-center">
            <Icon name="search" :size="24" class="mx-auto mb-2 text-muted opacity-40" />
            <p class="text-[12.5px] text-muted">输入关键词开始搜索，↑↓ 选择，Enter 打开</p>
          </div>

          <p v-else-if="!loading && result && !hasResult" class="px-4 py-8 text-center text-[12.5px] text-muted">
            没有找到「{{ keyword }}」相关的内容
          </p>

          <template v-else-if="result">
            <section v-if="result.messages.length > 0">
              <p class="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted">消息</p>
              <button
                v-for="hit in result.messages"
                :key="hit.message.id"
                type="button"
                class="flex w-full items-start gap-2.5 px-4 py-2 text-left hover:bg-surface-2"
                :class="indexOf({ kind: 'message', hit }) === activeIndex ? 'bg-surface-2' : ''"
                @mouseenter="activeIndex = indexOf({ kind: 'message', hit })"
                @click="openItem({ kind: 'message', hit })"
              >
                <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                  <Icon name="message" :size="14" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[12.5px] font-medium text-text-strong">
                      {{ hit.conversationName || '会话' }}
                    </span>
                    <span class="truncate text-[11px] text-muted">{{ hit.senderName || '未知' }}</span>
                  </span>
                  <span class="mt-0.5 block truncate text-[12px] text-muted">
                    {{ snippet(hit.message.content) }}
                  </span>
                </span>
              </button>
            </section>

            <section v-if="result.users.length > 0">
              <p class="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted">联系人</p>
              <button
                v-for="user in result.users"
                :key="user.id"
                type="button"
                class="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2"
                :class="
                  indexOf({ kind: 'user', id: user.id, name: user.displayName, username: user.username }) ===
                  activeIndex
                    ? 'bg-surface-2'
                    : ''
                "
                @mouseenter="
                  activeIndex =
                    indexOf({ kind: 'user', id: user.id, name: user.displayName, username: user.username })
                "
                @click="
                  openItem({ kind: 'user', id: user.id, name: user.displayName, username: user.username })
                "
              >
                <Avatar :name="user.displayName" :src="user.avatarUrl" :seed="user.id" :size="28" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] font-medium text-text-strong">
                    {{ user.displayName }}
                  </span>
                  <span class="block truncate text-[11px] text-muted">@{{ user.username }}</span>
                </span>
                <span class="text-[11px] text-muted">发消息</span>
              </button>
            </section>

            <section v-if="result.conversations.length > 0">
              <p class="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted">会话</p>
              <button
                v-for="conversation in result.conversations"
                :key="conversation.id"
                type="button"
                class="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2"
                :class="
                  indexOf({ kind: 'conversation', id: conversation.id, name: conversation.name ?? '' }) ===
                  activeIndex
                    ? 'bg-surface-2'
                    : ''
                "
                @mouseenter="
                  activeIndex = indexOf({
                    kind: 'conversation',
                    id: conversation.id,
                    name: conversation.name ?? '',
                  })
                "
                @click="
                  openItem({ kind: 'conversation', id: conversation.id, name: conversation.name ?? '' })
                "
              >
                <Avatar
                  :name="conversationTitle(conversation)"
                  :src="conversation.avatarUrl"
                  :seed="conversation.id"
                  :size="28"
                />
                <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-strong">
                  {{ conversationTitle(conversation) }}
                </span>
                <span class="text-[11px] text-muted">
                  {{ conversation.type === 'group' ? '群聊' : conversation.type === 'ai' ? 'AI' : '私聊' }}
                </span>
              </button>
            </section>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
