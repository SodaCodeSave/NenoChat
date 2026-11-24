<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { type ConnectorActionMeta, type Message, type MomentCard, extractUrls } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import LinkCard from './LinkCard.vue'
import LinkInline from './LinkInline.vue'
import { connectorPresetOf } from '@/config/connectors'
import { resolveFileUrl } from '@/api/http'
import { resolveAttachmentUrl } from '@/platform/file-cache'
import { formatMessageTime } from '@/composables/conversation'
import { useLongPress } from '@/composables/use-long-press'
import { useVoicePlayer } from '@/composables/use-voice-player'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{
  message: Message
  senderName: string
  senderAvatar?: string | null
  senderSeed?: string
  isOwn: boolean
  showHeader: boolean
  mentionMe?: boolean
  pending?: boolean
  failed?: boolean
  streaming?: boolean
  /** 同一次 AI 回复的总条数，仅在最后一条显示 */
  aiGroupSize?: number
  /** 是否为该次 AI 生成的第一条：连接器提示只在这里显示一次 */
  aiGroupStart?: boolean
  /** 生成中正在执行的连接器动作，用于占位气泡的实时提示 */
  liveConnector?: ConnectorActionMeta['kind'] | null
  /** 正在调用的 MCP / 技能工具（人类可读名），与 liveConnector 同一展示位 */
  liveTool?: string | null
  /** 生成中的占位行：还没出字时正文按灰字显示 */
  thinking?: boolean
  /** 生成中的临时占位：不出右键菜单与 hover 操作条 */
  ephemeral?: boolean
  /** 被引用消息的摘要：优先取快照，缺失时由列表从已加载消息解析 */
  reply?: { id: string; senderName: string; preview: string } | null
  /** 调试模式：该条 AI 消息的真实用量摘要，空则不显示 */
  debugLine?: string | null
  /** 多选模式：点击整行切换选中，隐藏菜单与操作条 */
  selectMode?: boolean
  selected?: boolean
}>()

const emit = defineEmits<{
  (e: 'reply', id: string): void
  (e: 'recall', id: string): void
  (e: 'edit', id: string): void
  (e: 'pin', id: string): void
  (e: 'jump', id: string): void
  (e: 'context', payload: { id: string; x: number; y: number }): void
  (e: 'preview', url: string): void
  (e: 'toggle-select', id: string): void
}>()

const deleted = computed(() => Boolean(props.message.deletedAt))

/** 系统与撤回消息不参与多选 */
const selectable = computed(() => !deleted.value && props.message.type !== 'system')

/* ------------------------- 消息样式（Discord / QQ） ------------------------- */

const isQq = computed(() => ui.messageStyle === 'qq')
/** QQ 风格下自己的消息：整行镜像（头像在右、气泡靠右、用主题色气泡） */
const qqOwn = computed(() => isQq.value && props.isOwn)

/** QQ 风格下包进气泡的内容：仅文本类消息；贴纸/图片/文件/系统与撤回消息保持平铺 */
const momentCard = computed<MomentCard | null>(() => props.message.meta?.momentCard ?? null)

/** 动态卡片自带版式，不再套 QQ 气泡 */
const bubbleNeeded = computed(
  () => isQq.value && props.message.type === 'text' && !deleted.value && !momentCard.value,
)

/** 引用块随自己的彩色气泡时需要换成白色系配色，避免白底上白字 */
const inOwnBubble = computed(() => bubbleNeeded.value && qqOwn.value)

const bubbleClass = computed(() => {
  if (!bubbleNeeded.value) return ''
  return qqOwn.value
    ? 'max-w-[78%] rounded-2xl rounded-tr-md bg-accent px-3 py-2'
    : 'max-w-[78%] rounded-2xl rounded-tl-md bg-surface-2 px-3 py-2'
})

/** QQ 风格下内容列改为纵向 flex，按发送方对齐；系统消息居中 */
const contentAlign = computed(() => {
  if (!isQq.value) return ''
  if (props.message.type === 'system') return 'flex flex-col items-center'
  return qqOwn.value ? 'flex flex-col items-end' : 'flex flex-col items-start'
})

