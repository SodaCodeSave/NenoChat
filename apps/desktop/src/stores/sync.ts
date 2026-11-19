import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AiPersona, ChangeRecord, Conversation, Member, Message, PublicUser } from '@nenochat/shared'
import { getCursor, setCursor } from '@/db/dao/sync'
import {
  markConversationsDeleted,
  markMembersLeft,
  upsertConversationsBatched,
  upsertMembersBatched,
} from '@/db/dao/conversations'
import * as aiDao from '@/db/dao/ai'
import { upsertUser } from '@/db/dao/users'
import { upsertMessagesBatched } from '@/db/dao/messages'
import { hasLocalDb } from '@/platform/db'
import { wsClient, type ConnStatus } from '@/realtime/ws-client'
import { useServersStore } from './servers'
import { useAuthStore } from './auth'
import { useConversationsStore } from './conversations'
import { useMessagesStore } from './messages'
import { useMembersStore } from './members'
import { useTypingStore } from './typing'
import { useMomentsStore } from './moments'
import { useAiStore } from './ai'
import { useDebugStore } from './debug'
import { useContactsStore } from './contacts'
import { useSystemNotificationsStore } from './system-notifications'

/**
 * 同步中枢：既负责把变更落到本地镜像，也负责把实时事件转发给各业务 store。
 * 所有 WS 事件只在这里订阅一次，避免多处重复注册造成顺序问题。
 */
