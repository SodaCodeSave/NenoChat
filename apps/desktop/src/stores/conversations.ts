import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ConversationSummary } from '@/api/endpoints'
import { conversationApi, messageApi } from '@/api/endpoints'
import {
  applyConversationSummaries,
  deleteConversation,
  listConversations,
  listLastMessageSummaries,
  patchConversationUnread,
  upsertConversation,
} from '@/db/dao/conversations'
import { lastMessageSummaryOf, type Message } from '@nenochat/shared'
import { hasLocalDb } from '@/platform/db'
import { useServersStore } from './servers'

/** 字段级相等比较；原始值字段逐键 Object.is，最后一条消息摘要按内容比较 */
function sameSummary(a: ConversationSummary, b: ConversationSummary): boolean {
  for (const key of Object.keys(a) as Array<keyof ConversationSummary>) {
    if (key === 'lastMessageSummary') {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false
      continue
    }
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

/** 刷新结果与内存列表一致时跳过镜像重写：同长度、同 id、逐条字段相等 */
function sameSummaryList(next: ConversationSummary[], current: ConversationSummary[]): boolean {
  if (next.length !== current.length) return false
  const byId = new Map(current.map((item) => [item.id, item]))
  return next.every((item) => {
    const existing = byId.get(item.id)
    return existing ? sameSummary(item, existing) : false
  })
}

/** 会话列表：置顶（含 AI 会话）→ 群聊 → 私聊，未读数与 @ 数由服务端聚合 */
export const useConversationsStore = defineStore('conversations', () => {
  const items = ref<ConversationSummary[]>([])
  const activeId = ref<string | null>(null)
  const loading = ref(false)

  const serverId = computed(() => useServersStore().currentId ?? '')
  const byId = computed(() => new Map(items.value.map((c) => [c.id, c])))
  const active = computed(() => (activeId.value ? (byId.value.get(activeId.value) ?? null) : null))
  const totalUnread = computed(() => items.value.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0))
  const totalMentions = computed(() => items.value.reduce((sum, c) => sum + (c.mentionCount ?? 0), 0))

  /** 排序权重：置顶优先，AI 会话默认靠前，其余按最近活跃 */
  const ordered = computed(() => {
    return [...items.value]
      .filter((c) => !c.deletedAt)
      .sort((a, b) => {
        const aPinned = a.pinnedAt ?? 0
        const bPinned = b.pinnedAt ?? 0
        if (aPinned !== bPinned) return bPinned - aPinned
        return (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt)
      })
  })

  const groups = computed(() => ordered.value.filter((c) => c.type === 'group'))
  const directs = computed(() => ordered.value.filter((c) => c.type === 'direct'))
  const aiConversations = computed(() => ordered.value.filter((c) => c.type === 'ai'))

  async function hydrate(): Promise<void> {
    if (!hasLocalDb() || !serverId.value) return
    items.value = await listConversations(serverId.value)
    // 本地镜像推导侧边栏预览，冷启动/断网也能直接看到最后一条消息
    const summaries = await listLastMessageSummaries(serverId.value)
    for (const item of items.value) {
      const summary = summaries.get(item.id)
      if (summary) item.lastMessageSummary = summary
    }
  }

  async function refresh(): Promise<void> {
    if (!serverId.value) return
    loading.value = true
    try {
      const result = await conversationApi.list()
      // 列表与内存一致时直接跳过，refresh 在启动/每次进直聊都会跑，没必要反复重写本地库
      if (sameSummaryList(result.conversations, items.value)) return
      items.value = result.conversations
      if (hasLocalDb()) {
        // 整份列表合并成少量多行 upsert，一次往返写完
        await applyConversationSummaries(serverId.value, result.conversations)
      }
    } finally {
      loading.value = false
    }
  }

  /** 仅内存 upsert（sync 批量落库后统一刷新内存用，不再逐条写镜像） */
  function upsertLocal(conversation: ConversationSummary): void {
    const index = items.value.findIndex((c) => c.id === conversation.id)
    if (index >= 0) {
      items.value[index] = { ...items.value[index], ...conversation }
    } else {
      items.value = [...items.value, conversation]
    }
  }

  async function upsert(conversation: ConversationSummary): Promise<void> {
    upsertLocal(conversation)
    if (hasLocalDb() && serverId.value) {
      await upsertConversation(serverId.value, conversation)
    }
  }

  function setActive(id: string | null): void {
    activeId.value = id
  }

  /** 会话被删除（例如角色被删）时从列表剔除；本地行由 DAO 打 deleted_at 保留可追溯 */
  function remove(id: string): void {
    items.value = items.value.filter((c) => c.id !== id)
    if (activeId.value === id) activeId.value = null
  }

  /** 从本地镜像彻底移除会话 */
  async function removeForever(id: string): Promise<void> {
    remove(id)
    if (hasLocalDb() && serverId.value) {
      await deleteConversation(serverId.value, id)
    }
  }

  /** 清空未读并同步服务端游标 */
  async function markRead(conversationId: string, seq: number): Promise<void> {
    const target = byId.value.get(conversationId)
    if (!target) return
    if ((target.myLastReadSeq ?? 0) >= seq && (target.unreadCount ?? 0) === 0) return

    target.myLastReadSeq = seq
    target.unreadCount = 0
    target.mentionCount = 0
    if (hasLocalDb() && serverId.value) {
      await patchConversationUnread(serverId.value, conversationId, {
        unreadCount: 0,
        mentionCount: 0,
        myLastReadSeq: seq,
      })
    }

    try {
      await messageApi.markRead(conversationId, seq)
    } catch {
      /* 断网时先本地清零，重连后由游标同步补齐 */
    }
  }

  /** 收到别人发的新消息时本地递增未读，避免为每个事件刷新整个列表 */
  function bumpUnread(conversationId: string, mentioned: boolean): void {
    const target = byId.value.get(conversationId)
    if (!target) return
    if (activeId.value === conversationId) return
    target.unreadCount = (target.unreadCount ?? 0) + 1
    if (mentioned) target.mentionCount = (target.mentionCount ?? 0) + 1
  }

  /** 新消息到达时同步列表摘要，侧边栏预览不依赖消息桶是否加载 */
  function noteLastMessage(message: Message): void {
    const target = byId.value.get(message.conversationId)
    if (!target) return
    target.lastMessageAt = message.createdAt
    target.lastMessageId = message.id
    target.lastMessageSummary = lastMessageSummaryOf(message)
  }

  /** 消息被编辑/撤回时只影响列表摘要，若它已不是最后一条则不动 */
  function noteUpdatedMessage(message: Message): void {
    const target = byId.value.get(message.conversationId)
    if (!target || target.lastMessageId !== message.id) return
    target.lastMessageSummary = lastMessageSummaryOf(message)
  }

  async function pin(conversationId: string, pinned: boolean): Promise<void> {
    const result = await conversationApi.pin(conversationId, pinned)
    const target = byId.value.get(conversationId)
    if (target) target.pinnedAt = result.member.pinnedAt ?? null
    if (hasLocalDb() && serverId.value) {
      await patchConversationUnread(serverId.value, conversationId, {
        pinnedAt: result.member.pinnedAt ?? null,
      })
    }
  }

  function reset(): void {
    items.value = []
    activeId.value = null
  }

  return {
    items,
    ordered,
    groups,
    directs,
    aiConversations,
    activeId,
    active,
    loading,
    byId,
    totalUnread,
    totalMentions,
    hydrate,
    refresh,
    upsert,
    upsertLocal,
    setActive,
    remove,
    removeForever,
    markRead,
    bumpUnread,
    noteLastMessage,
    noteUpdatedMessage,
    pin,
    reset,
  }
})
