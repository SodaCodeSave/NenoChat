<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AUTOSCROLL_THRESHOLD_PX, MESSAGE_GROUP_WINDOW_MS, type Message } from '@nenochat/shared'
import MessageItem from './MessageItem.vue'
import DecisionStrip from './DecisionStrip.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { smoothScrollBehavior } from '@/composables/motion'
import { dayKey, dayLabel, useMessageDisplay } from '@/composables/message-display'
import { describeUsage } from './debug-labels'
import { useAiStore } from '@/stores/ai'
import { useAuthStore } from '@/stores/auth'
import { useDebugStore } from '@/stores/debug'
import { useUiStore } from '@/stores/ui'
import { resolveFileUrl } from '@/api/http'
import { collapseAccidentalDuplicates } from '@/composables/message-merge'

const props = defineProps<{
  messages: Message[]
  conversationId: string
  loading?: boolean
  hasMoreOlder?: boolean
  /** 正在流式生成的 generationId，用于显示光标 */
  streamingId?: string | null
  /** AI 生成中的占位行状态：pending 表示还没出字（显示灰字思考中） */
  streaming?: { generationId: string; text: string; pending: boolean } | null
  /** 未读分隔线插入位置（该 seq 之后） */
  unreadAfterSeq?: number
  /** 从搜索结果跳转过来时要定位的消息 id */
  highlightId?: string | null
  /** 多选模式：行内显示勾选框，点击切换选中 */
  selectMode?: boolean
  /** 已选中的消息 id 集合 */
  selectedIds?: Set<string>
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
  (e: 'toggle-select', id: string): void
  /** 引用块指向的消息不在已加载范围时，请求补拉上下文 */
  (e: 'load-around', id: string): void
}>()

const scroller = ref<HTMLElement | null>(null)
const auth = useAuthStore()
const ai = useAiStore()
const debug = useDebugStore()
const ui = useUiStore()

/**
 * 聊天背景：不动 DOM，直接在滚动容器上写双层背景——上层薄纱压住花图保证气泡外可读，
 * 下层背景图铺满。默认 attachment=scroll 让壁纸钉在可视区（微信式），不随消息滚动拉伸。
 */