/** 把正文按 @提及 与链接切开，其余原样保留 */
const segments = computed(() => {
  const text = props.message.content
  const parts: Array<{ text: string; kind: 'text' | 'mention' | 'link' }> = []
  const pattern = /(@[^\s@]+|https?:\/\/[^\s]+)/g
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > lastIndex) parts.push({ text: text.slice(lastIndex, index), kind: 'text' })
    const token = match[0]
    parts.push({ text: token, kind: token.startsWith('@') ? 'mention' : 'link' })
    lastIndex = index + token.length
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), kind: 'text' })
  return parts
})

const isImage = computed(() => props.message.type === 'image')
const isSticker = computed(() => props.message.type === 'sticker')

/** 正文里的链接：每条都渲染卡片，失败时卡片组件自身降级为不显示 */
const linkUrls = computed(() => extractUrls(props.message.content))

/** 链接展示样式：card 正文后追加信息卡片，logo 正文里的链接直接替换为 LOGO + 标题 */
const linkLogo = computed(() => ui.linkDisplay === 'logo')

/** 动态卡片封面：附件地址是相对路径，按当前服务器解析 */
const cardCoverUrl = computed(() =>
  momentCard.value ? resolveFileUrl(momentCard.value.coverUrl ?? null) : null,
)

/** 命中本地缓存后用 blob URL 展示，离线也能看图；未命中时先用网络地址 */
const cachedUrls = ref<Record<string, string>>({})

watch(
  () => props.message.meta?.attachments,
  async (list) => {
    if (!list || list.length === 0) return
    const resolved = await Promise.all(
      list.map(async (attachment) => {
        try {
          const url = await resolveAttachmentUrl(attachment.url, attachment.kind)
          return url ? ([attachment.id, url] as const) : null
        } catch {
          return null
        }
      }),
    )
    const next = Object.fromEntries(resolved.filter((item): item is readonly [string, string] => item !== null))
    if (Object.keys(next).length > 0) cachedUrls.value = { ...cachedUrls.value, ...next }
  },
  // 消息更新总是整体替换对象，不需要深比较；附件缓存命中与否只看引用
  { immediate: true },
)

const attachments = computed(() =>
  (props.message.meta?.attachments ?? []).map((attachment) => ({
    ...attachment,
    url: resolveFileUrl(attachment.url) ?? attachment.url,
    thumbUrl: resolveFileUrl(attachment.thumbUrl ?? attachment.url) ?? attachment.url,
    displayUrl:
      cachedUrls.value[attachment.id] ??
      resolveFileUrl(attachment.thumbUrl ?? attachment.url) ??
      attachment.url,
  })),
)

/* --------------------------- 语音消息 --------------------------- */

const voicePlayer = useVoicePlayer()

const voiceAttachment = computed(() =>
  props.message.type === 'voice' ? (attachments.value[0] ?? null) : null,
)

const isVoicePlaying = computed(
  () =>
    voiceAttachment.value !== null &&
    voicePlayer.playingUrl.value === voiceAttachment.value.displayUrl,
)

const isVoiceLoading = computed(
  () =>
    voiceAttachment.value !== null &&
    voicePlayer.loadingUrl.value === voiceAttachment.value.displayUrl,
)

/** 时长显示：整秒不带小数，如 12″ / 12.3″ */
const voiceDuration = computed(() => {
  const seconds = voiceAttachment.value?.duration ?? 0
  if (seconds <= 0) return null
  return Number.isInteger(seconds) ? `${seconds}″` : `${seconds.toFixed(1)}″`
})

function playVoice(): void {
  const url = voiceAttachment.value?.displayUrl
  if (!url) return
  void voicePlayer.toggle(url)
}

function openContextMenu(event: MouseEvent): void {
  // 撤回后的消息没有操作项，临时占位消息也不该有菜单；多选模式点击即选择
  if (deleted.value || props.ephemeral || props.selectMode) return
  if (ui.isMobile) return
  event.preventDefault()
  emit('context', { id: props.message.id, x: event.clientX, y: event.clientY })
}

