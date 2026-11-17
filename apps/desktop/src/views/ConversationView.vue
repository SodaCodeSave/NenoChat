<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AttachmentRef, Message, Sticker } from '@nenochat/shared'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import ChannelSidebar from '@/components/chat/ChannelSidebar.vue'
import MemberSidebar from '@/components/chat/MemberSidebar.vue'
import MessageList from '@/components/chat/MessageList.vue'
import MessageInput from '@/components/chat/MessageInput.vue'
import MessageContextMenu from '@/components/chat/MessageContextMenu.vue'
import MemoryPanel from '@/components/ai/MemoryPanel.vue'
import Icon from '@/components/ui/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { useAiStore } from '@/stores/ai'
import { useChannelsStore } from '@/stores/channels'
import { useConversationsStore } from '@/stores/conversations'
import { useMembersStore } from '@/stores/members'
import { useMessagesStore } from '@/stores/messages'
import { useTypingStore } from '@/stores/typing'
import { useUiStore } from '@/stores/ui'

const route = useRoute()
const router = useRouter()

const auth = useAuthStore()
const ai = useAiStore()
const conversations = useConversationsStore()
const channels = useChannelsStore()
const members = useMembersStore()
const messages = useMessagesStore()
const typing = useTypingStore()
const ui = useUiStore()

const conversationId = computed(() => String(route.params.conversationId ?? ''))
const channelIdParam = computed(() => (route.params.channelId ? String(route.params.channelId) : null))

const conversation = computed(() => conversations.byId.get(conversationId.value) ?? null)
const isGroup = computed(() => conversation.value?.type === 'group')
const isAi = computed(() => conversation.value?.type === 'ai')

const channelGroups = computed(() => channels.groupedOf(conversationId.value))
const activeChannel = computed(() => {
  const list = channels.of(conversationId.value)
  if (channelIdParam.value) {
    const found = list.find((c) => c.id === channelIdParam.value)
    if (found) return found
  }
  return list.find((c) => c.kind === 'text') ?? list[0] ?? null
})

const replyTo = ref<Message | null>(null)
const editing = ref<Message | null>(null)
const showMembers = ref(true)
const showMemory = ref(false)
const aiError = ref<string | null>(null)

const messageList = ref<{ scrollToBottom: (smooth?: boolean) => void } | null>(null)
const messageInput = ref<InstanceType<typeof MessageInput> | null>(null)
const contextMenu = ref<{ message: Message; x: number; y: number } | null>(null)
const previewUrl = ref<string | null>(null)
const toast = ref<string | null>(null)
let toastTimer = 0

function showToast(text: string): void {
  toast.value = text
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = null
  }, 1800)
}

const allMessages = computed(() => messages.messagesOf(conversationId.value))
const messageBucket = computed(() => messages.buckets[conversationId.value])
const hasMoreOlder = computed(() => messageBucket.value?.hasMoreOlder ?? false)
const messagesLoading = computed(() => messageBucket.value?.loading ?? false)
const highlightId = computed(() => (typeof route.query.m === 'string' ? route.query.m : null))

/** 群聊按频道过滤；私聊与 AI 会话只有一条消息流 */
const visibleMessages = computed(() => {
  if (!isGroup.value) return allMessages.value
  const channelId = activeChannel.value?.id
  if (!channelId) return []
  return allMessages.value.filter((m) => m.channelId === channelId)
})

const memberGroups = computed(() => members.groupedOf(conversationId.value))

/** AI 生成中的占位行状态：思考阶段灰字，流式出字后跟着长 */
const aiStreamRow = computed(() => {
  if (!isAi.value) return null
  const stream = ai.streaming[conversationId.value]
  const text = stream?.text ?? ''
  const generating = ai.isGenerating(conversationId.value)
  if (!generating && !text) return null
  return { generationId: stream?.generationId ?? '', text, pending: !text }
})

const typingNames = computed(() => {
  const ids = typing.activeIn(conversationId.value).filter((id) => id !== auth.user?.id)
  return ids
    .map((id) => {
      const member = members.of(conversationId.value).find((m) => m.userId === id)
      return member ? members.displayName(member) : null
    })
    .filter((name): name is string => Boolean(name))
})

async function ensureConversation(): Promise<void> {
  if (!conversation.value) {
    await conversations.refresh()
    if (!conversations.byId.get(conversationId.value)) {
      await router.replace('/')
    }
  }
}

