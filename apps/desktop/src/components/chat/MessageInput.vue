<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import type { AttachmentRef, Message, Sticker } from '@nenochat/shared'
import { uploadFile } from '@/api/files'
import { resolveFileUrl } from '@/api/http'
import { useAuthStore } from '@/stores/auth'
import { useMembersStore } from '@/stores/members'
import { useStickersStore } from '@/stores/stickers'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{
  conversationId: string
  replyTo?: Message | null
  editing?: Message | null
  disabled?: boolean
  placeholder?: string
  /** AI 会话模式：附件先缓冲在输入框，随正文一起发送；仅支持图片 */
  aiMode?: boolean
  /** 群聊才显示「全体成员」提及项 */
  mentionAllEnabled?: boolean
}>()

/** 发送时从正文解析出的提及信息 */
export interface MentionSummary {
  userIds: string[]
  mentionAll: boolean
}

const emit = defineEmits<{
  (e: 'send', content: string, mentions?: MentionSummary, attachments?: AttachmentRef[]): void
  (e: 'typing'): void
  (e: 'cancel-reply'): void
  (e: 'cancel-edit'): void
  (e: 'attachment', payload: { attachment: AttachmentRef; type: 'image' | 'file' }): void
  (e: 'sticker', sticker: Sticker): void
}>()

const ui = useUiStore()
const auth = useAuthStore()
const stickers = useStickersStore()
const members = useMembersStore()

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const emojiOpen = ref(false)
const panelTab = ref<string>('emoji')
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref<{ name: string; percent: number } | null>(null)
const uploadError = ref<string | null>(null)

const QUICK_EMOJI = [
  '😀', '😂', '🥹', '😊', '😍', '🤔', '😅', '😭',
  '😡', '🥳', '😴', '🤯', '👍', '👏', '🙏', '💪',
  '❤️', '🔥', '🎉', '✨', '🌙', '☕', '🍜', '🐱',
]

const canSend = computed(
  () => (text.value.trim().length > 0 || pendingAttachments.value.length > 0) && !props.disabled,
)

const activePack = computed(
  () => stickers.packs.find((entry) => entry.pack.id === panelTab.value) ?? null,
)

