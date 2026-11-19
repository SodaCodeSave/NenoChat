import { computed } from 'vue'
import type { ConversationSummary } from '@/api/endpoints'
import type { Message } from '@nenochat/shared'
import { useContactsStore } from '@/stores/contacts'

/**
 * 会话展示信息的统一推导：标题、头像、最后一条消息摘要。
 * 私聊用对方资料，群聊与 AI 会话用自身名称。
 */
export function conversationTitle(conversation: ConversationSummary, isFriend = true): string {
  if (conversation.type === 'direct') {
    const name = conversation.partnerName ?? conversation.name ?? '私聊'
    return isFriend ? name : `${name} [临时对话]`
  }
  if (conversation.type === 'ai') {
    return conversation.name ?? 'AI 会话'
  }
  return conversation.name ?? '未命名群聊'
}

/** 依据通讯录关系生成会话标题：非好友私聊追加临时标记 */
export function useConversationTitle(): (conversation: ConversationSummary) => string {
  const contacts = useContactsStore()
  const friendIds = computed(() => new Set(contacts.friends.map((item) => item.contactUserId)))
  return (conversation: ConversationSummary) =>
    conversationTitle(conversation, friendIds.value.has(conversation.partnerId ?? ''))
}

export function conversationAvatar(conversation: ConversationSummary): string | null {
  if (conversation.type === 'direct') {
    return conversation.partnerAvatarUrl ?? conversation.avatarUrl ?? null
  }
  return conversation.avatarUrl ?? null
}

export function conversationSeed(conversation: ConversationSummary): string {
  if (conversation.type === 'direct') {
    return conversation.partnerId ?? conversation.id
  }
  return conversation.id
}

/** 列表里显示的最后一条消息预览，撤回与附件都用文字占位 */
export function messagePreview(message: Message | null | undefined): string {
  if (!message) return ''
  if (message.deletedAt) return '[消息已撤回]'
  switch (message.type) {
    case 'image':
      return '[图片]'
    case 'file':
      return `[文件] ${message.meta?.attachments?.[0]?.filename ?? ''}`.trim()
    case 'sticker':
      return '[表情]'
    case 'system':
      return message.content
    default:
      return message.content.replace(/\s+/g, ' ').slice(0, 60)
  }
}

export function formatListTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return sameYear ? `${month}/${day}` : `${date.getFullYear()}/${month}/${day}`
}

export function formatMessageTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${time}`
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}/${day} ${time}`
}
