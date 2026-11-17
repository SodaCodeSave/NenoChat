<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ConversationItem from './ConversationItem.vue'
import NewChatDialog from './NewChatDialog.vue'
import { useConversationsStore } from '@/stores/conversations'
import { useMessagesStore } from '@/stores/messages'
import { useUiStore } from '@/stores/ui'
import { conversationTitle } from '@/composables/conversation'

const router = useRouter()
const conversations = useConversationsStore()
const messages = useMessagesStore()
const ui = useUiStore()

const props = defineProps<{ mobile?: boolean }>()

const keyword = ref('')
const dialogOpen = ref(false)
const menu = ref<{ id: string; x: number; y: number } | null>(null)
/** 长按弹出面板后，抬手产生的合成 click 不能立刻把面板关掉 */
let menuOpenedAt = 0

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return conversations.ordered
  return conversations.ordered.filter((c) => conversationTitle(c).toLowerCase().includes(q))
})

const pinnedAi = computed(() => filtered.value.filter((c) => c.type === 'ai' && c.pinnedAt))
const aiRest = computed(() => filtered.value.filter((c) => c.type === 'ai' && !c.pinnedAt))
const groups = computed(() => filtered.value.filter((c) => c.type === 'group'))
const directs = computed(() => filtered.value.filter((c) => c.type === 'direct'))

const menuTarget = computed(() => (menu.value ? conversations.byId.get(menu.value.id) : null))

function open(id: string): void {
  void router.push(`/c/${id}`)
  ui.drawerOpen = false
}

function openMenu(payload: { id: string; x: number; y: number }): void {
  menuOpenedAt = Date.now()
  menu.value = payload
}

function closeMenu(): void {
  if (Date.now() - menuOpenedAt < 350) return
  menu.value = null
}

async function handlePin(): Promise<void> {
  const target = menuTarget.value
  if (!target) return
  await conversations.pin(target.id, !target.pinnedAt)
  menu.value = null
}

async function handleMarkRead(): Promise<void> {
  const target = menuTarget.value
  if (!target) return
  const last = messages.lastMessageOf(target.id)
  await conversations.markRead(target.id, last?.seq ?? 0)
  menu.value = null
}

function handleCreated(id: string): void {
  dialogOpen.value = false
  open(id)
}

onMounted(() => {
  const close = (): void => {
    if (menu.value) closeMenu()
  }
  window.addEventListener('click', close)
  window.addEventListener('scroll', close, true)
})
</script>

