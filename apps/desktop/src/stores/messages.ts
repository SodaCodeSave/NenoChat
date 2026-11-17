import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  MessageType,
  ulid,
  type Message,
  type MessageMeta,
  type MessageType as MessageTypeT,
} from '@nenochat/shared'
import { messageApi } from '@/api/endpoints'
import {
  confirmPending,
  deleteByNonce,
  insertPending,
  listMessages,
  markFailed,
  upsertMessage,
} from '@/db/dao/messages'
import { mergeMessages, sortAndTrim } from '@/composables/message-merge'
import { hasLocalDb } from '@/platform/db'
import { wsClient } from '@/realtime/ws-client'
import { useServersStore } from './servers'
import { useAuthStore } from './auth'

interface ConversationMessages {
  messages: Message[]
  hasMoreOlder: boolean
  loading: boolean
  loaded: boolean
}

function emptyBucket(): ConversationMessages {
  return { messages: [], hasMoreOlder: false, loading: false, loaded: false }
}

export interface SendOptions {
  conversationId: string
  content: string
  type?: MessageTypeT
  meta?: MessageMeta
  replyToId?: string | null
  /**
   * 由调用方指定 nonce（例如 AI 回合：发送与生成必须共用同一个值）。
   * 不传则内部生成，保证每次发送都有唯一幂等键。
   */
  clientNonce?: string
}

/**
 * 消息状态。
 * 读：先出本地镜像（秒开），再与服务端分页结果合并；
 * 写：先乐观插入带 local_status='pending'，由服务端回执转正。
 */
