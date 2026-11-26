<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AttachmentRef, Message, Sticker } from '@nenochat/shared'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import MemberSidebar from '@/components/chat/MemberSidebar.vue'
import MessageList from '@/components/chat/MessageList.vue'
import MessageInput from '@/components/chat/MessageInput.vue'
import MessageContextMenu from '@/components/chat/MessageContextMenu.vue'
import MessageSelectionBar from '@/components/chat/MessageSelectionBar.vue'
import ForwardDialog from '@/components/chat/ForwardDialog.vue'
import ChatScreenshotSheet from '@/components/chat/ChatScreenshotSheet.vue'
import DebugInfoBar from '@/components/chat/DebugInfoBar.vue'
import MemoryPanel from '@/components/ai/MemoryPanel.vue'
import SchedulePanel from '@/components/ai/SchedulePanel.vue'
import Icon from '@/components/ui/Icon.vue'
import type { IconName } from '@/components/ui/icons'
import { useConversationTitle } from '@/composables/conversation'
import { useAuthStore } from '@/stores/auth'
import { useAiStore } from '@/stores/ai'
import { useConversationsStore } from '@/stores/conversations'
import { useDebugStore } from '@/stores/debug'
import { useMembersStore } from '@/stores/members'
import { useMessagesStore } from '@/stores/messages'
import { useTypingStore } from '@/stores/typing'
import { useUiStore } from '@/stores/ui'

/** 单次转发条数上限，与服务端 ForwardMessagesSchema 一致 */
const FORWARD_MAX = 50

const route = useRoute()
const router = useRouter()

const auth = useAuthStore()
const ai = useAiStore()
const conversations = useConversationsStore()
const members = useMembersStore()
const messages = useMessagesStore()
const debug = useDebugStore()
const typing = useTypingStore()
const ui = useUiStore()

const conversationId = computed(() => String(route.params.conversationId ?? ''))

const conversation = computed(() => conversations.byId.get(conversationId.value) ?? null)
const isGroup = computed(() => conversation.value?.type === 'group')
const isAi = computed(() => conversation.value?.type === 'ai')

const replyTo = ref<Message | null>(null)
const editing = ref<Message | null>(null)
const showMembers = ref(true)
const showMemory = ref(false)
const showSchedule = ref(false)
/** 手机端用抽屉承载成员、记忆与日程面板 */
const mobileMembersOpen = ref(false)
const mobileMemoryOpen = ref(false)
const mobileScheduleOpen = ref(false)

const membersPanelActive = computed(() =>
  ui.isMobile ? mobileMembersOpen.value : showMembers.value,
)
const memoryPanelActive = computed(() => (ui.isMobile ? mobileMemoryOpen.value : showMemory.value))
const schedulePanelActive = computed(() =>
  ui.isMobile ? mobileScheduleOpen.value : showSchedule.value,
)
const aiError = ref<string | null>(null)

const messageList = ref<{ scrollToBottom: (smooth?: boolean) => void } | null>(null)
const messageInput = ref<InstanceType<typeof MessageInput> | null>(null)
const contextMenu = ref<{ message: Message; x: number; y: number } | null>(null)
const previewUrl = ref<string | null>(null)
const toast = ref<{ text: string; icon?: IconName } | null>(null)
let toastTimer = 0

/* --------------------------- 多选 / 转发 / 截图 --------------------------- */

const selectionMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())

/** 转发对话框：待转发的消息 id 与开关 */
const forwardOpen = ref(false)
const forwardMessageIds = ref<string[]>([])
/** 截图：参与合成的消息 id 与开关 */
const screenshotOpen = ref(false)
const screenshotIds = ref<Set<string>>(new Set())

const titleOf = useConversationTitle()
const conversationTitle = computed(() =>
  conversation.value ? titleOf(conversation.value) : '聊天记录',
)

function enterSelectionMode(messageId?: string): void {
  selectionMode.value = true
  selectedIds.value = new Set(messageId ? [messageId] : [])
}

function exitSelectionMode(): void {
  selectionMode.value = false
  selectedIds.value = new Set()
}