export const useSyncStore = defineStore('sync', () => {
  const status = ref<ConnStatus>('idle')
  const lastError = ref<string | null>(null)
  const cursor = ref(0)
  const appliedBatches = ref(0)

  const serverId = computed(() => useServersStore().currentId ?? '')
  const isLive = computed(() => status.value === 'live')

  let registered = false
  let teardown: Array<() => void> = []

  async function loadCursor(): Promise<number> {
    if (!hasLocalDb() || !serverId.value) return 0
    cursor.value = await getCursor(serverId.value)
    return cursor.value
  }

  /**
   * 批量应用变更。大追批（离线几天再上线）一次可能推来上千条记录，
   * 逐条 await 会有成千上万次串行 IPC 往返；这里分两遍：
   * 第一遍按原始顺序做纯内存更新（轻量、同步），同时按实体聚合；
   * 第二遍把高流量实体（消息/会话/成员）合并成少量多行语句一次落库。
   * 每条变更都是幂等 upsert；同类实体在同一批里重复出现时以最后一条为准，
   * 最终状态与原来的逐条顺序应用完全一致。
   */
  async function applyChanges(changes: ChangeRecord[]): Promise<void> {
    const sid = serverId.value
    // 注意：这里不判断 hasLocalDb —— DAO 自身在无本地库时静默跳过，
    // 但内存 store 仍需更新，否则浏览器模式会漏掉全部增量。
    if (!sid) return

    const conversations = useConversationsStore()
    const messages = useMessagesStore()
    const members = useMembersStore()
    const ai = useAiStore()
    const contacts = useContactsStore()

    /* -------- 第一遍：内存更新 + 按实体聚合 -------- */
    const userRows = new Map<string, PublicUser>()
    const conversationRows = new Map<string, Conversation>()
    const conversationDeletes = new Set<string>()
    const memberRows = new Map<string, Member>()
    const memberDeletes = new Map<string, { conversationId: string; userId: string }>()
    const messageRows = new Map<string, Message>()
    const personaRows = new Map<string, AiPersona>()
    const personaDeletes = new Set<string>()

    for (const change of changes) {
      const payload = change.payload as Record<string, unknown> | null
      if (!payload) continue

      switch (change.entity) {
        case 'contact':
          contacts.upsert(payload as never)
          break
        case 'user': {
          const user = payload as unknown as PublicUser
          userRows.set(user.id, user)
          break
        }
        case 'conversation': {
          const conversation = payload as unknown as Conversation
          if (change.op === 'delete') {
            conversations.remove(conversation.id)
            conversationRows.delete(conversation.id)
            conversationDeletes.add(conversation.id)
          } else {
            conversations.upsertLocal(conversation as never)
            conversationRows.set(conversation.id, conversation)
            conversationDeletes.delete(conversation.id)
          }
          break
        }
        case 'member': {
          const member = payload as unknown as Member
          const key = `${member.conversationId}:${member.userId}`
          if (change.op === 'delete') {
            members.removeLocal(member.conversationId, member.userId)
            memberRows.delete(key)
            memberDeletes.set(key, { conversationId: member.conversationId, userId: member.userId })
          } else {
            members.upsertLocal(member)
            memberRows.set(key, member)
            memberDeletes.delete(key)
          }
          break
        }
        case 'message': {
          const message = payload as unknown as Message
          // 用 upsert 而非 mergeUpdated：追批里可能含离线期间的新消息，
          // 该会话可能从未加载过，mergeUpdated 在消息不存在时会直接丢弃。
          messages.mergeIncoming(message)
          messageRows.set(message.id, { ...message, localStatus: 'synced' })
          break
        }
        case 'ai_persona': {
          const persona = payload as unknown as AiPersona
          if (change.op === 'delete') {
            ai.removeLocal(persona.id)
            personaRows.delete(persona.id)
            personaDeletes.add(persona.id)
          } else {
            ai.upsertLocal(persona)
            personaRows.set(persona.id, persona)
            personaDeletes.delete(persona.id)
          }
          break
        }
        default:
          // 其余实体（动态、表情、AI 记忆等）在各自模块接入时再补
          break
      }
    }

    /* -------- 第二遍：按实体类型落库。消息/会话/成员是多行语句批量写；用户与角色量级小，保持逐条 -------- */
    if (messageRows.size > 0) await upsertMessagesBatched(sid, [...messageRows.values()])
    if (conversationRows.size > 0) await upsertConversationsBatched(sid, [...conversationRows.values()])
    if (conversationDeletes.size > 0) {
      await markConversationsDeleted(sid, [...conversationDeletes])
      for (const id of conversationDeletes) await messages.removeConversation(id)
    }
    if (memberRows.size > 0) await upsertMembersBatched(sid, [...memberRows.values()])
    if (memberDeletes.size > 0) await markMembersLeft(sid, [...memberDeletes.values()])
    for (const user of userRows.values()) {
      await upsertUser(sid, user)
    }
    for (const persona of personaRows.values()) {
      await aiDao.upsertPersona(sid, persona)
    }
    for (const personaId of personaDeletes) {
      await aiDao.deletePersona(sid, personaId)
    }
  }

  async function handleBatch(payload: { changes: ChangeRecord[]; nextCursor: number; hasMore: boolean }): Promise<void> {
    await applyChanges(payload.changes)
    if (hasLocalDb() && serverId.value) {
      await setCursor(serverId.value, payload.nextCursor)
    }
    cursor.value = payload.nextCursor
    appliedBatches.value += 1
  }

  function registerHandlers(): void {
    if (registered) return
    registered = true

    const conversations = useConversationsStore()
    const messages = useMessagesStore()
    const members = useMembersStore()
    const typing = useTypingStore()
    const moments = useMomentsStore()
    const auth = useAuthStore()
    const ai = useAiStore()

    teardown = [
      wsClient.on('sync.batch', (payload) => {
        void handleBatch(payload)
      }),

      wsClient.on('message.created', (payload) => {
        void messages.applyCreated(payload.message as Message)
        const mentioned = Boolean(
          payload.message.meta?.mentions?.includes(auth.user?.id ?? '') ||
            payload.message.meta?.mentionAll,
        )
        if (payload.message.senderId !== auth.user?.id) {
          conversations.bumpUnread(payload.conversationId, mentioned)
        }
        void useSystemNotificationsStore().onMessageCreated(payload.message as Message)
        const target = conversations.byId.get(payload.conversationId)
        if (target) {
          target.lastMessageAt = payload.message.createdAt
          target.lastMessageId = payload.message.id
        }
      }),

      wsClient.on('message.updated', (payload) => {
        void messages.applyUpdated(payload.message as Message)
      }),

      wsClient.on('conversation.updated', (payload) => {
        void conversations.upsert(payload.conversation as never)
      }),

      wsClient.on('conversation.member.upserted', (payload) => {
        void members.applyUpserted(payload.conversationId, payload.member, payload.user as PublicUser | undefined)
      }),

      wsClient.on('conversation.member.removed', (payload) => {
        void members.applyRemoved(payload.conversationId, payload.userId)
      }),

      wsClient.on('typing', (payload) => {
        typing.applyTyping(payload.conversationId, payload.userId, payload.state, payload.expiresAt)
      }),

      wsClient.on('presence.updated', (payload) => {
        members.setOnline(payload.userId, payload.status !== 'offline')
      }),

      wsClient.on('receipt.updated', (payload) => {
        const target = conversations.byId.get(payload.conversationId)
        if (target && payload.userId === auth.user?.id) {
          target.myLastReadSeq = payload.messageSeq
        }
      }),

      // 服务端判定该主动发消息，但密钥在本机 → 交给在线客户端生成
      wsClient.on('post.created', (payload) => {
        moments.onCreated(payload.post)
      }),

      wsClient.on('post.updated', (payload) => {
        moments.onUpdated(payload.post)
      }),

      wsClient.on('post.removed', (payload) => {
        moments.onRemoved(payload.postId)
      }),

      wsClient.on('post.like.changed', (payload) => {
        moments.onLikeChanged(payload)
      }),

      wsClient.on('post.comment.created', (payload) => {
        moments.onCommentCreated(payload.comment)
      }),

      wsClient.on('post.comment.removed', (payload) => {
        moments.onCommentRemoved(payload.postId, payload.commentId)
      }),

      // 服务端流式生成进度：逐字增量 / 切好一段 / 结束 / 失败
      wsClient.on('ai.delta', (payload) => {
        ai.applyServerDelta(payload)
      }),

      wsClient.on('ai.segment', (payload) => {
        ai.applyServerSegment(payload)
      }),

      wsClient.on('ai.done', (payload) => {
        ai.applyServerDone(payload)
      }),

      wsClient.on('ai.error', (payload) => {
        ai.applyServerError(payload)
      }),

      // 连接器动作实时进度：流式生成前的搜索/抓取阶段
      wsClient.on('ai.connector.status', (payload) => {
        ai.setConnectorLive(payload.conversationId, payload.phase === 'start' ? payload.kind : null)
      }),

      // 调试模式：群聊成员决策过程实时推送
      wsClient.on('ai.debug.decision', (payload) => {
        useDebugStore().applyDecision(payload.decision)
      }),

      wsClient.on('contact.updated', (payload) => {
        useContactsStore().upsert(payload.contact)
      }),

      wsClient.on('sync.reset', () => {
        void (async () => {
          if (hasLocalDb() && serverId.value) await setCursor(serverId.value, 0)
          cursor.value = 0
          await conversations.refresh()
        })()
      }),

      wsClient.on('auth.err', (payload) => {
        lastError.value = payload.message
      }),
    ]
  }

  /** 建立连接。必须先 registerHandlers，保证 catchUp 批次能被接住 */
  async function connect(): Promise<void> {
    const servers = useServersStore()
    const auth = useAuthStore()
    if (!servers.current) return

    registerHandlers()
    await loadCursor()

    wsClient.configure({
      url: servers.current.wsUrl,
      deviceId: auth.devicePayload().id,
      getToken: async () => auth.accessToken,
      // 游标必须每次重连实时取：handleBatch 会持续推进它，
      // 若固定在启动时的值，长会话每次断线重连都会重放全部增量
      getCursor: async () => cursor.value,
      onStatus: (next) => {
        const wasLive = isLive.value
        status.value = next
        // 断线重连并追平后，重放离线期间落 outbox 的发送消息
        if (next === 'live' && !wasLive) {
          void useMessagesStore().flushOutbox()
        }
      },
      onFatal: (reason) => {
        lastError.value = reason
        status.value = 'offline'
        void auth.clearSession()
      },
    })

    await wsClient.connect()
  }

  function disconnect(): void {
    for (const off of teardown) off()
    teardown = []
    registered = false
    wsClient.close()
    status.value = 'idle'
  }

  function reset(): void {
    cursor.value = 0
    appliedBatches.value = 0
    lastError.value = null
  }

  return {
    status,
    lastError,
    cursor,
    appliedBatches,
    isLive,
    loadCursor,
    applyChanges,
    connect,
    disconnect,
    reset,
  }
})