function autoGrow(): void {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 168)}px`
}

/** 双击发送按钮 / 连按两次 Enter 时挡住第二次，避免一条内容发两遍 */
let lastSubmitAt = 0

/* --------------------------- @ 提及 --------------------------- */

interface MentionCandidate {
  /** null 表示「全体成员」 */
  userId: string | null
  name: string
  avatarUrl?: string | null
  seed?: string
}

const mentionOpen = ref(false)
const mentionIndex = ref(0)
/** '@' 在正文中的起始位置，-1 表示未在输入提及 */
const mentionStart = ref(-1)
const mentionQuery = ref('')
const mentionList = ref<HTMLElement | null>(null)

const memberCandidates = computed<MentionCandidate[]>(() =>
  members
    .of(props.conversationId)
    .filter((m) => m.userId !== auth.user?.id)
    .map((m) => ({
      userId: m.userId,
      name: members.displayName(m),
      avatarUrl: m.user?.avatarUrl ?? null,
      seed: m.userId,
    })),
)

const mentionCandidates = computed<MentionCandidate[]>(() => {
  const query = mentionQuery.value.toLowerCase()
  const matched = memberCandidates.value.filter((m) => m.name.toLowerCase().includes(query))
  if (props.mentionAllEnabled && '全体成员'.toLowerCase().includes(query)) {
    return [{ userId: null, name: '全体成员', avatarUrl: null, seed: 'all' }, ...matched]
  }
  return matched
})

/** 根据光标位置判断是否正在输入 @ 提及，是则打开候选弹窗 */
function updateMention(): void {
  const el = textarea.value
  if (!el || props.disabled || props.aiMode) {
    closeMention()
    return
  }
  const caret = el.selectionStart ?? text.value.length
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.value.slice(0, caret))
  if (!match) {
    closeMention()
    return
  }
  mentionStart.value = caret - match[1]!.length - 1
  mentionQuery.value = match[1]!
  if (mentionCandidates.value.length === 0) {
    closeMention()
    return
  }
  mentionOpen.value = true
  mentionIndex.value = 0
}

function closeMention(): void {
  mentionOpen.value = false
  mentionIndex.value = 0
  mentionStart.value = -1
  mentionQuery.value = ''
}

/** 把选中的候选替换进正文，@xxx 变成一个完整提及 */
function pickMention(candidate: MentionCandidate): void {
  if (mentionStart.value < 0) return
  const start = mentionStart.value
  const end = start + 1 + mentionQuery.value.length
  const insertion = `@${candidate.name} `
  text.value = text.value.slice(0, start) + insertion + text.value.slice(end)
  closeMention()
  void nextTick(() => {
    const el = textarea.value
    if (!el) return
    const caret = start + insertion.length
    el.focus()
    el.setSelectionRange(caret, caret)
    autoGrow()
  })
}

watch(mentionIndex, async () => {
  await nextTick()
  mentionList.value?.querySelector('.mention-active')?.scrollIntoView({ block: 'nearest' })
})

/** 成员侧栏点击成员时插入 @ 提及 */
function insertMention(_userId: string, displayName: string): void {
  const el = textarea.value
  const caret = el?.selectionStart ?? text.value.length
  const insertion = `@${displayName} `
  text.value = text.value.slice(0, caret) + insertion + text.value.slice(caret)
  void nextTick(() => {
    const target = textarea.value
    if (!target) return
    const next = caret + insertion.length
    target.focus()
    target.setSelectionRange(next, next)
    autoGrow()
  })
}

defineExpose({ insertMention })

/** 从正文解析 @ 提及：按显示名匹配成员，@全体成员 触发全体提醒 */
function collectMentions(): MentionSummary | null {
  const list = members.of(props.conversationId)
  const userIds = new Set<string>()
  let mentionAll = false
  for (const match of text.value.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const name = match[1]!
    if (props.mentionAllEnabled && '全体成员'.startsWith(name)) mentionAll = true
    const member = list.find((m) => {
      const displayName = members.displayName(m)
      return displayName === name || displayName.startsWith(name)
    })
    if (member) userIds.add(member.userId)
  }
  if (!mentionAll && userIds.size === 0) return null
  return { userIds: [...userIds], mentionAll }
}

function submit(): void {
  if (!canSend.value) return
  const now = Date.now()
  if (now - lastSubmitAt < 300) return
  lastSubmitAt = now
  const attachments = props.aiMode ? [...pendingAttachments.value] : undefined
  emit('send', text.value.trim(), collectMentions() ?? undefined, attachments)
  text.value = ''
  if (props.aiMode) pendingAttachments.value = []
  closeMention()
  void nextTick(autoGrow)
}

function onKeydown(event: KeyboardEvent): void {
  // 中文输入法组词中的 Enter 是「选词」，不能当成发送
  if (event.isComposing || event.keyCode === 229) return

  // 提及弹窗打开时，方向键 / Enter / Tab 先服务于选人
  if (mentionOpen.value && mentionCandidates.value.length > 0) {
    const total = mentionCandidates.value.length
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const delta = event.key === 'ArrowUp' ? -1 : 1
      mentionIndex.value = (mentionIndex.value + delta + total) % total
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pickMention(mentionCandidates.value[mentionIndex.value]!)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMention()
      return
    }
  }

  const sendWithEnter = ui.sendKey === 'enter'

  if (event.key === 'Enter') {
    if (sendWithEnter && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    if (!sendWithEnter && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
    }
  }

  if (event.key === 'Escape') {
    if (props.editing) emit('cancel-edit')
    else if (props.replyTo) emit('cancel-reply')
  }
}

function insertEmoji(emoji: string): void {
  text.value = `${text.value}${emoji}`
  emojiOpen.value = false
  void nextTick(() => {
    textarea.value?.focus()
    autoGrow()
  })
}

/* --------------------------- 表情包 --------------------------- */

function openPanel(): void {
  emojiOpen.value = !emojiOpen.value
  if (emojiOpen.value) {
    void stickers.load()
    if (panelTab.value !== 'emoji' && !activePack.value) panelTab.value = 'emoji'
  }
}

function sendSticker(sticker: Sticker): void {
  emojiOpen.value = false
  emit('sticker', sticker)
}

/* --------------------------- 附件上传 --------------------------- */

/** AI 会话模式下先缓冲的图片，发送时随正文一起交出去 */
const pendingAttachments = ref<AttachmentRef[]>([])

function removePending(id: string): void {
  pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id)
}

async function handleFiles(files: File[]): Promise<void> {
  if (files.length === 0) return
  uploadError.value = null

  // AI 会话：只收图片，先缓冲在输入框里，随正文一起发送
  if (props.aiMode) {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) {
      uploadError.value = 'AI 会话暂只支持发送图片'
      return
    }
    for (const file of images.slice(0, 9 - pendingAttachments.value.length)) {
      uploading.value = { name: file.name, percent: 0 }
      try {
        const attachment = await uploadFile(file, {
          kind: 'file',
          onProgress: (percent) => {
            if (uploading.value) uploading.value.percent = percent
          },
        })
        pendingAttachments.value = [
          ...pendingAttachments.value,
          {
            id: attachment.id,
            kind: 'image',
            filename: attachment.filename,
            mime: attachment.mime,
            size: attachment.size,
            width: attachment.width,
            height: attachment.height,
            url: attachment.url,
            thumbUrl: attachment.thumbUrl,
          },
        ]
      } catch (e) {
        uploadError.value = e instanceof Error ? e.message : '上传失败'
      } finally {
        uploading.value = null
      }
    }
    return
  }

  for (const file of files.slice(0, 9)) {
    uploading.value = { name: file.name, percent: 0 }
    try {
      const attachment = await uploadFile(file, {
        kind: 'file',
        onProgress: (percent) => {
          if (uploading.value) uploading.value.percent = percent
        },
      })
      const isImage = attachment.mime.startsWith('image/')
      emit('attachment', {
        attachment: {
          id: attachment.id,
          kind: isImage ? 'image' : 'file',
          filename: attachment.filename,
          mime: attachment.mime,
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
          url: attachment.url,
          thumbUrl: attachment.thumbUrl,
        },
        type: isImage ? 'image' : 'file',
      })
    } catch (e) {
      uploadError.value = e instanceof Error ? e.message : '上传失败'
    } finally {
      uploading.value = null
    }
  }
}

function onPickFiles(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  void handleFiles(files)
}

/** 截图直接 Ctrl+V 粘贴就能发，不必先存文件 */
function onPaste(event: ClipboardEvent): void {
  const items = Array.from(event.clipboardData?.items ?? [])
  const files = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))

  if (files.length > 0) {
    event.preventDefault()
    void handleFiles(files)
  }
}

watch(
  () => props.editing,
  async (message) => {
    closeMention()
    if (message) {
      text.value = message.content
      await nextTick()
      textarea.value?.focus()
      autoGrow()
    } else {
      text.value = ''
      void nextTick(autoGrow)
    }
  },
)

watch(
  () => props.conversationId,
  () => {
    closeMention()
    pendingAttachments.value = []
  },
)

watch(text, () => {
  if (text.value.length > 0) emit('typing')
})

onMounted(() => {
  void stickers.load()
})
</script>

<template>
  <div
    class="border-t border-line bg-surface px-3 pt-2"
    :class="ui.isMobile ? 'pb-[calc(0.75rem+var(--safe-bottom))]' : 'pb-3'"
  >
    <!-- 引用 / 编辑提示条 -->
    <div
      v-if="replyTo || editing"
      class="animate-fade-in mb-1.5 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px]"
    >
      <Icon :name="editing ? 'edit' : 'reply'" :size="13" class="text-accent" />
      <span class="text-muted">{{ editing ? '正在编辑消息' : '正在回复' }}</span>
      <span class="min-w-0 flex-1 truncate text-text">
        {{ (editing ?? replyTo)?.content?.slice(0, 80) }}
      </span>
      <button
        type="button"
        class="text-muted hover:text-text"
        @click="editing ? emit('cancel-edit') : emit('cancel-reply')"
      >
        <Icon name="close" :size="13" />
      </button>
    </div>

    <!-- 上传进度 -->
    <div
      v-if="uploading"
      class="mb-1.5 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5"
    >
      <Icon name="paperclip" :size="13" class="text-accent" />
      <span class="min-w-0 flex-1 truncate text-[12px] text-text">{{ uploading.name }}</span>
      <span class="text-[11px] text-muted">{{ uploading.percent }}%</span>
      <div class="h-1 w-20 overflow-hidden rounded-full bg-surface-3">
        <div class="h-full bg-accent transition-all" :style="{ width: `${uploading.percent}%` }" />
      </div>
    </div>

    <p v-if="uploadError" class="mb-1.5 text-[11.5px] text-danger">{{ uploadError }}</p>

    <!-- AI 会话：待发送的图片，随正文一起发出 -->
    <div v-if="aiMode && pendingAttachments.length > 0" class="mb-1.5 flex flex-wrap gap-1.5">
      <div
        v-for="attachment in pendingAttachments"
        :key="attachment.id"
        class="group relative h-12 w-12"
      >
        <img
          :src="resolveFileUrl(attachment.thumbUrl ?? attachment.url) ?? attachment.url"
          :alt="attachment.filename"
          class="h-12 w-12 rounded-lg border border-line object-cover"
        />
        <button
          type="button"
          class="absolute -right-1.5 -top-1.5 hidden h-[18px] w-[18px] items-center justify-center rounded-full bg-surface-3 text-muted hover:text-danger group-hover:flex"
          @click="removePending(attachment.id)"
        >
          <Icon name="close" :size="10" />
        </button>
      </div>
    </div>

    <div class="relative rounded-xl border border-line bg-surface-2 focus-within:border-accent">
      <textarea
        ref="textarea"
        v-model="text"
        rows="1"
        :disabled="disabled"
        :placeholder="placeholder ?? '输入消息，Enter 发送，Shift+Enter 换行'"
        class="block max-h-[168px] w-full resize-none bg-transparent px-3 py-2.5 leading-[1.55] outline-none placeholder:text-muted"
        :class="ui.isMobile ? 'text-[15px]' : 'text-[13.5px]'"
        @input="autoGrow(); updateMention()"
        @click="updateMention"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <div class="flex items-center gap-0.5 px-1.5 pb-1.5">
        <IconButton icon="smile" label="表情" :size="17" @click="openPanel" />
        <input
          ref="fileInput"
          type="file"
          multiple
          :accept="aiMode ? 'image/*' : undefined"
          class="hidden"
          @change="onPickFiles"
        />
        <IconButton
          icon="paperclip"
          :label="aiMode ? '发送图片（AI 可识别）' : '发送图片或文件'"
          :size="17"
          @click="fileInput?.click()"
        />
        <span v-if="!ui.isMobile" class="ml-auto text-[11px] text-muted">
          {{ ui.sendKey === 'enter' ? 'Enter 发送' : 'Ctrl+Enter 发送' }}
        </span>
        <button
          type="button"
          class="flex items-center gap-1 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors"
          :class="[
            ui.isMobile ? 'ml-auto h-9 px-3 text-[13px]' : 'ml-1 py-1',
            canSend
              ? 'bg-accent text-accent-text hover:opacity-90'
              : 'cursor-not-allowed bg-surface-3 text-muted',
          ]"
          :disabled="!canSend"
          @click="submit"
        >
          <Icon name="send" :size="14" />
          发送
        </button>
      </div>

      <!-- @ 提及候选弹窗：↑↓ 选择，Enter/Tab 或左键确认，Esc 关闭 -->
      <div
        v-if="mentionOpen && mentionCandidates.length > 0"
        class="animate-rise-in absolute bottom-full left-2 mb-2 w-[248px] overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-soft)]"
      >
        <p class="border-b border-line px-3 py-1.5 text-[10.5px] text-muted">提及成员</p>
        <div ref="mentionList" class="scroll-area max-h-[220px] py-1">
          <button
            v-for="(candidate, index) in mentionCandidates"
            :key="candidate.userId ?? 'all'"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
            :class="index === mentionIndex ? 'mention-active bg-surface-2' : 'hover:bg-surface-2'"
            @mouseenter="mentionIndex = index"
            @mousedown.prevent="pickMention(candidate)"
          >
            <Avatar
              :name="candidate.name"
              :src="candidate.avatarUrl ?? null"
              :seed="candidate.seed ?? candidate.name"
              :size="22"
            />
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">{{ candidate.name }}</span>
            <span
              v-if="candidate.userId === null"
              class="rounded bg-accent-soft px-1 text-[10px] text-accent"
            >
              全体
            </span>
          </button>
        </div>
      </div>

      <!-- 表情 / 贴纸面板 -->
      <div
        v-if="emojiOpen"
        class="animate-rise-in absolute bottom-full left-2 mb-2 max-h-[50vh] w-[min(320px,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-soft)]"
      >
        <div class="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
          <button
            type="button"
            class="rounded-md px-2 py-0.5 text-[11.5px] transition-colors"
            :class="panelTab === 'emoji' ? 'bg-accent text-accent-text' : 'text-muted hover:bg-surface-2'"
            @click="panelTab = 'emoji'"
          >
            表情
          </button>
          <button
            v-for="entry in stickers.packs"
            :key="entry.pack.id"
            type="button"
            class="max-w-[72px] truncate rounded-md px-2 py-0.5 text-[11.5px] transition-colors"
            :class="
              panelTab === entry.pack.id ? 'bg-accent text-accent-text' : 'text-muted hover:bg-surface-2'
            "
            @click="panelTab = entry.pack.id"
          >
            {{ entry.pack.name }}
          </button>
          <span v-if="stickers.loading" class="ml-auto text-[10.5px] text-muted">加载中…</span>
        </div>

        <div v-if="panelTab === 'emoji'" class="grid grid-cols-8 gap-1 p-2">
          <button
            v-for="emoji in QUICK_EMOJI"
            :key="emoji"
            type="button"
            class="grid h-8 w-8 place-items-center rounded-md text-lg hover:bg-surface-2"
            @click="insertEmoji(emoji)"
          >
            {{ emoji }}
          </button>
        </div>

        <div v-else class="p-2">
          <div v-if="activePack && activePack.stickers.length > 0" class="grid grid-cols-4 gap-1.5">
            <button
              v-for="sticker in activePack.stickers"
              :key="sticker.id"
              type="button"
              class="grid aspect-square place-items-center rounded-lg p-1 hover:bg-surface-2"
              :title="sticker.keywords.join('、')"
              @click="sendSticker(sticker)"
            >
              <img
                v-if="sticker.url"
                :src="resolveFileUrl(sticker.url) ?? ''"
                alt=""
                class="max-h-[52px] max-w-[52px] object-contain"
                loading="lazy"
              />
            </button>
          </div>
          <p v-else class="py-6 text-center text-[11.5px] text-muted">
            这个分组还没有表情<br />
            去「设置 → 表情包」上传
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