/** 系统与撤回消息不参与多选，点选静默忽略 */
function toggleSelect(messageId: string): void {
  const message = allMessages.value.find((m) => m.id === messageId)
  if (!message || message.deletedAt || message.type === 'system') return
  const next = new Set(selectedIds.value)
  if (next.has(messageId)) next.delete(messageId)
  else next.add(messageId)
  selectedIds.value = next
}

/** 打开转发对话框；超出服务端单次上限时直接提示 */
function openForward(messageIds: string[]): void {
  if (messageIds.length === 0) return
  if (messageIds.length > FORWARD_MAX) {
    showToast(`一次最多转发 ${FORWARD_MAX} 条消息`)
    return
  }
  forwardMessageIds.value = messageIds
  forwardOpen.value = true
}

/** 参与截图的消息：按 seq 升序，过滤不可选消息 */
const screenshotSource = computed(() =>
  allMessages.value
    .filter((m) => screenshotIds.value.has(m.id) && !m.deletedAt && m.type !== 'system')
    .sort((a, b) => a.seq - b.seq),
)

function openScreenshot(messageIds: string[]): void {
  if (messageIds.length === 0) return
  screenshotIds.value = new Set(messageIds)
  screenshotOpen.value = true
}

async function performForward(targets: string[]): Promise<void> {
  await messages.forwardMessages(forwardMessageIds.value, targets)
  showToast(`已转发到 ${targets.length} 个会话`)
  exitSelectionMode()
}

function onScreenshotSaved(target: 'desktop' | 'android' | 'browser'): void {
  showToast(target === 'android' ? '已保存到相册' : target === 'desktop' ? '已保存' : '已开始下载')
}

/** 轻提示：给了 icon 就带个状态图标，时长可按反馈类型放宽（复制类留 2.5s） */
function showToast(text: string, options?: { icon?: IconName; duration?: number }): void {
  toast.value = { text, icon: options?.icon }
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = null
  }, options?.duration ?? 1800)
}

/** 预览打开期间按 Esc 直接关闭；监听随预览开关挂卸，不常驻 */
function onPreviewKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') previewUrl.value = null
}

watch(previewUrl, (url) => {
  if (url) window.addEventListener('keydown', onPreviewKeydown)
  else window.removeEventListener('keydown', onPreviewKeydown)
})

const allMessages = computed(() => messages.messagesOf(conversationId.value))
const messageBucket = computed(() => messages.buckets[conversationId.value])
const hasMoreOlder = computed(() => messageBucket.value?.hasMoreOlder ?? false)
const messagesLoading = computed(() => messageBucket.value?.loading ?? false)
const highlightId = computed(() => (typeof route.query.m === 'string' ? route.query.m : null))

const memberGroups = computed(() => members.groupedOf(conversationId.value))

/** 调试模式开着时预取本会话的用量汇总与群聊决策记录 */
const debugMode = computed(() => ai.globalSettings?.debugMode ?? false)

