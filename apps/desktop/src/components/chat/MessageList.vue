<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AUTOSCROLL_THRESHOLD_PX, MESSAGE_GROUP_WINDOW_MS, type Message } from '@nenochat/shared'
import MessageItem from './MessageItem.vue'
import { useAiStore } from '@/stores/ai'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useMembersStore } from '@/stores/members'
import { collapseAccidentalDuplicates } from '@/composables/message-merge'

const props = defineProps<{
  messages: Message[]
  conversationId: string
  loading?: boolean
  hasMoreOlder?: boolean
  /** 正在流式生成的 generationId，用于显示光标 */
  streamingId?: string | null
  /** 未读分隔线插入位置（该 seq 之后） */
  unreadAfterSeq?: number
  /** 从搜索结果跳转过来时要定位的消息 id */
  highlightId?: string | null
}>()

const emit = defineEmits<{
  (e: 'load-older'): void
  (e: 'reply', id: string): void
  (e: 'recall', id: string): void
  (e: 'edit', id: string): void
  (e: 'pin', id: string): void
  (e: 'context', payload: { id: string; x: number; y: number }): void
  (e: 'preview', url: string): void
  (e: 'visible-last', seq: number): void
  /** 引用块指向的消息不在已加载范围时，请求补拉上下文 */
  (e: 'load-around', id: string): void
}>()

const scroller = ref<HTMLElement | null>(null)
const auth = useAuthStore()
const members = useMembersStore()
const ai = useAiStore()
const conversations = useConversationsStore()

type Row =
  | { kind: 'day'; key: string; ts: number }
  | {
      kind: 'message'
      key: string
      message: Message
      showHeader: boolean
      aiGroupSize?: number
      mentionMe: boolean
    }

function dayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabel(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return '今天'
  const yesterday = new Date(now.getTime() - 86400000)
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return '昨天'
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/** 连续同人、间隔小于 5 分钟、非引用消息 → 合并为一组，只显示一次头像 */
const rows = computed<Row[]>(() => {
  const output: Row[] = []
  /** 渲染层最后一道兜底：同一个 id 只画一次（上游合并逻辑出错也不该出现双份气泡） */
  let lastDay = ''
  let prev: Message | null = null

  for (const message of collapseAccidentalDuplicates(props.messages)) {

    const key = dayKey(message.createdAt)
    if (key !== lastDay) {
      output.push({ kind: 'day', key: `day-${key}`, ts: message.createdAt })
      lastDay = key
      prev = null
    }

    const sameSender = prev !== null && prev.senderId === message.senderId
    const withinWindow = prev !== null && message.createdAt - prev.createdAt < MESSAGE_GROUP_WINDOW_MS
    const grouped = sameSender && withinWindow && !message.replyToId && message.type !== 'system'

    const mentionMe = Boolean(
      message.meta?.mentions?.includes(auth.user?.id ?? '') || message.meta?.mentionAll,
    )

    output.push({
      kind: 'message',
      key: message.id,
      message,
      showHeader: !grouped,
      mentionMe,
    })
    prev = message
  }

  // 回填 AI 分条总数，供最后一条显示「共 N 条」
  const generationCount = new Map<string, number>()
  for (const row of output) {
    if (row.kind !== 'message') continue
    const gid = row.message.aiGenerationId
    if (!gid) continue
    generationCount.set(gid, (generationCount.get(gid) ?? 0) + 1)
  }
  for (const row of output) {
    if (row.kind !== 'message') continue
    const gid = row.message.aiGenerationId
    if (gid) row.aiGroupSize = generationCount.get(gid)
  }

  return output
})

/**
 * 消息对应的 AI 角色。
 * 优先看消息自带的 personaId（历史消息可能没有），再退回会话绑定的角色，
 * 这样一个会话里就算换过角色也能显示对的人。
 */
function personaOfMessage(message: Message): { name: string; avatarUrl: string | null } | null {
  const byMessage = message.meta?.ai?.personaId
  if (byMessage) {
    const found = ai.personas.find((p) => p.id === byMessage)
    if (found) return { name: found.name, avatarUrl: found.avatarUrl ?? null }
  }
  const byConversation = ai.personaOf(message.conversationId)
  if (byConversation) return { name: byConversation.name, avatarUrl: byConversation.avatarUrl ?? null }
  return null
}

function senderName(message: Message): string {
  if (message.senderType === 'ai') {
    return (
      personaOfMessage(message)?.name ??
      conversations.byId.get(message.conversationId)?.name ??
      'AI'
    )
  }
  if (message.senderId === auth.user?.id) return auth.user?.displayName ?? '我'
  const member = members.of(message.conversationId).find((m) => m.userId === message.senderId)
  if (member) return members.displayName(member)
  return members.profiles[message.senderId ?? '']?.displayName ?? '未知用户'
}

function senderAvatar(message: Message): string | null {
  if (message.senderType === 'ai') {
    return (
      personaOfMessage(message)?.avatarUrl ??
      conversations.byId.get(message.conversationId)?.avatarUrl ??
      null
    )
  }
  if (message.senderId === auth.user?.id) return auth.user?.avatarUrl ?? null
  const member = members.of(message.conversationId).find((m) => m.userId === message.senderId)
  return member?.user?.avatarUrl ?? null
}

/** 没有头像时用 seed 派生稳定的底色，同一角色/用户永远同一个颜色 */
function senderSeed(message: Message): string {
  if (message.senderType === 'ai') {
    return (
      message.meta?.ai?.personaId ??
      conversations.byId.get(message.conversationId)?.aiPersonaId ??
      message.conversationId
    )
  }
  return message.senderId ?? message.id
}

/* ------------------------- 引用块内容解析 ------------------------- */

const messageById = computed(() => new Map(props.messages.map((message) => [message.id, message])))

function previewOf(message: Message): string {
  if (message.deletedAt) return '消息已撤回'
  if (message.type === 'image') return '[图片]'
  if (message.type === 'file') return '[文件]'
  if (message.type === 'sticker') return '[表情]'
  return message.content.trim().slice(0, 80) || '（空消息）'
}

/** 优先用已加载到的原消息（能看到编辑后的内容），否则退回发送时定格的快照 */
function replyViewOf(message: Message): { id: string; senderName: string; preview: string } | null {
  if (!message.replyToId) return null
  const target = messageById.value.get(message.replyToId)
  if (target) {
    return { id: target.id, senderName: senderName(target), preview: previewOf(target) }
  }
  const snapshot = message.meta?.replyTo
  if (snapshot) {
    return { id: snapshot.id, senderName: snapshot.senderName, preview: snapshot.preview }
  }
  return { id: message.replyToId, senderName: '某条消息', preview: '原消息不在当前记录里' }
}

/* --------------------------- 虚拟滚动 --------------------------- */

/**
 * 可变高度窗口化：只渲染视口 ± OVERSCAN 内的行。
 * 高度靠 ResizeObserver 实测缓存，未测量的行用估值，
 * 因此滚动条总量会随滚动逐步收敛到真实值。
 */
const ESTIMATE = { message: 56, day: 34 }
const OVERSCAN_PX = 600

const heights = ref<Record<string, number>>({})
const scrollTop = ref(0)
const viewportHeight = ref(0)
const highlighted = ref<string | null>(null)

function heightOf(row: Row): number {
  return heights.value[row.key] ?? (row.kind === 'day' ? ESTIMATE.day : ESTIMATE.message)
}

const layout = computed(() => {
  const offsets: number[] = []
  let total = 0
  for (const row of rows.value) {
    offsets.push(total)
    total += heightOf(row)
  }
  return { offsets, total }
})

function lowerBound(values: number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

const window_ = computed(() => {
  const list = rows.value
  if (list.length === 0) return { start: 0, end: 0 }

  const top = scrollTop.value
  const bottom = top + Math.max(viewportHeight.value, 400)
  const offsets = layout.value.offsets

  const start = Math.max(0, lowerBound(offsets, top - OVERSCAN_PX))
  const end = Math.min(list.length, lowerBound(offsets, bottom + OVERSCAN_PX) + 1)
  return { start, end: Math.max(end, start + 1) }
})

const renderedRows = computed(() => rows.value.slice(window_.value.start, window_.value.end))
const topSpacer = computed(() => layout.value.offsets[window_.value.start] ?? 0)
const bottomSpacer = computed(() => {
  const list = rows.value
  const { start, end } = window_.value
  if (list.length === 0) return 0
  const last = list[end - 1]
  if (!last) return 0
  return Math.max(0, layout.value.total - (layout.value.offsets[end - 1]! + heightOf(last)))
})

let measureRaf = 0
function scheduleMeasure(): void {
  cancelAnimationFrame(measureRaf)
  measureRaf = requestAnimationFrame(() => {
    const el = scroller.value
    if (!el) return
    const next = { ...heights.value }
    let changed = false
    el.querySelectorAll<HTMLElement>('[data-row-key]').forEach((node) => {
      const key = node.dataset.rowKey
      if (!key) return
      const height = node.getBoundingClientRect().height
      if (height > 0 && Math.abs((next[key] ?? 0) - height) > 0.5) {
        next[key] = height
        changed = true
      }
    })
    if (!changed) return
    heights.value = next
    // 高度收敛后重新贴底，否则「贴底」状态会被测量误差顶开
    if (stickBottom) {
      requestAnimationFrame(() => {
        const el = scroller.value
        if (el) el.scrollTop = el.scrollHeight
      })
    }
  })
}

function isNearBottom(): boolean {
  const el = scroller.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < AUTOSCROLL_THRESHOLD_PX
}

let scrollRaf = 0
function scrollToBottom(smooth = false): void {
  const el = scroller.value
  if (!el) return
  cancelAnimationFrame(scrollRaf)
  scrollRaf = requestAnimationFrame(() => {
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    scrollTop.value = el.scrollTop
  })
}

/** 总高度变化（窗口化行数增加）后仍然贴底 */
function pinToBottom(): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  scrollTop.value = el.scrollTop
}

watch(
  () => layout.value.total,
  () => {
    if (stickBottom) requestAnimationFrame(pinToBottom)
  },
)

let stickBottom = true

/** 跳到某条消息并短暂高亮；目标不在已加载范围时返回 false */
function focusMessage(id: string): boolean {
  const el = scroller.value
  const index = rows.value.findIndex((row) => row.kind === 'message' && row.message.id === id)
  if (!el || index === -1) return false

  stickBottom = false
  el.scrollTop = Math.max(0, layout.value.offsets[index]! - 80)
  scrollTop.value = el.scrollTop
  highlighted.value = id

  window.setTimeout(() => {
    if (highlighted.value === id) highlighted.value = null
  }, 2400)
  return true
}

const pendingJump = ref<string | null>(null)

/** 引用块点击：已在列表里直接跳，否则请求补拉上下文再跳 */
function jumpTo(id: string): void {
  if (focusMessage(id)) return
  pendingJump.value = id
  emit('load-around', id)
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return

  scrollTop.value = el.scrollTop
  viewportHeight.value = el.clientHeight
  stickBottom = isNearBottom()

  if (el.scrollTop < 80 && props.hasMoreOlder && !props.loading) {
    emit('load-older')
  }

  if (stickBottom) {
    const last = props.messages[props.messages.length - 1]
    if (last) emit('visible-last', last.seq)
  }

  scheduleMeasure()
}

/** 更早的历史插入后，把滚动位置补偿回去，避免视野被顶走 */
let pendingAnchor: number | null = null

watch(
  () => props.messages.length,
  async (next, prev) => {
    const el = scroller.value
    const added = next - (prev ?? 0)
    // 不在底部时新增消息只可能是向上翻历史，需要补偿滚动位置
    if (el && added > 0 && !stickBottom) pendingAnchor = el.scrollHeight

    const wasStick = stickBottom
    await nextTick()
    scheduleMeasure()

    // 引用补拉回来后优先完成跳转，别被「保持位置」的补偿逻辑抢走滚动
    if (pendingJump.value) {
      const id = pendingJump.value
      pendingJump.value = null
      pendingAnchor = null
      focusMessage(id)
      return
    }

    if (el && pendingAnchor !== null) {
      el.scrollTop = el.scrollTop + (el.scrollHeight - pendingAnchor)
      pendingAnchor = null
      return
    }

    if (wasStick || (prev ?? 0) === 0) scrollToBottom(false)
  },
)

watch(
  () => props.messages[props.messages.length - 1]?.content,
  async () => {
    await nextTick()
    scheduleMeasure()
    if (stickBottom) scrollToBottom()
  },
)

/** 从搜索结果跳进来：滚到目标消息并短暂高亮 */
watch(
  () => [props.highlightId, rows.value.length] as const,
  async ([id]) => {
    if (!id) return
    await nextTick()
    focusMessage(id)
  },
  { immediate: true },
)

/** 切换会话/频道时重置滚动与高度缓存，避免沿用上一个会话的位置 */
watch(
  () => props.conversationId,
  async () => {
    heights.value = {}
    stickBottom = true
    await nextTick()
    scrollToBottom(false)
    scheduleMeasure()
  },
)

onMounted(() => {
  const el = scroller.value
  if (el) viewportHeight.value = el.clientHeight
  void nextTick(() => {
    scrollToBottom()
    scheduleMeasure()
  })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(measureRaf)
  cancelAnimationFrame(scrollRaf)
})

defineExpose({ scrollToBottom })
</script>

<template>
  <div ref="scroller" class="scroll-area relative flex-1 px-0 py-2" @scroll.passive="onScroll">
    <div
      v-if="hasMoreOlder"
      class="mx-auto mb-2 w-fit rounded-full bg-surface-2 px-3 py-1 text-[11px] text-muted"
    >
      {{ loading ? '加载中…' : '上滑加载更多历史消息' }}
    </div>

    <!-- 上方留白：代表被窗口化裁掉的行 -->
    <div v-if="topSpacer > 0" :style="{ height: `${topSpacer}px` }" aria-hidden="true" />

    <div
      v-for="row in renderedRows"
      :key="row.key"
      :data-row-key="row.key"
      class="flow-root"
      :class="
        row.kind === 'message' && highlighted === row.message.id
          ? 'animate-pulse bg-accent-soft/60'
          : ''
      "
    >
      <div v-if="row.kind === 'day'" class="my-3 flex items-center gap-3 px-4">
        <span class="h-px flex-1 bg-line" />
        <span class="text-[11px] text-muted">{{ dayLabel(row.ts) }}</span>
        <span class="h-px flex-1 bg-line" />
      </div>

      <MessageItem
        v-else
        :message="row.message"
        :sender-name="senderName(row.message)"
        :sender-avatar="senderAvatar(row.message)"
        :sender-seed="senderSeed(row.message)"
        :is-own="row.message.senderId === auth.user?.id"
        :show-header="row.showHeader"
        :mention-me="row.mentionMe"
        :pending="row.message.localStatus === 'pending'"
        :failed="row.message.localStatus === 'failed'"
        :streaming="Boolean(streamingId && row.message.aiGenerationId === streamingId)"
        :ai-group-size="row.aiGroupSize"
        :reply="replyViewOf(row.message)"
        @reply="(id) => emit('reply', id)"
        @recall="(id) => emit('recall', id)"
        @edit="(id) => emit('edit', id)"
        @pin="(id) => emit('pin', id)"
        @jump="jumpTo"
        @context="(payload) => emit('context', payload)"
        @preview="(url) => emit('preview', url)"
      />
    </div>

    <!-- 下方留白 -->
    <div v-if="bottomSpacer > 0" :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />

    <div v-if="messages.length === 0 && !loading" class="grid place-items-center py-16">
      <p class="text-[13px] text-muted">还没有消息，说点什么吧</p>
    </div>
  </div>
</template>
