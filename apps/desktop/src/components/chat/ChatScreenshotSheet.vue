<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { MESSAGE_GROUP_WINDOW_MS, type Message } from '@nenochat/shared'
import { domToBlob } from 'modern-screenshot'
import Dialog from '@/components/ui/form/Dialog.vue'
import MessageItem from './MessageItem.vue'
import { dayKey, dayLabel, useMessageDisplay } from '@/composables/message-display'
import { cachedObjectUrl, ensureCached } from '@/platform/file-cache'
import { resolveImageDataUrl } from '@/platform/image-data-url'
import { savePngImage } from '@/platform/save-image'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
// 完整字标：footer 右下角的品牌水印，inline SVG 跟随 currentColor
import wordmark from '@/assets/nenochat-logo.svg?raw'

/**
 * 聊天截图：把选定消息合成一张带页眉页脚的长图。
 * 消息列表是虚拟滚动，不能直接截现有 DOM，这里在离屏容器里
 * 复用 MessageItem 重新渲染（与列表共用同一套展示解析），再交给 modern-screenshot 光栅化。
 */
const props = defineProps<{
  /** 页眉显示的会话名 */
  conversationName: string
  /** 参与截图的消息：已过滤可选消息，按 seq 升序 */
  messages: Message[]
  /** 全部已加载消息：解析引用块摘要用，缺省退回 messages */
  allMessages?: Message[]
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  (e: 'saved', target: 'desktop' | 'android' | 'browser'): void
}>()

const ui = useUiStore()
const auth = useAuthStore()

const display = useMessageDisplay(() => props.allMessages ?? props.messages)

type Phase = 'idle' | 'generating' | 'ready' | 'error'
const phase = ref<Phase>('idle')
const errorText = ref<string | null>(null)
const previewUrl = ref<string | null>(null)
const generatedAt = ref('')
const saving = ref(false)
let blob: Blob | null = null

const container = ref<HTMLElement | null>(null)
/** 生成图固定宽度：长图版式不跟随窗口宽度抖动 */
const sheetWidth = computed(() => (ui.isMobile ? 420 : 720))

type Row =
  | { kind: 'day'; key: string; ts: number }
  | { kind: 'message'; key: string; message: Message; showHeader: boolean }

/** 与列表一致的日期分隔与同人 5 分钟合并规则 */
const rows = computed<Row[]>(() => {
  const output: Row[] = []
  let lastDay = ''
  let prev: Message | null = null
  for (const message of props.messages) {
    const key = dayKey(message.createdAt)
    if (key !== lastDay) {
      output.push({ kind: 'day', key: `day-${key}`, ts: message.createdAt })
      lastDay = key
      prev = null
    }
    const grouped =
      prev !== null &&
      prev.senderId === message.senderId &&
      message.createdAt - prev.createdAt < MESSAGE_GROUP_WINDOW_MS &&
      !message.replyToId &&
      message.type !== 'system'
    output.push({ kind: 'message', key: message.id, message, showHeader: !grouped })
    prev = message
  }
  return output
})

