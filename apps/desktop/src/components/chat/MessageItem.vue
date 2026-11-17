<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import type { Message } from '@nenochat/shared'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import { resolveFileUrl } from '@/api/http'
import { formatMessageTime } from '@/composables/conversation'
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
  /** 生成中的占位行：还没出字时正文按灰字显示 */
  thinking?: boolean
  /** 生成中的临时占位：不出右键菜单与 hover 操作条 */
  ephemeral?: boolean
  /** 被引用消息的摘要：优先取快照，缺失时由列表从已加载消息解析 */
  reply?: { id: string; senderName: string; preview: string } | null
  /** 调试模式：该条 AI 消息的真实用量摘要，空则不显示 */
  debugLine?: string | null
}>()

const emit = defineEmits<{
  (e: 'reply', id: string): void
  (e: 'recall', id: string): void
  (e: 'edit', id: string): void
  (e: 'pin', id: string): void
  (e: 'jump', id: string): void
  (e: 'context', payload: { id: string; x: number; y: number }): void
  (e: 'preview', url: string): void
}>()

const deleted = computed(() => Boolean(props.message.deletedAt))

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
const attachments = computed(() =>
  (props.message.meta?.attachments ?? []).map((attachment) => ({
    ...attachment,
    url: resolveFileUrl(attachment.url) ?? attachment.url,
    thumbUrl: resolveFileUrl(attachment.thumbUrl ?? attachment.url) ?? attachment.url,
  })),
)

function openContextMenu(event: MouseEvent): void {
  // 撤回后的消息没有操作项，临时占位消息也不该有菜单
  if (deleted.value || props.ephemeral) return
  if (ui.isMobile) return
  event.preventDefault()
  emit('context', { id: props.message.id, x: event.clientX, y: event.clientY })
}

const ui = useUiStore()

/* ------------------------- 手机端长按菜单 ------------------------- */

let pressTimer = 0
let startX = 0
let startY = 0

function clearPress(): void {
  window.clearTimeout(pressTimer)
  pressTimer = 0
}

function onTouchStart(event: TouchEvent): void {
  if (!ui.isMobile || deleted.value || props.ephemeral) return
  const touch = event.touches[0]
  if (!touch) return
  startX = touch.clientX
  startY = touch.clientY
  clearPress()
  pressTimer = window.setTimeout(() => {
    emit('context', { id: props.message.id, x: startX, y: startY })
  }, 450)
}

function onTouchMove(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch || !pressTimer) return
  if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) clearPress()
}

onBeforeUnmount(clearPress)

const statusLabel = computed(() => {
  if (props.failed) return '发送失败'
  if (props.pending) return '发送中…'
  return ''
})

const showAiTail = computed(
  () => Boolean(props.aiGroupSize && props.aiGroupSize > 1 && props.message.aiIndex === props.aiGroupSize - 1),
)
</script>

