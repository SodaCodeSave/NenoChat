import { computed } from 'vue'
import type { Message } from '@nenochat/shared'
import { messagePreview } from '@/composables/conversation'
import { useAiStore } from '@/stores/ai'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useMembersStore } from '@/stores/members'

/**
 * 消息展示信息解析：发送者名称 / 头像 / 底色 seed 与引用块摘要。
 * 消息列表与聊天截图共用同一套解析，保证两边渲染一致。
 */
export function useMessageDisplay(getMessages?: () => Message[]) {
  const auth = useAuthStore()
  const members = useMembersStore()
  const ai = useAiStore()
  const conversations = useConversationsStore()

  /**
   * 消息对应的 AI 角色。
   * 优先看消息自带的 personaId（历史消息可能没有），再退回会话绑定的角色，
   * 这样一个会话里就算换过角色也能显示对的人。
   */
  function personaOfMessage(message: Message): { name: string; avatarUrl: string | null } | null {
    const byMessage = message.meta?.ai?.personaId
    if (byMessage) {
      const found = ai.personas.find((p) => p.id === byMessage)
      if (found) return { name: found.name, avatarUrl: found.avatarUrl ?? null }
    }
    const byConversation = ai.personaOf(message.conversationId)
    if (byConversation) return { name: byConversation.name, avatarUrl: byConversation.avatarUrl ?? null }
    return null
  }

  function senderName(message: Message): string {
    if (message.senderType === 'ai') {
      return (
        personaOfMessage(message)?.name ??
        conversations.byId.get(message.conversationId)?.name ??
        'AI'
      )
    }
    if (message.senderId === auth.user?.id) return auth.user?.displayName ?? '我'
    // 成员索引是 O(1) 查表：渲染路径每行都会走这里，不能用数组 find 扫
    const member = members.memberIndex(message.conversationId).get(message.senderId ?? '')
    if (member) return members.displayName(member)
    return members.profiles[message.senderId ?? '']?.displayName ?? '未知用户'
  }

  function senderAvatar(message: Message): string | null {
    if (message.senderType === 'ai') {
      return (
        personaOfMessage(message)?.avatarUrl ??
        conversations.byId.get(message.conversationId)?.avatarUrl ??
        null
      )
    }
    if (message.senderId === auth.user?.id) return auth.user?.avatarUrl ?? null
    const member = members.memberIndex(message.conversationId).get(message.senderId ?? '')
    return member?.user?.avatarUrl ?? null
  }

  /** 没有头像时用 seed 派生稳定的底色，同一角色/用户永远同一个颜色 */
  function senderSeed(message: Message): string {
    if (message.senderType === 'ai') {
      return (
        message.meta?.ai?.personaId ??
        conversations.byId.get(message.conversationId)?.aiPersonaId ??
        message.conversationId
      )
    }
    return message.senderId ?? message.id
  }

  const messageById = computed(() =>
    new Map((getMessages?.() ?? []).map((message) => [message.id, message])),
  )

  /** 优先用已加载到的原消息（能看到编辑后的内容），否则退回发送时定格的快照 */
  function replyViewOf(message: Message): { id: string; senderName: string; preview: string } | null {
    if (!message.replyToId) return null
    const target = messageById.value.get(message.replyToId)
    if (target) {
      // 预览文案统一走 conversation 里的 messagePreview，别处（会话列表等）也用它
      return { id: target.id, senderName: senderName(target), preview: messagePreview(target) }
    }
    const snapshot = message.meta?.replyTo
    if (snapshot) {
      return { id: snapshot.id, senderName: snapshot.senderName, preview: snapshot.preview }
    }
    return { id: message.replyToId, senderName: '某条消息', preview: '原消息不在当前记录里' }
  }

  return { personaOfMessage, senderName, senderAvatar, senderSeed, replyViewOf }
}

/** 日期分隔行的分组键：同一天的行只插一条分隔 */
export function dayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** 日期分隔行的展示文案：今天 / 昨天 / 完整日期 */
export function dayLabel(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return '今天'
  const yesterday = new Date(now.getTime() - 86400000)
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return '昨天'
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}