/** 多选模式下任何点击（capture 阶段）都转为切换选中，阻断图片预览、语音播放等原生行为 */
function onSelectCapture(event: MouseEvent): void {
  if (!props.selectMode || !selectable.value) return
  event.stopPropagation()
  event.preventDefault()
  emit('toggle-select', props.message.id)
}

const ui = useUiStore()

/* ------------------------- 手机端长按菜单 ------------------------- */

const press = useLongPress((x, y) => emit('context', { id: props.message.id, x, y }))

function onTouchStart(event: TouchEvent): void {
  // 撤回后的消息与临时占位没有菜单，桌面端也用不到长按；多选模式下长按无意义
  if (!ui.isMobile || deleted.value || props.ephemeral || props.selectMode) return
  press.onTouchStart(event)
}

const statusLabel = computed(() => {
  if (props.failed) return '发送失败'
  if (props.pending) return '发送中…'
  return ''
})

const showAiTail = computed(
  () => Boolean(props.aiGroupSize && props.aiGroupSize > 1 && props.message.aiIndex === props.aiGroupSize - 1),
)

/* --------------------------- 连接器调用提示 --------------------------- */

/** 已加载完的图片/贴纸 id：数据到位后再淡入，避免网络图凭空弹出 */
const loadedImages = ref<Set<string>>(new Set())

function markImageLoaded(id: string): void {
  loadedImages.value.add(id)
}

const bilibiliIcon = connectorPresetOf('bilibili')?.icon ?? null
const heweatherIcon = connectorPresetOf('heweather')?.icon ?? null

/** 固化提示：本次回复用过的连接器动作，仅在该次生成的第一条消息上显示 */
const connectorHints = computed(() => {
  if (!props.aiGroupStart || !ui.showConnectorHints) return []
  return (props.message.meta?.ai?.connector ?? []).map((action) => ({
    kind: action.kind,
    icon: action.kind === 'bilibili' ? bilibiliIcon : action.kind === 'weather' ? heweatherIcon : null,
    label:
      action.kind === 'web_search'
        ? '已联网搜索'
        : action.kind === 'fetch'
          ? `已阅读${action.detail ? ` ${action.detail}` : '网页'}`
          : action.kind === 'weather'
            ? '已查询天气'
            : `已获取 B 站视频${action.detail ? `《${action.detail}》` : '资料'}`,
  }))
})

/** 实时提示：占位气泡阶段正在执行的连接器动作或工具调用 */
const liveConnectorLabel = computed(() => {
  if (!props.thinking || !ui.showConnectorHints) return ''
  if (props.liveTool) return `正在调用工具 ${props.liveTool}…`
  if (!props.liveConnector) return ''
  return props.liveConnector === 'web_search'
    ? '正在联网搜索…'
    : props.liveConnector === 'fetch'
      ? '正在阅读网页…'
      : props.liveConnector === 'weather'
        ? '正在查询天气…'
        : '正在获取 B 站视频资料…'
})
</script>

