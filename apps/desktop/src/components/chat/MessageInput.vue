<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import type { AttachmentRef, Message, Sticker } from '@nenochat/shared'
import { uploadFile } from '@/api/files'
import { resolveFileUrl } from '@/api/http'
import { useStickersStore } from '@/stores/stickers'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{
  conversationId: string
  channelId?: string | null
  replyTo?: Message | null
  editing?: Message | null
  disabled?: boolean
  placeholder?: string
  /** AI 会话里上传附件意义不大，隐藏附件按钮 */
  aiMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'send', content: string): void
  (e: 'typing'): void
  (e: 'cancel-reply'): void
  (e: 'cancel-edit'): void
  (e: 'attachment', payload: { attachment: AttachmentRef; type: 'image' | 'file' }): void
  (e: 'sticker', sticker: Sticker): void
}>()

const ui = useUiStore()
const stickers = useStickersStore()

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

const canSend = computed(() => text.value.trim().length > 0 && !props.disabled)

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

function submit(): void {
  if (!canSend.value) return
  const now = Date.now()
  if (now - lastSubmitAt < 300) return
  lastSubmitAt = now
  emit('send', text.value.trim())
  text.value = ''
  void nextTick(autoGrow)
}

function onKeydown(event: KeyboardEvent): void {
  // 中文输入法组词中的 Enter 是「选词」，不能当成发送
  if (event.isComposing || event.keyCode === 229) return

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

async function handleFiles(files: File[]): Promise<void> {
  if (files.length === 0) return
  uploadError.value = null

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

watch(text, () => {
  if (text.value.length > 0) emit('typing')
})

onMounted(() => {
  void stickers.load()
})
</script>

<template>
  <div class="border-t border-line bg-surface px-3 pt-2 pb-3">
    <!-- 引用 / 编辑提示条 -->
    <div
      v-if="replyTo || editing"
      class="mb-1.5 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px]"
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

    <div class="relative rounded-xl border border-line bg-surface-2 focus-within:border-accent">
      <textarea
        ref="textarea"
        v-model="text"
        rows="1"
        :disabled="disabled"
        :placeholder="placeholder ?? '输入消息，Enter 发送，Shift+Enter 换行'"
        class="block max-h-[168px] w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] leading-[1.55] outline-none placeholder:text-muted"
        @input="autoGrow"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <div class="flex items-center gap-0.5 px-1.5 pb-1.5">
        <IconButton icon="smile" label="表情" :size="17" @click="openPanel" />
        <input
          v-if="!aiMode"
          ref="fileInput"
          type="file"
          multiple
          class="hidden"
          @change="onPickFiles"
        />
        <IconButton
          v-if="!aiMode"
          icon="paperclip"
          label="发送图片或文件"
          :size="17"
          @click="fileInput?.click()"
        />
        <span class="ml-auto text-[11px] text-muted">
          {{ ui.sendKey === 'enter' ? 'Enter 发送' : 'Ctrl+Enter 发送' }}
        </span>
        <button
          type="button"
          class="ml-1 flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12.5px] font-medium transition-colors"
          :class="
            canSend
              ? 'bg-accent text-accent-text hover:opacity-90'
              : 'cursor-not-allowed bg-surface-3 text-muted'
          "
          :disabled="!canSend"
          @click="submit"
        >
          <Icon name="send" :size="14" />
          发送
        </button>
      </div>

      <!-- 表情 / 贴纸面板 -->
      <div
        v-if="emojiOpen"
        class="absolute bottom-full left-2 mb-2 w-[320px] rounded-xl border border-line bg-surface shadow-[var(--shadow-soft)]"
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