/** 页脚的生成时间：写进图片里的绝对日期，不用「今天」这类相对词 */
function formatStamp(ts: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const d = new Date(ts)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fileName(): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const d = new Date()
  return `NenoChat-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** 图片附件预热到本地缓存，让容器里的 <img> 尽量用 blob URL，避免跨域污染 canvas */
async function prewarmAttachments(): Promise<void> {
  const tasks: Array<Promise<void>> = []
  for (const message of props.messages) {
    for (const attachment of message.meta?.attachments ?? []) {
      if (attachment.kind === 'voice') continue
      tasks.push(ensureCached(attachment.url, attachment.kind).catch(() => undefined))
    }
  }
  await Promise.all(tasks)
}

/**
 * 头像的展示地址。Avatar 组件不走本地缓存（始终是跨域网络地址），
 * 截图光栅化时跨域 fetch 可能被拦导致头像空白，这里先把头像预热成
 * 本地缓存 blob URL 再渲染；预热失败时回退原地址。
 */
const avatarUrls = ref<Record<string, string>>({})

function displayAvatar(message: Message): string | null {
  const raw = display.senderAvatar(message)
  if (!raw) return null
  return avatarUrls.value[raw] ?? raw
}

async function prewarmAvatars(): Promise<void> {
  const raws = new Set<string>()
  for (const message of props.messages) {
    const raw = display.senderAvatar(message)
    if (raw && !/^(data:|blob:)/i.test(raw)) raws.add(raw)
  }
  await Promise.all(
    [...raws].map(async (raw) => {
      try {
        await ensureCached(raw, 'avatar')
        const cached = await cachedObjectUrl(raw)
        if (cached) avatarUrls.value = { ...avatarUrls.value, [raw]: cached }
      } catch {
        /* 预热失败回退网络地址，尽力而为 */
      }
    }),
  )
}

/** 等容器内所有图片加载完成（或失败），再合成才能保证图片都在图里 */
function waitForImages(root: HTMLElement): Promise<void> {
  const images = [...root.querySelectorAll('img')]
  return Promise.all(
    images.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          }),
    ),
  ).then(() => undefined)
}

/** fetchFn 的转换缓存：同一地址只转换一次 */
const dataUrlCache = new Map<string, string>()

/**
 * 交给 modern-screenshot 的图片解析钩子：光栅化所需的每个图片地址
 * 先转成 data URL，全程零网络请求（blob: 地址直接读本地缓存），
 * 绕开跨域 CORS、陈旧 HTTP 缓存与 blob 失效三类问题；
 * 解析失败返回 false 交给默认管线降级。
 */
async function toDataUrl(url: string): Promise<string | false> {
  return (await resolveImageDataUrl(url, dataUrlCache)) ?? false
}

async function generate(): Promise<void> {
  phase.value = 'generating'
  errorText.value = null
  blob = null
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = null
  generatedAt.value = formatStamp(Date.now())

  try {
    await Promise.all([prewarmAttachments(), prewarmAvatars()])
    await nextTick()
    await nextFrame()
    if (!container.value) throw new Error('截图容器未就绪')
    await waitForImages(container.value)
    // img-fade 的淡入过渡有 160ms：等图片加载完再补一拍，避免拍到半透明
    await new Promise((resolve) => window.setTimeout(resolve, 220))
    await nextFrame()

    const result = await domToBlob(container.value, { scale: 2, fetchFn: toDataUrl })
    if (!result) throw new Error('截图生成失败')
    blob = result
    previewUrl.value = URL.createObjectURL(result)
    phase.value = 'ready'
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '截图生成失败'
    phase.value = 'error'
  }
}

function close(): void {
  open.value = false
}

watch(open, (next) => {
  if (next) {
    void generate()
    return
  }
  // 关闭即释放：容器卸载、预览地址回收
  phase.value = 'idle'
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = null
  blob = null
  errorText.value = null
})

async function save(): Promise<void> {
  if (!blob || saving.value) return
  saving.value = true
  errorText.value = null
  try {
    const result = await savePngImage(fileName(), blob)
    if (result) {
      emit('saved', result.target)
      close()
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!--
    离屏渲染容器：不能 display:none（会丢失布局），也不能移出视口
    （图片懒加载不会触发），用透明置底的方式让它正常布局、正常加载图片。
  -->
  <div
    v-if="phase === 'generating'"
    class="pointer-events-none fixed left-0 top-0 opacity-0"
    style="z-index: -1"
  >
    <div ref="container" class="bg-surface px-6 py-5 text-text" :style="{ width: `${sheetWidth}px` }">
      <header class="border-b border-line pb-3">
        <h1 class="text-[15px] font-semibold text-text-strong">{{ conversationName }}</h1>
        <p class="mt-0.5 text-[11px] text-muted">聊天记录 · 共 {{ messages.length }} 条</p>
      </header>

      <div class="flow-root">
        <template v-for="row in rows" :key="row.key">
          <div v-if="row.kind === 'day'" class="my-3 flex items-center gap-3">
            <span class="h-px flex-1 bg-line" />
            <span class="text-[11px] text-muted">{{ dayLabel(row.ts) }}</span>
            <span class="h-px flex-1 bg-line" />
          </div>
          <MessageItem
            v-else
            :message="row.message"
            :sender-name="display.senderName(row.message)"
            :sender-avatar="displayAvatar(row.message)"
            :sender-seed="display.senderSeed(row.message)"
            :is-own="row.message.senderId === auth.user?.id"
            :show-header="row.showHeader"
          />
        </template>
      </div>

      <footer class="mt-3 flex items-end justify-between border-t border-line pt-3">
        <p class="text-[11px] text-muted">生成于 {{ generatedAt }}</p>
        <!-- 品牌水印固定黑色，不随主题强调色变化 -->
        <span class="h-3.5 text-black [&>svg]:h-full [&>svg]:w-auto" v-html="wordmark" />
      </footer>
    </div>
  </div>

  <Dialog v-model:open="open" title="聊天截图" width="md">
    <div v-if="phase === 'generating'" class="grid place-items-center py-12">
      <p class="text-[13px] text-muted">正在生成截图…</p>
    </div>

    <div v-else-if="phase === 'ready' && previewUrl" class="space-y-3">
      <img
        :src="previewUrl"
        alt="聊天截图预览"
        class="max-h-[52vh] w-full rounded-lg border border-line object-contain"
      />
      <p v-if="errorText" class="text-[12px] text-danger">{{ errorText }}</p>
    </div>

    <div v-else-if="phase === 'error'" class="py-8 text-center">
      <p class="text-[13px] text-danger">{{ errorText ?? '截图生成失败' }}</p>
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-muted hover:text-text"
        @click="close"
      >
        关闭
      </button>
      <button
        v-if="phase === 'error'"
        type="button"
        class="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-text hover:bg-surface-2"
        @click="generate"
      >
        重试
      </button>
      <button
        v-if="phase === 'ready'"
        type="button"
        class="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        :disabled="saving"
        @click="save"
      >
        {{ saving ? '保存中…' : '保存图片' }}
      </button>
    </template>
  </Dialog>
</template>