<template>
  <div
    class="group relative px-4 transition-colors"
    :class="[
      mentionMe ? 'bg-mention-soft/50' : '',
      selectMode && selected ? 'bg-accent-soft/60' : '',
      selectMode && selectable ? 'pl-10 cursor-pointer' : '',
      showHeader ? 'mt-2 pt-1' : 'py-0',
      ui.isMobile ? 'active:bg-surface-2/70' : 'hover:bg-surface-2/70',
    ]"
    @click.capture="onSelectCapture"
  >
    <span
      v-if="mentionMe"
      class="absolute top-0 bottom-0 left-0 w-[2px] bg-mention"
    />

    <!-- 多选勾选框：纯指示器，点击行为由整行的 capture 统一处理 -->
    <span
      v-if="selectMode && selectable"
      class="absolute left-2.5 top-1/2 z-10 flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full border transition-colors"
      :class="selected ? 'border-accent bg-accent text-white' : 'border-muted/60 bg-surface text-transparent'"
      aria-hidden="true"
    >
      <Icon name="check" :size="10" />
    </span>

    <div
      class="flex gap-2.5"
      :class="qqOwn ? 'flex-row-reverse' : ''"
      @contextmenu="openContextMenu"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="press.onTouchMove"
      @touchend="press.onTouchEnd"
      @touchcancel="press.onTouchEnd"
    >
      <!-- 头像列：同一组内只有首条显示 -->
      <div class="w-9 shrink-0">
        <Avatar
          v-if="showHeader"
          :name="senderName"
          :src="senderAvatar ?? null"
          :seed="senderSeed ?? message.senderId ?? message.id"
          :size="36"
        />
      </div>

      <div class="min-w-0 flex-1" :class="contentAlign">
        <div
          v-if="showHeader"
          class="flex items-baseline gap-1.5"
          :class="qqOwn ? 'justify-end' : ''"
        >
          <span class="text-[13.5px] font-medium text-text-strong">{{ senderName }}</span>
          <span v-if="isOwn" class="rounded bg-surface-3 px-1 text-[10px] text-muted">我</span>
          <span class="text-[11px] text-muted">{{ formatMessageTime(message.createdAt) }}</span>
          <span v-if="message.editedAt && !deleted" class="text-[11px] text-muted">（已编辑）</span>
        </div>

        <!-- 气泡容器：QQ 风格下文本消息包进气泡（引用也随气泡对齐），其余风格保持平铺 -->
        <div class="min-w-0" :class="bubbleClass">
          <!-- 引用：独立引用块，带底色与圆角，和正文拉开层次 -->
          <button
            v-if="message.replyToId && !deleted"
            type="button"
            class="flex max-w-full items-center gap-1.5 rounded-md border-l-2 py-1 pl-2 pr-2.5 text-left text-[12px] transition-colors"
            :class="[
              bubbleNeeded ? '' : 'mt-1 mb-0.5',
              inOwnBubble
                ? 'border-white/60 bg-white/15 text-white/80 hover:bg-white/25 hover:text-white'
                : 'border-accent/40 bg-surface-3/70 text-muted hover:bg-surface-3 hover:text-text',
            ]"
            @click="emit('jump', message.replyToId)"
          >
            <Icon
              name="reply"
              :size="12"
              class="shrink-0"
              :class="inOwnBubble ? 'text-white' : 'text-accent'"
            />
            <span
              class="shrink-0"
              :class="inOwnBubble ? 'text-white' : 'text-accent'"
              >{{ reply?.senderName ?? '某条消息' }}</span
            >
            <span class="min-w-0 truncate">{{ reply?.preview ?? '原消息不在当前记录里' }}</span>
          </button>

          <!-- 撤回 -->
          <p v-if="deleted" class="py-0.5 text-[13px] text-muted italic">[消息已撤回]</p>

          <!-- 文本 -->
          <template v-else-if="message.type === 'text' || message.type === 'system'">
            <!-- 动态分享卡片：点击回到原动态 -->
            <a
              v-if="momentCard"
              :href="`#/moments?post=${encodeURIComponent(momentCard.postId)}`"
              class="block w-[240px] overflow-hidden rounded-xl border border-line bg-surface text-text no-underline transition-colors hover:border-accent"
            >
              <div v-if="cardCoverUrl" class="h-28 overflow-hidden bg-surface-2">
                <img :src="cardCoverUrl" alt="动态封面" class="h-full w-full object-cover" />
              </div>
              <div class="p-2.5">
                <p class="flex items-center gap-1.5 text-[12px] text-muted">
                  <Avatar
                    :name="momentCard.authorName"
                    :src="momentCard.authorAvatarUrl ?? null"
                    :seed="momentCard.postId"
                    :size="16"
                  />
                  <span class="min-w-0 truncate">{{ momentCard.authorName }}</span>
                </p>
                <p class="mt-1 line-clamp-2 text-[13px] leading-[1.5] text-text">
                  {{ momentCard.excerpt }}
                </p>
                <p class="mt-1.5 text-[11px] text-[#576b95]">查看动态 →</p>
              </div>
            </a>
            <template v-else>
              <!-- 连接器提示：本次回复用过的资料来源 -->
              <div
                v-if="connectorHints.length > 0"
                class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]"
                :class="qqOwn ? 'text-white/75' : 'text-muted'"
              >
                <template v-for="(hint, index) in connectorHints" :key="hint.kind">
                  <span v-if="index > 0" :class="qqOwn ? 'text-white/40' : 'text-muted/50'">·</span>
                  <span class="flex items-center gap-1">
                    <SvgIcon v-if="hint.icon" :source="hint.icon" class="h-3 w-3" />
                    <Icon v-else :name="hint.kind === 'web_search' ? 'search' : 'globe'" :size="12" />
                    {{ hint.label }}
                  </span>
                </template>
              </div>

              <!-- 连接器实时提示：思考阶段正在执行的动作 -->
              <div
                v-if="liveConnectorLabel"
                class="mt-1 flex items-center gap-1 text-[11px]"
                :class="qqOwn ? 'text-white/75' : 'text-muted'"
              >
                <Icon name="refresh" :size="12" class="animate-spin" />
                {{ liveConnectorLabel }}
              </div>

              <p
                class="text-[13.5px] leading-[1.6] whitespace-pre-wrap break-words"
                :class="[
                  qqOwn ? 'text-white' : 'text-text',
                  message.type === 'system' ? 'text-[12px] text-muted' : '',
                  thinking ? (qqOwn ? 'text-white/70 italic' : 'text-muted italic') : '',
                ]"
              >
                <template v-for="(segment, index) in segments" :key="index">
                  <!-- LOGO 模式：正文里的链接直接替换成 LOGO + 标题（流式中的半截链接仍按普通链接显示） -->
                  <LinkInline
                    v-if="segment.kind === 'link' && linkLogo && !streaming && !thinking"
                    :url="segment.text"
                    :inherit-color="qqOwn"
                  />
                  <a
                    v-else-if="segment.kind === 'link'"
                    :href="segment.text"
                    target="_blank"
                    rel="noreferrer"
                    class="hover:underline"
                    :class="qqOwn ? 'text-white underline decoration-white/50' : 'text-accent'"
                    >{{ segment.text }}</a
                  >
                  <span
                    v-else-if="segment.kind === 'mention'"
                    class="rounded px-1 font-medium"
                    :class="qqOwn ? 'bg-white/25 text-white' : 'bg-accent-soft text-accent'"
                    >{{ segment.text }}</span
                  >
                  <span v-else>{{ segment.text }}</span>
                </template>
                <span v-if="streaming" class="typing-caret ml-0.5" />
              </p>

              <!-- 链接卡片：仅卡片模式追加在正文后；流式生成中的半截链接不请求元信息 -->
              <div
                v-if="linkUrls.length > 0 && !streaming && !thinking && !linkLogo"
                class="mt-1.5 space-y-1.5"
              >
                <LinkCard v-for="url in linkUrls" :key="url" :url="url" />
              </div>
            </template>
          </template>

          <!-- 语音：点击播放/停止，转写文本（或合成原文）显示在下方 -->
          <div v-else-if="message.type === 'voice'">
            <button
              type="button"
              class="flex items-center gap-2 rounded-full border border-line bg-surface-2 py-2 pl-3 pr-4 transition-colors hover:border-accent"
              :class="qqOwn ? 'border-white/40 bg-white/15 text-white hover:border-white' : 'text-text'"
              :aria-label="isVoicePlaying ? '停止播放' : '播放语音'"
              @click="playVoice"
            >
              <Icon
                name="volume"
                :size="16"
                :class="[
                  isVoiceLoading ? 'animate-pulse text-accent' : isVoicePlaying ? 'text-accent' : '',
                  qqOwn && !isVoicePlaying && !isVoiceLoading ? 'text-white' : '',
                ]"
              />
              <span class="flex items-end gap-[2px]" aria-hidden="true">
                <span
                  v-for="bar in [10, 16, 7]"
                  :key="bar"
                  class="w-[2px] rounded-full"
                  :class="isVoicePlaying ? 'bg-accent voice-bar' : qqOwn ? 'bg-white/50' : 'bg-muted/60'"
                  :style="{ height: `${bar}px`, animationDelay: `${bar % 3 * 120}ms` }"
                />
              </span>
              <span class="min-w-[2ch] text-[12px] tabular-nums">
                {{ voiceDuration ?? '语音' }}
              </span>
            </button>
            <p
              v-if="message.content"
              class="mt-1 text-[12.5px] leading-relaxed"
              :class="qqOwn ? 'text-white/85' : 'text-muted'"
            >
              {{ message.content }}
            </p>
          </div>

          <!-- 图片 -->
          <div v-else-if="isImage" class="mt-1 space-y-1">
            <button
              v-for="attachment in attachments"
              :key="attachment.id"
              type="button"
              class="block overflow-hidden rounded-lg border border-line"
              @click="emit('preview', attachment.displayUrl)"
            >
              <img
                :src="attachment.displayUrl"
                :alt="attachment.filename"
                class="img-fade max-h-[300px] w-auto max-w-full object-cover"
                :data-loaded="loadedImages.has(attachment.id) ? 'true' : 'false'"
                loading="lazy"
                @load="markImageLoaded(attachment.id)"
                @error="markImageLoaded(attachment.id)"
              />
            </button>
            <p v-if="message.content" class="text-[13px]">{{ message.content }}</p>
          </div>

          <!-- 贴纸 -->
          <div v-else-if="isSticker">
            <img
              v-for="attachment in attachments"
              :key="attachment.id"
              :src="attachment.displayUrl"
              :alt="attachment.filename"
              class="img-fade block max-h-[160px] max-w-[200px] rounded-lg object-contain"
              :data-loaded="loadedImages.has(attachment.id) ? 'true' : 'false'"
              @load="markImageLoaded(attachment.id)"
              @error="markImageLoaded(attachment.id)"
            />
          </div>

          <!-- 文件 -->
          <div v-else-if="message.type === 'file'" class="mt-1 space-y-1">
            <a
              v-for="attachment in attachments"
              :key="attachment.id"
              :href="attachment.displayUrl"
              target="_blank"
              class="flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 hover:border-accent"
            >
              <Icon name="folder" :size="18" class="text-accent" />
              <div class="min-w-0">
                <p class="truncate text-[13px] text-text-strong">{{ attachment.filename }}</p>
                <p class="text-[11px] text-muted">
                  {{ Math.max(1, Math.round(attachment.size / 1024)) }} KB
                </p>
              </div>
            </a>
          </div>
        </div>

        <div class="mt-0.5 flex items-center gap-2">
          <span v-if="statusLabel" class="text-[11px]" :class="failed ? 'text-danger' : 'text-muted'">
            {{ statusLabel }}
          </span>
          <span v-if="showAiTail" class="text-[11px] text-muted">共 {{ aiGroupSize }} 条</span>
          <span v-if="debugLine" class="truncate font-mono text-[10px] text-muted/70">
            {{ debugLine }}
          </span>
        </div>
      </div>
    </div>

    <!-- hover 操作条 -->
    <div
      v-if="!ui.isMobile && !deleted && !ephemeral && !selectMode"
      class="invisible absolute -top-3 flex items-center gap-0.5 rounded-lg border border-line bg-surface px-1 py-0.5 opacity-0 shadow-[var(--shadow-soft)] transition-opacity duration-100 group-hover:visible group-hover:opacity-100"
      :class="qqOwn ? 'left-4' : 'right-4'"
    >
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        title="引用回复"
        aria-label="引用回复"
        @click="emit('reply', message.id)"
      >
        <Icon name="reply" :size="14" />
      </button>
      <button
        v-if="isOwn"
        type="button"
        class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        title="编辑"
        aria-label="编辑"
        @click="emit('edit', message.id)"
      >
        <Icon name="edit" :size="14" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        title="置顶"
        aria-label="置顶"
        @click="emit('pin', message.id)"
      >
        <Icon name="pin" :size="14" />
      </button>
      <button
        v-if="isOwn"
        type="button"
        class="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
        title="撤回"
        aria-label="撤回"
        @click="emit('recall', message.id)"
      >
        <Icon name="trash" :size="14" />
      </button>
    </div>
  </div>
</template>