<template>
  <div
    class="group relative px-4 transition-colors"
    :class="[
      mentionMe ? 'bg-mention-soft/50' : '',
      showHeader ? 'mt-2 pt-1' : 'py-0',
      ui.isMobile ? 'active:bg-surface-2/70' : 'hover:bg-surface-2/70',
    ]"
  >
    <span
      v-if="mentionMe"
      class="absolute top-0 bottom-0 left-0 w-[2px] bg-mention"
    />

    <div
      class="flex gap-2.5"
      @contextmenu="openContextMenu"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="clearPress"
      @touchcancel="clearPress"
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

      <div class="min-w-0 flex-1">
        <div v-if="showHeader" class="flex items-baseline gap-1.5">
          <span class="text-[13.5px] font-medium text-text-strong">{{ senderName }}</span>
          <span v-if="isOwn" class="rounded bg-surface-3 px-1 text-[10px] text-muted">我</span>
          <span class="text-[11px] text-muted">{{ formatMessageTime(message.createdAt) }}</span>
          <span v-if="message.editedAt && !deleted" class="text-[11px] text-muted">（已编辑）</span>
        </div>

        <!-- 引用 -->
        <button
          v-if="message.replyToId && !deleted"
          type="button"
          class="mt-1 flex max-w-full items-center gap-1.5 border-l-2 border-line bg-transparent pl-2 text-left text-[12px] text-muted transition-colors hover:text-text"
          @click="emit('jump', message.replyToId)"
        >
          <Icon name="reply" :size="12" class="shrink-0 text-accent" />
          <span class="shrink-0 text-accent">{{ reply?.senderName ?? '某条消息' }}</span>
          <span class="min-w-0 truncate">{{ reply?.preview ?? '原消息不在当前记录里' }}</span>
        </button>

        <!-- 撤回 -->
        <p v-if="deleted" class="py-0.5 text-[13px] text-muted italic">[消息已撤回]</p>

        <!-- 文本 -->
        <p
          v-else-if="message.type === 'text' || message.type === 'system'"
          class="text-[13.5px] leading-[1.6] whitespace-pre-wrap break-words text-text"
          :class="[
            message.type === 'system' ? 'text-[12px] text-muted' : '',
            thinking ? 'text-muted italic' : '',
          ]"
        >
          <template v-for="(segment, index) in segments" :key="index">
            <a
              v-if="segment.kind === 'link'"
              :href="segment.text"
              target="_blank"
              rel="noreferrer"
              class="text-accent hover:underline"
              >{{ segment.text }}</a
            >
            <span
              v-else-if="segment.kind === 'mention'"
              class="rounded bg-accent-soft px-1 font-medium text-accent"
              >{{ segment.text }}</span
            >
            <span v-else>{{ segment.text }}</span>
          </template>
          <span v-if="streaming" class="typing-caret ml-0.5" />
        </p>

        <!-- 图片 -->
        <div v-else-if="isImage" class="mt-1 space-y-1">
          <button
            v-for="attachment in attachments"
            :key="attachment.id"
            type="button"
            class="block overflow-hidden rounded-lg border border-line"
            @click="emit('preview', attachment.url)"
          >
            <img
              :src="attachment.thumbUrl || attachment.url"
              :alt="attachment.filename"
              class="max-h-[300px] w-auto max-w-full object-cover"
              loading="lazy"
            />
          </button>
          <p v-if="message.content" class="text-[13px]">{{ message.content }}</p>
        </div>

        <!-- 贴纸 -->
        <div v-else-if="isSticker" class="mt-1">
          <img
            v-for="attachment in attachments"
            :key="attachment.id"
            :src="attachment.url"
            :alt="attachment.filename"
            class="h-[140px] w-[140px] object-contain"
          />
        </div>

        <!-- 文件 -->
        <div v-else-if="message.type === 'file'" class="mt-1 space-y-1">
          <a
            v-for="attachment in attachments"
            :key="attachment.id"
            :href="attachment.url"
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
      v-if="!ui.isMobile && !deleted && !ephemeral"
      class="absolute -top-3 right-4 hidden items-center gap-0.5 rounded-lg border border-line bg-surface px-1 py-0.5 shadow-[var(--shadow-soft)] group-hover:flex"
    >
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        title="引用回复"
        @click="emit('reply', message.id)"
      >
        <Icon name="reply" :size="14" />
      </button>
      <button
        v-if="isOwn"
        type="button"
        class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        title="编辑"
        @click="emit('edit', message.id)"
      >
        <Icon name="edit" :size="14" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        title="置顶"
        @click="emit('pin', message.id)"
      >
        <Icon name="pin" :size="14" />
      </button>
      <button
        v-if="isOwn"
        type="button"
        class="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
        title="撤回"
        @click="emit('recall', message.id)"
      >
        <Icon name="trash" :size="14" />
      </button>
    </div>
  </div>
</template>