const chatBgStyle = computed(() => {
  const absolute = resolveFileUrl(ui.chatBgUrl)
  if (!absolute) return undefined
  const scrim = 'color-mix(in srgb, var(--surface) 45%, transparent)'
  return {
    backgroundImage: `linear-gradient(${scrim}, ${scrim}), url("${absolute}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  }
})

/** 发送者名称/头像/seed 与引用摘要：与聊天截图共用同一套解析 */
const { senderName, senderAvatar, senderSeed, replyViewOf } = useMessageDisplay(
  () => props.messages,
)

/** 调试模式开着才拉取/渲染决策与用量 */
const debugOn = computed(() => ai.globalSettings?.debugMode ?? false)

type Row =
  | { kind: 'day'; key: string; ts: number }
  | {
      kind: 'message'
      key: string
      message: Message
      showHeader: boolean
      aiGroupSize?: number
      aiGroupStart?: boolean
      mentionMe: boolean
      debugLine?: string | null
    }
  | { kind: 'decision'; key: string; decision: import('@nenochat/shared').AiGroupDecision }

/** 生成中占位行的固定 id，模板里用它区分临时行与真实消息 */
const STREAMING_MESSAGE_ID = '__ai_streaming__'

/** 生成中的占位消息：思考阶段灰字，出字后跟着流式文本长 */
const streamingMessage = computed<Message | null>(() => {
  const stream = props.streaming
  if (!stream) return null
  return {
    id: STREAMING_MESSAGE_ID,
    conversationId: props.conversationId,
    senderType: 'ai',
    type: 'text',
    content: stream.pending ? '正在思考中…' : stream.text,
    meta: { ai: { generationId: stream.generationId, index: Number.MAX_SAFE_INTEGER } },
    seq: (props.messages[props.messages.length - 1]?.seq ?? 0) + 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
})

/** 触发消息 id → 该消息后要插入的决策行 */
const decisionsByTrigger = computed(() => {
  const map = new Map<string, import('@nenochat/shared').AiGroupDecision[]>()
  if (!debugOn.value) return map
  for (const decision of debug.decisions[props.conversationId] ?? []) {
    if (decision.kind !== 'reply' || !decision.triggerMessageId) continue
    const list = map.get(decision.triggerMessageId) ?? []
    list.push(decision)
    map.set(decision.triggerMessageId, list)
  }
  // 决策按时间正序插在触发消息后面
  for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt)
  return map
})

/** AI 消息内联调试行：该次调用的真实用量 */
function debugLineOf(message: Message): string | null {
  if (!debugOn.value) return null
  const refId = message.meta?.ai?.generationId ?? message.aiGenerationId
  if (!refId) return null
  return describeUsage(debug.usageByRef[refId])
}

/** 连续同人、间隔小于 5 分钟、非引用消息 → 合并为一组，只显示一次头像 */
const rows = computed<Row[]>(() => {
  const output: Row[] = []
  /** 渲染层最后一道兜底：同一个 id 只画一次（上游合并逻辑出错也不该出现双份气泡） */
  let lastDay = ''
  let prev: Message | null = null
  /** 已出现过的 AI 生成 id：组首行显示连接器提示 */
  const seenGenerations = new Set<string>()

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

    const gid = message.aiGenerationId
    const aiGroupStart = Boolean(gid && !seenGenerations.has(gid))
    if (gid && aiGroupStart) seenGenerations.add(gid)

    output.push({
      kind: 'message',
      key: message.id,
      message,
      showHeader: !grouped,
      aiGroupStart,
      mentionMe,
      debugLine: debugLineOf(message),
    })
    prev = message

    // 调试行紧跟触发消息：谁考虑过接话、谁为什么沉默
    for (const decision of decisionsByTrigger.value.get(message.id) ?? []) {
      output.push({ kind: 'decision', key: `dec-${decision.id}`, decision })
    }
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

  // 生成中的占位行挂在列表末尾：思考阶段灰字，流式出字后跟着长，结束自动消失
  const streamingRow = streamingMessage.value
  if (streamingRow) {
    output.push({
      kind: 'message',
      key: STREAMING_MESSAGE_ID,
      message: streamingRow,
      showHeader: true,
      mentionMe: false,
      debugLine: null,
    })
  }

  return output
})

/* --------------------------- 虚拟滚动 --------------------------- */

/**
 * 可变高度窗口化：只渲染视口 ± OVERSCAN 内的行。
 * 高度靠 ResizeObserver 实测缓存，未测量的行用估值，
 * 因此滚动条总量会随滚动逐步收敛到真实值。
 */
const ESTIMATE = { message: 56, day: 34, decision: 22 }
const OVERSCAN_PX = 600

const heights = ref<Record<string, number>>({})
const scrollTop = ref(0)
const viewportHeight = ref(0)
const highlighted = ref<string | null>(null)
let highlightTimer = 0

/** 刚追加的消息 id：只给它们放入场动画，滚动回来重新挂载时不重播 */
const freshIds = ref<Set<string>>(new Set())
let freshTimer = 0

function markFresh(ids: string[]): void {
  if (ids.length === 0) return
  freshIds.value = new Set([...freshIds.value, ...ids])
  window.clearTimeout(freshTimer)
  freshTimer = window.setTimeout(() => {
    freshIds.value = new Set()
  }, 240)
}

function heightOf(row: Row): number {
  return heights.value[row.key] ?? ESTIMATE[row.kind]
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
    el.scrollTo({
      top: el.scrollHeight,
      // 平滑滚动由 JS 发起，CSS 的减少动效拦不住，这里自己判断
      behavior: smooth ? smoothScrollBehavior() : 'auto',
    })
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
  window.clearTimeout(highlightTimer)
  highlighted.value = id
  highlightTimer = window.setTimeout(() => {
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

    // 贴底时新到的消息是能感知到的「到达」，给一段入场；翻历史补进来的不播
    if (added > 0 && (prev ?? 0) > 0 && wasStick && !pendingJump.value) {
      markFresh(props.messages.slice(prev ?? 0).map((message) => message.id))
    }

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

/** 流式文本增长时跟随贴底，占位行高度随内容变化需要重新测量 */
watch(
  () => props.streaming?.text,
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

/** 调试模式：为已加载的 AI 消息批量拉一次真实用量 */
watch(
  () => [debugOn.value, props.messages] as const,
  () => {
    if (!debugOn.value) return
    const refIds = new Set<string>()
    for (const message of props.messages) {
      const refId = message.meta?.ai?.generationId ?? message.aiGenerationId
      if (refId) refIds.add(refId)
    }
    if (refIds.size > 0) void debug.loadUsageByRefs([...refIds])
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
  window.clearTimeout(highlightTimer)
  window.clearTimeout(freshTimer)
})

defineExpose({ scrollToBottom })
</script>

<template>
  <div
    ref="scroller"
    class="scroll-area relative flex-1 touch-pan-y px-0 py-2"
    :style="chatBgStyle"
    @scroll.passive="onScroll"
  >
    <div
      v-if="hasMoreOlder"
      class="mx-auto mb-2 w-fit rounded-full bg-surface-2 px-3 py-1 text-[11px] text-muted"
    >
      {{ loading ? '加载中…' : '上滑加载更多历史消息' }}
    </div>

    <!-- 首次加载：骨架屏占位，数据到了直接替换 -->
    <div v-if="loading && messages.length === 0" class="space-y-4 px-4 py-3" aria-hidden="true">
      <div v-for="index in 5" :key="index" class="flex gap-2.5">
        <Skeleton circle width="36px" height="36px" />
        <div class="min-w-0 flex-1 space-y-2 pt-0.5">
          <Skeleton :width="`${28 + (index % 3) * 10}%`" height="11px" />
          <Skeleton :width="`${52 + (index % 4) * 11}%`" height="12px" />
          <Skeleton v-if="index % 2 === 0" :width="`${26 + (index % 5) * 9}%`" height="12px" />
        </div>
      </div>
    </div>

    <!-- 上方留白：代表被窗口化裁掉的行 -->
    <div v-if="topSpacer > 0" :style="{ height: `${topSpacer}px` }" aria-hidden="true" />

    <div
      v-for="row in renderedRows"
      :key="row.key"
      :data-row-key="row.key"
      class="flow-root"
      :class="[
        row.kind === 'message' && highlighted === row.message.id
          ? 'animate-pulse bg-accent-soft/60'
          : '',
        row.kind === 'message' && freshIds.has(row.message.id) ? 'animate-fade-up' : '',
      ]"
    >
      <div v-if="row.kind === 'day'" class="my-3 flex items-center gap-3 px-4">
        <span class="h-px flex-1 bg-line" />
        <span class="text-[11px] text-muted">{{ dayLabel(row.ts) }}</span>
        <span class="h-px flex-1 bg-line" />
      </div>

      <DecisionStrip v-else-if="row.kind === 'decision'" :decision="row.decision" />

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
        :streaming="
          row.message.id === STREAMING_MESSAGE_ID ||
          Boolean(streamingId && row.message.aiGenerationId === streamingId)
        "
        :thinking="row.message.id === STREAMING_MESSAGE_ID && Boolean(streaming?.pending)"
        :ephemeral="row.message.id === STREAMING_MESSAGE_ID"
        :ai-group-size="row.aiGroupSize"
        :ai-group-start="row.aiGroupStart"
        :live-connector="
          row.message.id === STREAMING_MESSAGE_ID
            ? (ai.connectorLive[props.conversationId] ?? null)
            : null
        "
        :live-tool="
          row.message.id === STREAMING_MESSAGE_ID
            ? (ai.toolLive[props.conversationId] ?? null)
            : null
        "
        :reply="replyViewOf(row.message)"
        :debug-line="row.debugLine"
        :select-mode="selectMode"
        :selected="Boolean(selectMode && selectedIds?.has(row.message.id))"
        @reply="(id) => emit('reply', id)"
        @recall="(id) => emit('recall', id)"
        @edit="(id) => emit('edit', id)"
        @pin="(id) => emit('pin', id)"
        @jump="jumpTo"
        @context="(payload) => emit('context', payload)"
        @preview="(url) => emit('preview', url)"
        @toggle-select="(id) => emit('toggle-select', id)"
      />
    </div>

    <!-- 下方留白 -->
    <div v-if="bottomSpacer > 0" :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />

    <div v-if="messages.length === 0 && !loading" class="grid place-items-center py-16">
      <p class="text-[13px] text-muted">还没有消息，说点什么吧</p>
    </div>
  </div>
</template>