async function loadConversation(): Promise<void> {
  const id = conversationId.value
  if (!id) return

  conversations.setActive(id)
  await ensureConversation()

  if (isGroup.value) {
    await Promise.all([channels.load(id, true), members.load(id, true)])
    // 默认落到第一个文本频道
    if (!channelIdParam.value && activeChannel.value) {
      await router.replace(`/c/${id}/${activeChannel.value.id}`)
      return
    }
  } else if (conversation.value?.type === 'direct') {
    await members.load(id)
  }

  if (isAi.value) {
    if (ai.providers.length === 0) {
      await ai.load().catch(() => undefined)
    }
  }

  await messages.loadInitial(id, {
    channelId: isGroup.value ? activeChannel.value?.id ?? null : null,
    force: true,
  })

  // 从搜索结果跳进来：目标消息不在最近一页时，把它所在的上下文补进来
  const focusId = highlightId.value
  if (focusId && !messages.messagesOf(id).some((message) => message.id === focusId)) {
    await messages.loadAround(id, focusId).catch(() => undefined)
  }

  // 打开会话即把已读推进到最新一条，不必等用户滚动
  const list = messages.messagesOf(id)
  const last = list[list.length - 1]
  if (last) await conversations.markRead(id, last.seq)
}

watch(
  conversationId,
  async () => {
    replyTo.value = null
    editing.value = null
    await loadConversation()
  },
  { immediate: true },
)

watch(activeChannel, async (channel) => {
  if (!isGroup.value || !channel) return
  await messages.loadInitial(conversationId.value, { channelId: channel.id, force: true })
})

function selectChannel(channelId: string): void {
  void router.push(`/c/${conversationId.value}/${channelId}`)
}

/** AI 一轮生成可能跑十几秒，期间的重复提交直接丢掉，避免同一条被发两次 */
const turnBusy = ref(false)

async function handleSend(
  content: string,
  mentions?: { userIds: string[]; mentionAll: boolean },
): Promise<void> {
  const id = conversationId.value
  if (editing.value) {
    const target = editing.value
    editing.value = null
    await messages.edit(target.id, content)
    return
  }

  if (isAi.value) {
    if (turnBusy.value) return
    const target = replyTo.value
    replyTo.value = null
    turnBusy.value = true
    try {
      await ai.sendTurn(id, content, target)
    } catch (e) {
      aiError.value = e instanceof Error ? e.message : 'AI 生成失败'
    } finally {
      turnBusy.value = false
    }
    return
  }

  const channelId = isGroup.value ? activeChannel.value?.id ?? null : null
  typing.stopTyping(id)
  await messages.send({
    conversationId: id,
    channelId,
    content,
    meta:
      mentions && (mentions.mentionAll || mentions.userIds.length > 0)
        ? { mentions: mentions.userIds, mentionAll: mentions.mentionAll }
        : undefined,
    replyToId: replyTo.value?.id ?? null,
  })
  replyTo.value = null
  void nextTick(() => messageList.value?.scrollToBottom(true))
}

async function handleAttachment(payload: {
  attachment: AttachmentRef
  type: 'image' | 'file'
}): Promise<void> {
  const id = conversationId.value
  const channelId = isGroup.value ? activeChannel.value?.id ?? null : null
  await messages.send({
    conversationId: id,
    channelId,
    content: '',
    type: payload.type,
    meta: { attachments: [payload.attachment] },
    replyToId: replyTo.value?.id ?? null,
  })
  replyTo.value = null
  void nextTick(() => messageList.value?.scrollToBottom(true))
}

async function handleSticker(sticker: Sticker): Promise<void> {
  if (!sticker.url) return
  const id = conversationId.value
  const channelId = isGroup.value ? activeChannel.value?.id ?? null : null
  const attachment: AttachmentRef = {
    id: sticker.attachmentId ?? sticker.id,
    kind: 'sticker',
    filename: `${sticker.id}.${sticker.kind === 'gif' ? 'gif' : 'png'}`,
    mime: sticker.kind === 'gif' ? 'image/gif' : 'image/png',
    size: 0,
    url: sticker.url,
  }
  await messages.send({
    conversationId: id,
    channelId,
    content: '',
    type: 'sticker',
    meta: { stickerId: sticker.id, attachments: [attachment] },
    replyToId: replyTo.value?.id ?? null,
  })
  replyTo.value = null
  void nextTick(() => messageList.value?.scrollToBottom(true))
}

function handleContext(payload: { id: string; x: number; y: number }): void {
  const target = allMessages.value.find((m) => m.id === payload.id)
  if (!target) return
  contextMenu.value = { message: target, x: payload.x, y: payload.y }
}

async function loadOlder(): Promise<void> {
  await messages.loadOlder(
    conversationId.value,
    isGroup.value ? activeChannel.value?.id ?? null : null,
  )
}

/** 引用块指向较早的消息：把那段上下文补进内存，列表会自行滚动并高亮 */
async function handleLoadAround(messageId: string): Promise<void> {
  await messages.loadAround(conversationId.value, messageId).catch(() => undefined)
}

async function handleVisibleLast(seq: number): Promise<void> {
  if (!seq) return
  await conversations.markRead(conversationId.value, seq)
}

function handleReply(messageId: string): void {
  replyTo.value = allMessages.value.find((m) => m.id === messageId) ?? null
  editing.value = null
}

