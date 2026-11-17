import {
  ConversationType,
  SenderType,
  type AppNotification,
  type Message,
} from '@nenochat/shared'
import { notificationPreview } from '@nenochat/shared/notifications/rules'
import type { DB } from '../db'
import * as aiRepo from '../db/repo/ai'
import * as conversationsRepo from '../db/repo/conversations'
import * as membersRepo from '../db/repo/members'
import * as usersRepo from '../db/repo/users'
import { createNotification } from './notification-service'

/**
 * 消息落库后的通知扇出。
 *
 * 服务端只负责「为谁留下一条通知记录」，静音、免打扰、预览开关等
 * 是否打扰的判定统一放在客户端，用 shared 的纯函数完成。
 * 同一条消息按 (user_id, message_id) 去重，兼容主动消息等已有的通知调用。
 */
export function notifyMessageRecipients(db: DB, message: Message): void {
  if (message.senderType === SenderType.System) return
  // AI 回复会被切成多条消息，只在第一片提醒一次，避免同一个回复连弹多条
  if (message.meta?.ai && message.meta.ai.index > 0) return

  const conversation = conversationsRepo.findById(db, message.conversationId)
  if (!conversation || conversation.deleted_at !== null) return

  const sender = message.senderId ? usersRepo.findById(db, message.senderId) : undefined
  // AI 消息的 sender_id 可能为空，角色名从 meta/会话上兜底，避免通知标题变成泛化的「AI」
  const personaId = message.meta?.ai?.personaId ?? conversation.ai_persona_id ?? undefined
  const persona = personaId ? aiRepo.findPersona(db, personaId) : undefined
  const senderName = sender?.display_name ?? persona?.name ?? (message.senderType === SenderType.Ai ? 'AI' : '系统')
  const mentionedIds = new Set(message.meta?.mentions ?? [])
  const mentionAll = message.meta?.mentionAll === true
  const proactive = message.meta?.ai?.proactive === true
  const preview = notificationPreview(message.type, message.content) || '[新消息]'

  for (const member of membersRepo.listActive(db, message.conversationId)) {
    if (member.user_id === message.senderId) continue
    const user = usersRepo.findById(db, member.user_id)
    // 影子账号（AI 角色）不接收通知
    if (!user || user.is_bot === 1) continue

    const mentioned = mentionAll || mentionedIds.has(member.user_id)
    const type: AppNotification['type'] = proactive
      ? 'ai_proactive'
      : mentioned
        ? 'mention'
        : conversation.type === ConversationType.Group
          ? message.senderType === SenderType.Ai
            ? 'group_ai'
            : 'group'
          : 'dm'

    const isGroup = conversation.type === ConversationType.Group
    const title = isGroup ? (conversation.name ?? '群聊') : senderName
    const body =
      proactive || !isGroup
        ? preview
        : mentioned && !mentionAll
          ? `${senderName} 提到了你：${preview}`
          : `${senderName}：${preview}`

    createNotification(db, {
      userId: member.user_id,
      type,
      title,
      body,
      conversationId: message.conversationId,
      messageId: message.id,
    })
  }
}