<template>
  <aside
    class="flex shrink-0 flex-col bg-surface-2"
    :class="
      props.mobile
        ? 'w-full flex-1'
        : ui.isTablet
          ? 'w-[260px] border-r border-line'
          : 'w-[300px] border-r border-line'
    "
  >
    <!-- 手机端：标题 + 全宽搜索，单栏列表铺满屏幕 -->
    <header
      v-if="props.mobile"
      class="shrink-0 px-4 pb-2 pt-[calc(0.75rem+var(--safe-top))]"
    >
      <div class="mb-2 flex items-center justify-between">
        <h1 class="text-[21px] font-semibold text-text-strong">消息</h1>
        <div class="flex items-center gap-1">
          <IconButton icon="search" label="全局搜索" :size="19" @click="ui.commandOpen = true" />
          <IconButton icon="plus" label="发起新会话" :size="20" @click="dialogOpen = true" />
        </div>
      </div>
      <div class="relative">
        <span class="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">
          <Icon name="search" :size="16" />
        </span>
        <input
          v-model="keyword"
          type="search"
          placeholder="搜索会话"
          class="h-10 w-full rounded-xl border border-transparent bg-surface pl-9 pr-2 text-[14px] outline-none transition-colors placeholder:text-muted focus:border-accent"
        />
      </div>
    </header>

    <!-- 桌面端：搜索栏与新建 -->
    <header v-else class="flex items-center gap-1.5 px-3 pt-3 pb-2">
      <div class="relative flex-1">
        <span class="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">
          <Icon name="search" :size="15" />
        </span>
        <input
          v-model="keyword"
          type="search"
          placeholder="搜索会话"
          class="h-8 w-full rounded-lg border border-transparent bg-surface pl-8 pr-2 text-[13px] outline-none transition-colors placeholder:text-muted focus:border-accent"
        />
      </div>
      <IconButton icon="search" label="全局搜索（Ctrl+K）" :size="17" @click="ui.commandOpen = true" />
      <IconButton icon="plus" label="发起新会话" :size="18" @click="dialogOpen = true" />
    </header>

    <div
      class="scroll-area flex-1 px-2 pb-3"
      :class="props.mobile ? 'pb-[calc(var(--mobile-tab-h)+var(--safe-bottom)+0.75rem)]' : ''"
    >
      <section v-if="pinnedAi.length > 0" class="mb-1">
        <p class="px-2 py-1 text-[11px] font-medium tracking-wide text-muted">置顶</p>
        <ConversationItem
          v-for="item in pinnedAi"
          :key="item.id"
          :conversation="item"
          :active="item.id === conversations.activeId"
          @select="open"
          @context="openMenu"
        />
      </section>

      <section v-if="aiRest.length > 0" class="mb-1">
        <p class="px-2 py-1 text-[11px] font-medium tracking-wide text-muted">AI 角色</p>
        <ConversationItem
          v-for="item in aiRest"
          :key="item.id"
          :conversation="item"
          :active="item.id === conversations.activeId"
          @select="open"
          @context="openMenu"
        />
      </section>

      <section v-if="groups.length > 0" class="mb-1">
        <p class="px-2 py-1 text-[11px] font-medium tracking-wide text-muted">群聊</p>
        <ConversationItem
          v-for="item in groups"
          :key="item.id"
          :conversation="item"
          :active="item.id === conversations.activeId"
          @select="open"
          @context="openMenu"
        />
      </section>

      <section v-if="directs.length > 0" class="mb-1">
        <p class="px-2 py-1 text-[11px] font-medium tracking-wide text-muted">私聊</p>
        <ConversationItem
          v-for="item in directs"
          :key="item.id"
          :conversation="item"
          :active="item.id === conversations.activeId"
          @select="open"
          @context="openMenu"
        />
      </section>

      <div
        v-if="filtered.length === 0"
        class="mt-10 flex flex-col items-center gap-2 px-4 text-center text-[12.5px] text-muted"
      >
        <Icon name="message" :size="28" class="opacity-40" />
        <p>{{ keyword ? '没有匹配的会话' : '还没有会话，点右上角 + 开始吧' }}</p>
      </div>
    </div>

    <!-- 右键 / 长按菜单 -->
    <Teleport to="body">
      <template v-if="menu">
        <!-- 手机端：底部操作面板，比坐标浮层更好点 -->
        <div v-if="ui.isMobile" class="fixed inset-0 z-50 bg-black/40" @click="closeMenu">
          <div
            class="absolute inset-x-0 bottom-0 overflow-hidden rounded-t-2xl border-t border-line bg-surface pb-[var(--safe-bottom)]"
            @click.stop
          >
            <p class="truncate border-b border-line px-4 py-3 text-center text-[12px] text-muted">
              {{ menuTarget ? conversationTitle(menuTarget) : '' }}
            </p>
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] text-text active:bg-surface-2"
              @click="handlePin"
            >
              <Icon name="pin" :size="17" />
              {{ menuTarget?.pinnedAt ? '取消置顶' : '置顶会话' }}
            </button>
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] text-text active:bg-surface-2"
              @click="handleMarkRead"
            >
              <Icon name="check" :size="17" />
              标为已读
            </button>
            <button
              type="button"
              class="w-full border-t border-line py-3.5 text-[15px] text-muted active:bg-surface-2"
              @click="menu = null"
            >
              取消
            </button>
          </div>
        </div>

        <div
          v-else
          class="fixed z-50 min-w-[168px] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-soft)]"
          :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
          @click.stop
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2"
            @click="handlePin"
          >
            <Icon name="pin" :size="14" />
            {{ menuTarget?.pinnedAt ? '取消置顶' : '置顶会话' }}
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2"
            @click="handleMarkRead"
          >
            <Icon name="check" :size="14" />
            标为已读
          </button>
        </div>
      </template>
    </Teleport>

    <NewChatDialog v-if="dialogOpen" @close="dialogOpen = false" @created="handleCreated" />
  </aside>
</template>