export const useMessagesStore = defineStore('messages', () => {
  const buckets = ref<Record<string, ConversationMessages>>({})
  const sending = ref(false)

  const serverId = computed(() => useServersStore().currentId ?? '')
  const myId = computed(() => useAuthStore().user?.id ?? '')

  function bucket(conversationId: string): ConversationMessages {
    let existing = buckets.value[conversationId]
    if (!existing) {
      buckets.value[conversationId] = emptyBucket()
      // 必须回读代理而不是沿用新建的原始对象，否则后续赋值不触发响应式更新
      existing = buckets.value[conversationId]!
    }
    return existing
  }

  function messagesOf(conversationId: string): Message[] {
    return buckets.value[conversationId]?.messages ?? []
  }

  const lastMessageOf = (conversationId: string): Message | null => {
    const list = messagesOf(conversationId)
    return list.length > 0 ? list[list.length - 1]! : null
  }

  function merge(list: Message[], incoming: Message[]): Message[] {
    return mergeMessages(list, incoming)
  }

  /** 首次进入会话：本地镜像立即可用，网络结果回来后再合并 */
  async function loadInitial(conversationId: string, options: { force?: boolean } = {}): Promise<void> {
    const target = bucket(conversationId)
    if (target.loaded && !options.force) return
    target.loading = true

    try {
      if (hasLocalDb() && serverId.value) {
        const local = await listMessages(serverId.value, {
          conversationId,
          limit: 50,
        })
        if (local.messages.length > 0) {
          target.messages = merge(target.messages, local.messages)
          target.hasMoreOlder = local.hasMore
        }
      }

      const remote = await messageApi.page(conversationId, { limit: 50 })
      target.messages = merge(target.messages, remote.messages)
      target.hasMoreOlder = remote.hasMore
      target.loaded = true

      if (hasLocalDb() && serverId.value) {
        for (const message of remote.messages) {
          await upsertMessage(serverId.value, message)
        }
      }
    } finally {
      target.loading = false
    }
  }

  /** 启动后逐个会话预载最近一页消息，点开会话时直接用内存数据渲染 */
  async function preload(conversationIds: string[]): Promise<void> {
    for (const id of conversationIds) {
      if (buckets.value[id]?.loaded) continue
      try {
        await loadInitial(id)
      } catch {
        // 单个会话预载失败不影响其余会话，点开时会按需重试
      }
    }
  }

  async function loadOlder(conversationId: string): Promise<void> {
    const target = bucket(conversationId)
    if (target.loading || !target.hasMoreOlder) return
    const oldest = target.messages.find((m) => m.seq > 0)
    if (!oldest) return

    target.loading = true
    try {
      const remote = await messageApi.page(conversationId, {
        before: oldest.seq,
        limit: 50,
      })
      target.messages = merge(remote.messages, target.messages)
      target.hasMoreOlder = remote.hasMore
      if (hasLocalDb() && serverId.value) {
        for (const message of remote.messages) {
          await upsertMessage(serverId.value, message)
        }
      }
    } finally {
      target.loading = false
    }
  }

  /** 搜索跳转：把目标消息所在的一段历史补进内存 */
  async function loadAround(conversationId: string, messageId: string): Promise<void> {
    const target = bucket(conversationId)
    if (target.messages.some((message) => message.id === messageId)) return

    const result = await messageApi.around(conversationId, messageId)
    target.messages = merge(target.messages, result.messages)
    if (hasLocalDb() && serverId.value) {
      for (const message of result.messages) {
        await upsertMessage(serverId.value, message)
      }
    }
  }

  /** 发送消息：乐观插入 → 优先走 WS → 失败落 outbox 等重连重试 */
  async function send(options: SendOptions): Promise<Message> {
    const conversationId = options.conversationId
    const nonce = options.clientNonce ?? ulid()
    const now = Date.now()
    const list = messagesOf(conversationId)
    const localSeq = (list.length > 0 ? Math.max(...list.map((m) => m.seq)) : 0) + 1

    const optimistic: Message = {
      id: ulid(),
      conversationId,
      senderId: myId.value,
      senderType: 'user',
      type: options.type ?? MessageType.Text,
      content: options.content,
      meta: { ...(options.meta ?? {}), clientNonce: nonce },
      replyToId: options.replyToId ?? null,
      seq: localSeq,
      clientNonce: nonce,
      createdAt: now,
      updatedAt: now,
      localStatus: 'pending',
    }

    const target = bucket(conversationId)
    // 同 nonce 的残留行（上次重试失败留下的）先清掉，避免一次显示两条
    target.messages = sortAndTrim([
      ...target.messages.filter((m) => m.clientNonce !== nonce),
      optimistic,
    ])

    if (hasLocalDb() && serverId.value) {
      await deleteByNonce(serverId.value, nonce)
      await insertPending(serverId.value, optimistic)
    }

    sending.value = true
    try {
      const payload = {
        conversationId,
        clientNonce: nonce,
        type: options.type ?? MessageType.Text,
        content: options.content,
        meta: options.meta ?? undefined,
        replyToId: options.replyToId ?? null,
      }

      const result = wsClient.isOnline()
        ? ((await wsClient.request('message.send', payload)) as { message: Message })
        : await messageApi.send(payload)

      const confirmed = result.message
      await applyConfirmed(conversationId, nonce, confirmed)
      return confirmed
    } catch (e) {
      const reason = e instanceof Error ? e.message : '发送失败'
      optimistic.localStatus = 'failed'
      optimistic.localError = reason
      if (hasLocalDb() && serverId.value) {
        await markFailed(serverId.value, optimistic.id, reason)
      }
      throw e
    } finally {
      sending.value = false
    }
  }

  /** 服务端回执：剔除同 nonce 的临时行，再按 id 合并权威消息（不能直接 concat） */
  async function applyConfirmed(conversationId: string, nonce: string, message: Message): Promise<void> {
    const target = bucket(conversationId)
    target.messages = merge(
      target.messages.filter((m) => m.clientNonce !== nonce && m.id !== message.id),
      [message],
    )

    if (hasLocalDb() && serverId.value) {
      await confirmPending(serverId.value, nonce, message)
    }
  }

  /** 收到其他端或本端广播的新消息 */
  async function applyCreated(message: Message): Promise<void> {
    const target = bucket(message.conversationId)
    target.messages = merge(
      message.clientNonce ? target.messages.filter((m) => m.clientNonce !== message.clientNonce) : target.messages,
      [message],
    )
    if (hasLocalDb() && serverId.value) {
      await upsertMessage(serverId.value, { ...message, localStatus: 'synced' })
    }
  }

  async function applyUpdated(message: Message): Promise<void> {
    const target = bucket(message.conversationId)
    const index = target.messages.findIndex((m) => m.id === message.id)
    if (index >= 0) target.messages[index] = { ...target.messages[index], ...message }
    if (hasLocalDb() && serverId.value) {
      await upsertMessage(serverId.value, message)
    }
  }

  async function edit(messageId: string, content: string): Promise<void> {
    const result = await messageApi.edit(messageId, content)
    await applyUpdated(result.message)
  }

  async function recall(messageId: string): Promise<void> {
    const result = await messageApi.recall(messageId)
    await applyUpdated(result.message)
  }

  async function pin(messageId: string, pinned: boolean): Promise<void> {
    const result = await messageApi.pin(messageId, pinned)
    await applyUpdated(result.message)
  }

  function reset(): void {
    buckets.value = {}
  }

  return {
    buckets,
    sending,
    messagesOf,
    lastMessageOf,
    loadInitial,
    preload,
    loadOlder,
    loadAround,
    send,
    applyConfirmed,
    applyCreated,
    applyUpdated,
    edit,
    recall,
    pin,
    reset,
  }
})