function handleEdit(messageId: string): void {
  editing.value = allMessages.value.find((m) => m.id === messageId) ?? null
  replyTo.value = null
}

async function handleRecall(messageId: string): Promise<void> {
  await messages.recall(messageId)
}

async function handlePin(messageId: string): Promise<void> {
  const target = allMessages.value.find((m) => m.id === messageId)
  await messages.pin(messageId, !target?.pinnedAt)
}

async function createChannel(): Promise<void> {
  const name = window.prompt('新频道名称')
  if (!name?.trim()) return
  const channel = await channels.create(conversationId.value, { name: name.trim() })
  selectChannel(channel.id)
}

function goBack(): void {
  void router.push('/')
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <ChannelSidebar
      v-if="conversation && isGroup && !ui.isMobile"
      :conversation="conversation"
      :groups="channelGroups"
      :active-channel-id="activeChannel?.id ?? null"
      :member-count="members.of(conversationId).length"
      @select="selectChannel"
      @open-settings="router.push(`/settings/conversation/${conversationId}`)"
      @create-channel="createChannel"
    />

    <div class="flex min-w-0 flex-1 flex-col">
      <template v-if="conversation">
        <ChatHeader
          :conversation="conversation"
          :channel="activeChannel"
          :typing-names="typingNames"
          :member-count="members.of(conversationId).length"
          :show-members="isAi ? showMemory : showMembers"
          :backable="ui.isMobile"
          @toggle-members="showMembers = !showMembers"
          @open-memory="showMemory = !showMemory"
          @open-settings="router.push(`/settings/conversation/${conversationId}`)"
          @back="goBack"
        />

        <MessageList
          ref="messageList"
          :messages="visibleMessages"
          :conversation-id="conversationId"
          :loading="messagesLoading"
          :has-more-older="hasMoreOlder"
          :highlight-id="highlightId"
          :streaming="aiStreamRow"
          @load-older="loadOlder"
          @load-around="handleLoadAround"
          @visible-last="handleVisibleLast"
          @reply="handleReply"
          @recall="handleRecall"
          @edit="handleEdit"
          @pin="handlePin"
          @context="handleContext"
          @preview="(url) => (previewUrl = url)"
        />

        <p v-if="aiError" class="border-t border-line bg-danger/10 px-4 py-2 text-[12px] text-danger">
          {{ aiError }}
        </p>

        <MessageInput
          ref="messageInput"
          :conversation-id="conversationId"
          :channel-id="isGroup ? activeChannel?.id ?? null : null"
          :reply-to="replyTo"
          :editing="editing"
          :placeholder="
            isGroup
              ? `发送到 #${activeChannel?.name ?? '频道'}`
              : isAi
                ? '和 AI 说点什么，长回复会自动分条'
                : '输入消息'
          "
          :ai-mode="isAi"
          :mention-all-enabled="isGroup"
          @send="handleSend"
          @typing="typing.notifyTyping(conversationId)"
          @attachment="handleAttachment"
          @sticker="handleSticker"
          @cancel-reply="replyTo = null"
          @cancel-edit="editing = null"
        />
      </template>

      <div v-else class="grid flex-1 place-items-center">
        <p class="text-[13px] text-muted">正在打开会话…</p>
      </div>
    </div>

    <MemberSidebar
      v-if="conversation && isGroup && showMembers && !ui.isMobile"
      :groups="memberGroups"
      @open-profile="() => {}"
      @mention="(userId: string, name: string) => messageInput?.insertMention(userId, name)"
    />

    <MemoryPanel
      v-if="isAi && showMemory && !ui.isMobile"
      :conversation-id="conversationId"
      @close="showMemory = false"
    />

    <MessageContextMenu
      v-if="contextMenu"
      :message="contextMenu.message"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :is-own="contextMenu.message.senderId === auth.user?.id"
      :can-pin="!contextMenu.message.deletedAt"
      @close="contextMenu = null"
      @reply="handleReply(contextMenu!.message.id)"
      @edit="handleEdit(contextMenu!.message.id)"
      @pin="handlePin(contextMenu!.message.id)"
      @recall="handleRecall(contextMenu!.message.id)"
      @copied="showToast('已复制')"
    />

    <!-- 图片预览 -->
    <Teleport to="body">
      <div
        v-if="previewUrl"
        class="fixed inset-0 z-40 grid place-items-center bg-black/70 p-6"
        @click="previewUrl = null"
      >
        <img :src="previewUrl" alt="图片预览" class="max-h-[88vh] max-w-[92vw] rounded-lg object-contain" />
        <button
          type="button"
          class="absolute top-4 right-4 rounded-full bg-white/15 p-2 text-white hover:bg-white/25"
          @click="previewUrl = null"
        >
          <Icon name="close" :size="18" />
        </button>
      </div>
    </Teleport>

    <Transition name="fade">
      <div
        v-if="toast"
        class="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-black/75 px-3 py-1.5 text-[12px] text-white"
      >
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>
