import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
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
  deleteConversationMessages,
  insertPending,
  listMessages,
  markFailed,
  upsertMessage,
  upsertMessagesBatched,
} from '@/db/dao/messages'
import { bumpOutboxAttempt, enqueue, listOutbox, removeOutbox } from '@/db/dao/sync'
import { isRetryableSendError } from '@/composables/send-retry'
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

/** outbox 条目里序列化的发送请求 */
interface OutboxSendPayload {
  conversationId: string
  clientNonce: string
  type: MessageTypeT
  content: string
  meta?: MessageMeta
  replyToId?: string | null
}

/** 启动预载的并发度：一组 3 个会话并行拉取，冷启动几十个会话也不会挤爆网络与 IPC */
const PRELOAD_CONCURRENCY = 3

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
  /**
   * 消息桶用 shallowRef：消息对象在合并时都是整体替换、从不原地修改，
   * 深层 proxy 只会让 300 条消息的窗口白付一遍代理开销。
   * 因此所有写入必须通过 patchBucket 整体替换桶对象——只改桶内属性不会触发更新。
   */
  const buckets = shallowRef<Record<string, ConversationMessages>>({})
  const sending = ref(false)

  const serverId = computed(() => useServersStore().currentId ?? '')
  const myId = computed(() => useAuthStore().user?.id ?? '')

  /** 整体替换式写入：以当前桶内容为基算出新桶，引用变化才触发订阅方刷新 */
  function patchBucket(conversationId: string, patch: (current: ConversationMessages) => ConversationMessages): void {
    const current = buckets.value[conversationId] ?? emptyBucket()
    const next = patch(current)
    // 内容没变就不动引用，避免无谓的重渲染
    if (next === current) return
    buckets.value = { ...buckets.value, [conversationId]: next }
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
    if (buckets.value[conversationId]?.loaded && !options.force) return
    patchBucket(conversationId, (bucket) => ({ ...bucket, loading: true }))

    try {
      if (hasLocalDb() && serverId.value) {
        const local = await listMessages(serverId.value, {
          conversationId,
          limit: 50,
        })
        if (local.messages.length > 0) {
          patchBucket(conversationId, (bucket) => ({
            ...bucket,
            messages: merge(bucket.messages, local.messages),
            hasMoreOlder: local.hasMore,
          }))
        }
      }

      const remote = await messageApi.page(conversationId, { limit: 50 })
      patchBucket(conversationId, (bucket) => ({
        ...bucket,
        messages: merge(bucket.messages, remote.messages),
        hasMoreOlder: remote.hasMore,
        loaded: true,
      }))

      if (hasLocalDb() && serverId.value) {
        // 一页 50 条合并成 3 条语句写入，不再逐条 2-3 次 IPC
        await upsertMessagesBatched(serverId.value, remote.messages)
      }
    } finally {
      patchBucket(conversationId, (bucket) => ({ ...bucket, loading: false }))
    }
  }

  /** 启动后逐批预载最近一页消息，点开会话时直接用内存数据渲染；单个会话失败不影响其余 */
  async function preload(conversationIds: string[]): Promise<void> {
    const pending = conversationIds.filter((id) => !buckets.value[id]?.loaded)
    for (let start = 0; start < pending.length; start += PRELOAD_CONCURRENCY) {
      const chunk = pending.slice(start, start + PRELOAD_CONCURRENCY)
      await Promise.allSettled(chunk.map((id) => loadInitial(id)))
    }
  }

  async function loadOlder(conversationId: string): Promise<void> {
    const target = buckets.value[conversationId]
    if (!target || target.loading || !target.hasMoreOlder) return
    const oldest = target.messages.find((m) => m.seq > 0)
    if (!oldest) return

    patchBucket(conversationId, (bucket) => ({ ...bucket, loading: true }))
    try {
      const remote = await messageApi.page(conversationId, {
        before: oldest.seq,
        limit: 50,
      })
      patchBucket(conversationId, (bucket) => ({
        ...bucket,
        messages: merge(remote.messages, bucket.messages),
        hasMoreOlder: remote.hasMore,
      }))
      if (hasLocalDb() && serverId.value) {
        await upsertMessagesBatched(serverId.value, remote.messages)
      }
    } finally {
      patchBucket(conversationId, (bucket) => ({ ...bucket, loading: false }))
    }
  }

  /** 搜索跳转：把目标消息所在的一段历史补进内存 */
  async function loadAround(conversationId: string, messageId: string): Promise<void> {
    if (messagesOf(conversationId).some((message) => message.id === messageId)) return

    const result = await messageApi.around(conversationId, messageId)
    patchBucket(conversationId, (bucket) => ({
      ...bucket,
      messages: merge(bucket.messages, result.messages),
    }))
    if (hasLocalDb() && serverId.value) {
      await upsertMessagesBatched(serverId.value, result.messages)
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

    patchBucket(conversationId, (bucket) => ({
      ...bucket,
      // 同 nonce 的残留行（上次重试失败留下的）先清掉，避免一次显示两条
      messages: sortAndTrim([...bucket.messages.filter((m) => m.clientNonce !== nonce), optimistic]),
    }))

    if (hasLocalDb() && serverId.value) {
      await deleteByNonce(serverId.value, nonce)
      await insertPending(serverId.value, optimistic)
    }

    const payload: OutboxSendPayload = {
      conversationId,
      clientNonce: nonce,
      type: options.type ?? MessageType.Text,
      content: options.content,
      meta: options.meta ?? undefined,
      replyToId: options.replyToId ?? null,
    }

    sending.value = true
    try {
      const result = wsClient.isOnline()
        ? ((await wsClient.request('message.send', payload)) as { message: Message })
        : await messageApi.send(payload)

      const confirmed = result.message
      await applyConfirmed(conversationId, nonce, confirmed)
      return confirmed
    } catch (e) {
      const reason = e instanceof Error ? e.message : '发送失败'
      // shallowRef 下原地改乐观行属性不会触发更新，整体替换成失败态
      patchBucket(conversationId, (bucket) => ({
        ...bucket,
        messages: bucket.messages.map((m) =>
          m.id === optimistic.id ? { ...m, localStatus: 'failed', localError: reason } : m,
        ),
      }))
      if (hasLocalDb() && serverId.value) {
        await markFailed(serverId.value, optimistic.id, reason)
        // 网络类失败落 outbox，重连后按 nonce 重放；服务端幂等，不会重复
        if (isRetryableSendError(e)) {
          await enqueue({
            id: optimistic.id,
            serverId: serverId.value,
            op: 'message.send',
            payload,
            conversationId,
          })
        }
      }
      throw e
    } finally {
      sending.value = false
    }
  }

  /**
   * 重连进入 live 后重放发件箱。逐条走 WS 请求，成功即按 nonce 转正并出队；
   * 仍失败则按指数退避推迟下次尝试。离线时直接跳过，等下一次 live。
   */
  async function flushOutbox(): Promise<void> {
    if (!hasLocalDb() || !serverId.value || !wsClient.isOnline()) return
    const rows = await listOutbox(serverId.value, 50)
    for (const row of rows) {
      if (!wsClient.isOnline()) break
      let payload: OutboxSendPayload
      try {
        payload = JSON.parse(row.payload) as OutboxSendPayload
      } catch {
        await removeOutbox(row.id)
        continue
      }
      try {
        const result = (await wsClient.request('message.send', payload)) as { message: Message }
        await applyConfirmed(payload.conversationId, payload.clientNonce, result.message)
        await removeOutbox(row.id)
      } catch (e) {
        const delay = Math.min(1000 * 2 ** Math.min(row.attempts, 6), 60000)
        await bumpOutboxAttempt(row.id, e instanceof Error ? e.message : '重发失败', delay)
      }
    }
  }

  /** 服务端回执：剔除同 nonce 的临时行，再按 id 合并权威消息（不能直接 concat） */
  async function applyConfirmed(conversationId: string, nonce: string, message: Message): Promise<void> {
    patchBucket(conversationId, (bucket) => ({
      ...bucket,
      messages: merge(
        bucket.messages.filter((m) => m.clientNonce !== nonce && m.id !== message.id),
        [message],
      ),
    }))

    if (hasLocalDb() && serverId.value) {
      await confirmPending(serverId.value, nonce, message)
    }
  }

  /** 收到其他端或本端广播的新消息 */
  async function applyCreated(message: Message): Promise<void> {
    patchBucket(message.conversationId, (bucket) => ({
      ...bucket,
      messages: merge(
        message.clientNonce ? bucket.messages.filter((m) => m.clientNonce !== message.clientNonce) : bucket.messages,
        [message],
      ),
    }))
    if (hasLocalDb() && serverId.value) {
      await upsertMessage(serverId.value, { ...message, localStatus: 'synced' })
    }
  }

  /** 仅内存合并一条更新（已存在的行整体替换）；镜像写入由调用方决定，sync 批量落库时不再单条写 */
  function mergeUpdated(message: Message): void {
    if (!buckets.value[message.conversationId]) return
    patchBucket(message.conversationId, (bucket) => {
      const index = bucket.messages.findIndex((m) => m.id === message.id)
      if (index < 0) return bucket
      const messages = bucket.messages.slice()
      messages[index] = { ...bucket.messages[index], ...message }
      return { ...bucket, messages }
    })
  }

  /**
   * 追批用的同步 upsert：新消息插入、已有消息替换，不落库（落库由 sync 第二遍批量完成）。
   * 与 mergeUpdated 的区别是后者在会话未加载/消息不存在时直接丢弃，
   * 而追批里的消息可能既未在内存、也还没加载过该会话。
   */
  function mergeIncoming(message: Message): void {
    patchBucket(message.conversationId, (bucket) => ({
      ...bucket,
      messages: merge(bucket.messages, [message]),
    }))
  }

  async function applyUpdated(message: Message): Promise<void> {
    mergeUpdated(message)
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

  /**
   * 批量转发：服务端逐条复制到每个目标会话。
   * 返回的消息合并进内存与本地镜像；自己的 WS 也会收到 message.created，
   * 两路按 id 幂等合并，重复到达不会显示两条。
   */
  async function forwardMessages(messageIds: string[], targetConversationIds: string[]): Promise<number> {
    const { results } = await messageApi.forward(messageIds, targetConversationIds)
    let count = 0
    for (const result of results) {
      for (const message of result.messages) {
        await applyCreated(message)
        count += 1
      }
    }
    return count
  }

  /** 移除会话时清掉内存与本地消息镜像 */
  async function removeConversation(conversationId: string): Promise<void> {
    const next = { ...buckets.value }
    delete next[conversationId]
    buckets.value = next
    if (hasLocalDb() && serverId.value) {
      await deleteConversationMessages(serverId.value, conversationId)
    }
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
    mergeUpdated,
    mergeIncoming,
    flushOutbox,
    applyUpdated,
    edit,
    recall,
    pin,
    forwardMessages,
    removeConversation,
    reset,
  }
})