watch(
  () => [conversationId.value, debugMode.value, isGroup.value] as const,
  ([id, on, group]) => {
    if (!id || !on) return
    void debug.loadSummary(id)
    if (group) void debug.loadDecisions(id)
  },
  { immediate: true },
)

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
  // 成员索引是 O(1) 查表：输入中的每个人都要查一次，不能用数组 find 扫
  const index = members.memberIndex(conversationId.value)
  return ids
    .map((id) => {
      const member = index.get(id)
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
    await members.load(id, true)
  } else if (conversation.value?.type === 'direct') {
    await members.load(id)
  }

  if (isAi.value) {
    if (ai.providers.length === 0) {
      await ai.load().catch(() => undefined)
    }
    // 打开会话就把当天日程准备好，第一次回复才能贴合角色此刻的状态
    const persona = ai.personaOf(id)
    if (persona) void ai.ensureSchedule(persona.id).catch(() => undefined)
  }

  // 一个会话一条消息流：已预载时直接用内存数据，新消息由 WS 同步
  await messages.loadInitial(id)

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

/** 记住当前会话：整页卸载时 watch 不会再触发，靠它补清 typing 状态 */
let activeConversationId = ''

watch(
  conversationId,
  async (next, prev) => {
    // 离开旧会话时把输入状态与兜底定时器一并清掉
    if (prev && prev !== next) typing.clear(prev)
    activeConversationId = next
    replyTo.value = null
    editing.value = null
    exitSelectionMode()
    await loadConversation()
  },
  { immediate: true },
)

/** 手机端没有常驻侧栏，头部按钮改为开关抽屉 */
function toggleMembers(): void {
  if (ui.isMobile) {
    mobileMembersOpen.value = !mobileMembersOpen.value
    return
  }
  showMembers.value = !showMembers.value
}

function toggleMemory(): void {
  if (ui.isMobile) {
    const next = !mobileMemoryOpen.value
    mobileMemoryOpen.value = next
    if (next) mobileScheduleOpen.value = false
    return
  }
  const next = !showMemory.value
  showMemory.value = next
  if (next) showSchedule.value = false
}

/** 日程与记忆共用右侧信息栏，同时只开一个 */
function toggleSchedule(): void {
  if (ui.isMobile) {
    const next = !mobileScheduleOpen.value
    mobileScheduleOpen.value = next
    if (next) mobileMemoryOpen.value = false
    return
  }
  const next = !showSchedule.value
  showSchedule.value = next
  if (next) showMemory.value = false
}

/** AI 一轮生成可能跑十几秒，期间的重复提交直接丢掉，避免同一条被发两次 */
const turnBusy = ref(false)

async function handleSend(
  content: string,
  mentions?: { userIds: string[]; mentionAll: boolean },
  attachments?: AttachmentRef[],
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
      await ai.sendTurn(id, content, target, attachments ?? [])
    } catch (e) {
      aiError.value = e instanceof Error ? e.message : 'AI 生成失败'
    } finally {
      turnBusy.value = false
    }
    return
  }

  typing.stopTyping(id)
  await messages.send({
    conversationId: id,
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
  await messages.send({
    conversationId: id,
    content: '',
    type: payload.type,
    meta: { attachments: [payload.attachment] },
    replyToId: replyTo.value?.id ?? null,
  })
  replyTo.value = null
  void nextTick(() => messageList.value?.scrollToBottom(true))
}

/** 语音消息：AI 会话里先发语音再触发一轮生成（ASR 接入后服务端会转写） */
async function handleVoice(attachment: AttachmentRef): Promise<void> {
  const id = conversationId.value
  if (isAi.value) {
    if (turnBusy.value) return
    const target = replyTo.value
    replyTo.value = null
    turnBusy.value = true
    try {
      await ai.sendVoiceTurn(id, attachment, target)
    } catch (e) {
      aiError.value = e instanceof Error ? e.message : 'AI 生成失败'
    } finally {
      turnBusy.value = false
    }
    void nextTick(() => messageList.value?.scrollToBottom(true))
    return
  }
  await messages.send({
    conversationId: id,
    content: '',
    type: 'voice',
    meta: { attachments: [attachment] },
    replyToId: replyTo.value?.id ?? null,
  })
  replyTo.value = null
  void nextTick(() => messageList.value?.scrollToBottom(true))
}

async function handleSticker(sticker: Sticker): Promise<void> {
  if (!sticker.url) return
  const id = conversationId.value
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
  await messages.loadOlder(conversationId.value)
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

function goBack(): void {
  // replace 掉会话记录，安卓返回键不会又退回同一个会话
  void router.replace('/')
}

function mentionFromMobile(userId: string, name: string): void {
  mobileMembersOpen.value = false
  messageInput.value?.insertMention(userId, name)
}

/* --------------------------- 拖拽上传附件 --------------------------- */

/** enter/leave 在子元素间移动时会成对触发，用计数抵消，>0 即悬停在聊天区内 */
const dragDepth = ref(0)
const draggingFile = computed(() => dragDepth.value > 0)

/** 只接管文件拖拽，页面内拖文本仍走 textarea 原生插入 */
function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  dragDepth.value += 1
}

function onDragOver(event: DragEvent): void {
  if (!dragHasFiles(event)) return
  // dragover 不 preventDefault 浏览器就不允许 drop
  event.preventDefault()
}

function onDragLeave(): void {
  if (dragDepth.value > 0) dragDepth.value -= 1
}

function onDrop(event: DragEvent): void {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  dragDepth.value = 0
  const files = Array.from(event.dataTransfer?.files ?? [])
  // 复用 MessageInput 的上传管线，AI 会话「仅图片」校验也一并生效
  if (files.length > 0) messageInput.value?.handleFiles(files)
}

/** 文件拖到聊天列之外（成员侧栏等）也不能让 WebView 直接把文件打开 */
function preventFileNavigation(event: DragEvent): void {
  if (dragHasFiles(event)) event.preventDefault()
}

window.addEventListener('dragover', preventFileNavigation)
window.addEventListener('drop', preventFileNavigation)

onBeforeUnmount(() => {
  // 预览开着直接关页时 watch 来不及摘监听，这里兜底
  window.removeEventListener('keydown', onPreviewKeydown)
  window.removeEventListener('dragover', preventFileNavigation)
  window.removeEventListener('drop', preventFileNavigation)
  window.clearTimeout(toastTimer)
  // 直接退出会话页时 watch 不会再触发，补清最后一个会话的 typing 状态
  if (activeConversationId) typing.clear(activeConversationId)
})
</script>

<template>
  <div class="flex h-full min-h-0">
    <div
      class="relative flex min-w-0 flex-1 flex-col"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <template v-if="conversation">
        <MessageSelectionBar
          v-if="selectionMode"
          :count="selectedIds.size"
          @cancel="exitSelectionMode"
          @forward="openForward([...selectedIds])"
          @screenshot="openScreenshot([...selectedIds])"
        />
        <ChatHeader
          v-else
          :conversation="conversation"
          :typing-names="typingNames"
          :member-count="members.of(conversationId).length"
          :show-members="isAi ? memoryPanelActive : membersPanelActive"
          :schedule-active="schedulePanelActive"
          :backable="ui.isMobile"
          @toggle-members="toggleMembers"
          @open-memory="toggleMemory"
          @toggle-schedule="toggleSchedule"
          @open-settings="router.push(`/settings/conversation/${conversationId}`)"
          @back="goBack"
        />

        <MessageList
          ref="messageList"
          :messages="allMessages"
          :conversation-id="conversationId"
          :loading="messagesLoading"
          :has-more-older="hasMoreOlder"
          :highlight-id="highlightId"
          :streaming="aiStreamRow"
          :select-mode="selectionMode"
          :selected-ids="selectedIds"
          @load-older="loadOlder"
          @load-around="handleLoadAround"
          @visible-last="handleVisibleLast"
          @reply="handleReply"
          @recall="handleRecall"
          @edit="handleEdit"
          @pin="handlePin"
          @context="handleContext"
          @preview="(url) => (previewUrl = url)"
          @toggle-select="toggleSelect"
        />

        <p v-if="aiError" class="border-t border-line bg-danger/10 px-4 py-2 text-[12px] text-danger">
          {{ aiError }}
        </p>

        <MessageInput
          ref="messageInput"
          :conversation-id="conversationId"
          :reply-to="replyTo"
          :editing="editing"
          :placeholder="
            isAi
              ? ui.isMobile
                ? '和 AI 说点什么'
                : '和 AI 说点什么，长回复会自动分条'
              : '输入消息'
          "
          :ai-mode="isAi"
          :mention-all-enabled="isGroup"
          @send="handleSend"
          @typing="typing.notifyTyping(conversationId)"
          @attachment="handleAttachment"
          @voice="handleVoice"
          @sticker="handleSticker"
          @cancel-reply="replyTo = null"
          @cancel-edit="editing = null"
        />

        <DebugInfoBar v-if="debugMode" :conversation-id="conversationId" />

        <!-- 拖拽文件悬停：全区提示，松手即上传 -->
        <Transition name="drag-veil">
          <div
            v-if="draggingFile"
            class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-surface/85"
          >
            <div class="flex flex-col items-center gap-1.5 rounded-2xl bg-accent-soft px-10 py-8">
              <Icon name="paperclip" :size="26" class="text-accent" />
              <p class="text-[14px] font-medium text-accent">
                {{ isAi ? '松开发送图片' : '松开发送文件' }}
              </p>
              <p class="text-[11.5px] text-muted">
                {{ isAi ? 'AI 会话暂只支持图片' : '支持图片与文件，一次最多 9 个' }}
              </p>
            </div>
          </div>
        </Transition>
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

    <SchedulePanel
      v-if="isAi && showSchedule && !ui.isMobile"
      :conversation-id="conversationId"
      @close="showSchedule = false"
    />

    <!-- 手机端抽屉：成员 / 记忆，替代常驻侧栏 -->
    <Teleport to="body">
      <div
        v-if="ui.isMobile && mobileMembersOpen"
        class="animate-fade-in fixed inset-0 z-40 flex justify-end bg-[var(--scrim)]"
        @click.self="mobileMembersOpen = false"
      >
        <MemberSidebar
          mobile
          class="animate-sheet-side h-full w-[82vw] max-w-[320px] shadow-xl"
          :groups="memberGroups"
          @open-profile="() => {}"
          @mention="mentionFromMobile"
          @close="mobileMembersOpen = false"
        />
      </div>

      <div
        v-if="ui.isMobile && isAi && mobileMemoryOpen"
        class="animate-fade-in fixed inset-0 z-40 flex justify-end bg-[var(--scrim)]"
        @click.self="mobileMemoryOpen = false"
      >
        <MemoryPanel
          mobile
          class="animate-sheet-side h-full w-[88vw] max-w-[360px] shadow-xl"
          :conversation-id="conversationId"
          @close="mobileMemoryOpen = false"
        />
      </div>

      <div
        v-if="ui.isMobile && isAi && mobileScheduleOpen"
        class="animate-fade-in fixed inset-0 z-40 flex justify-end bg-[var(--scrim)]"
        @click.self="mobileScheduleOpen = false"
      >
        <SchedulePanel
          mobile
          class="animate-sheet-side h-full w-[88vw] max-w-[360px] shadow-xl"
          :conversation-id="conversationId"
          @close="mobileScheduleOpen = false"
        />
      </div>
    </Teleport>

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
      @copied="showToast('已复制', { icon: 'check', duration: 2500 })"
      @forward="openForward([contextMenu!.message.id])"
      @select="enterSelectionMode(contextMenu!.message.id)"
      @screenshot="openScreenshot([contextMenu!.message.id])"
    />

    <ForwardDialog v-model:open="forwardOpen" :message-count="forwardMessageIds.length" :perform="performForward" />

    <ChatScreenshotSheet
      v-model:open="screenshotOpen"
      :conversation-name="conversationTitle"
      :messages="screenshotSource"
      :all-messages="allMessages"
      @saved="onScreenshotSaved"
    />

    <!-- 图片预览 -->
    <Teleport to="body">
      <div
        v-if="previewUrl"
        class="animate-fade-in fixed inset-0 z-40 grid place-items-center bg-[#0b0b0a]/70 p-6"
        @click="previewUrl = null"
      >
        <img :src="previewUrl" alt="图片预览" class="max-h-[88vh] max-w-[92vw] rounded-lg object-contain" />
        <button
          type="button"
          class="absolute top-4 right-4 rounded-full bg-white/15 p-2 text-white hover:bg-white/25"
          aria-label="关闭预览"
          @click="previewUrl = null"
        >
          <Icon name="close" :size="18" />
        </button>
      </div>
    </Teleport>

    <Transition name="fade">
      <div
        v-if="toast"
        class="fixed left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-[var(--toast-bg)] px-3 py-1.5 text-[12px] text-[var(--toast-text)]"
        :class="ui.isMobile ? 'bottom-[calc(5.5rem+var(--safe-bottom))]' : 'bottom-24'"
      >
        <Icon v-if="toast.icon" :name="toast.icon" :size="12" class="text-[var(--toast-text)]" />
        {{ toast.text }}
      </div>
    </Transition>
  </div>
</template>
