import type { NotificationSettings } from '../entities'
import { NotificationLevel } from '../enums'

/**
 * 通知判定的纯函数集合。
 * 客户端收到新消息后，用这里的结果决定「这条消息该不该弹系统通知」。
 */

export type NotificationKind =
  | 'direct'
  | 'group'
  | 'group_ai'
  | 'mention'
  | 'ai_proactive'
  | 'system'

export interface NotificationGateInput {
  kind: NotificationKind
  settings: NotificationSettings
  /** 会话级的免打扰设置，覆盖全局默认 */
  conversationLevel?: NotificationLevel | null
  /** 消息里是否 @ 了当前用户 */
  mentioned?: boolean
  /** 当前正在查看该会话 */
  conversationVisible?: boolean
  /** 窗口是否处于前台（仅前端判定用） */
  appFocused?: boolean
  /** 判定时刻，默认当前时间 */
  now?: number
}

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 解析 HH:mm，非法值返回 null，避免脏设置让免打扰永久生效 */
export function parseHm(value: string): number | null {
  const match = HM_RE.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** 取指定时区的「当天第几分钟」；时区不可用时退回本地时间 */
export function minutesOfDay(date: Date, timeZone?: string): number {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(date)
      const hour = Number(parts.find((part) => part.type === 'hour')?.value)
      const minute = Number(parts.find((part) => part.type === 'minute')?.value)
      if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute
    } catch {
      /* 无效时区继续走本地时间 */
    }
  }
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 是否落在免打扰时段内。
 * 支持跨零点（23:00 → 08:00）；起止相同视为未配置，不拦截。
 */
export function isInDndWindow(
  start: string,
  end: string,
  date: Date = new Date(),
  timeZone?: string,
): boolean {
  const from = parseHm(start)
  const to = parseHm(end)
  if (from === null || to === null || from === to) return false
  const current = minutesOfDay(date, timeZone)
  return from < to ? current >= from && current < to : current >= from || current < to
}

/** 会话级设置优先；没有单独设置时按会话类型取全局默认 */
export function resolveNotificationLevel(
  kind: NotificationKind,
  settings: NotificationSettings,
  conversationLevel?: NotificationLevel | null,
): NotificationLevel {
  if (conversationLevel) return conversationLevel
  if (kind === 'direct' || kind === 'ai_proactive') return settings.dmLevel
  if (kind === 'system') return NotificationLevel.All
  return settings.groupLevel
}

/**
 * 最终是否弹出系统通知。
 * 静音、免打扰、正在看该会话都只是「不打扰」，消息本身仍会正常落库。
 */
export function shouldShowSystemNotification(input: NotificationGateInput): boolean {
  const { kind, settings } = input
  if (!settings.desktopEnabled) return false
  if (input.conversationVisible && input.appFocused) return false

  if (settings.dndEnabled) {
    const now = new Date(input.now ?? Date.now())
    if (isInDndWindow(settings.dndStart, settings.dndEnd, now, settings.timezone)) return false
  }

  const level = resolveNotificationLevel(kind, settings, input.conversationLevel)
  if (level === NotificationLevel.None) return false
  if (kind === 'mention' || input.mentioned) return true
  // 群聊 AI 接话属于用户主动关注的事件，不受「仅 @ 提及」限制，但仍尊重静音
  if (kind === 'group_ai') return true
  if (level === NotificationLevel.Mentions) return false
  return true
}

/** 通知摘要：图片、文件、表情只给占位，避免系统通知里出现空标题 */
export function notificationPreview(type: string, content: string, maxLength = 120): string {
  switch (type) {
    case 'image':
      return '[图片]'
    case 'file':
      return '[文件]'
    case 'sticker':
      return '[表情]'
    default: {
      const text = content.replace(/\s+/g, ' ').trim()
      return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
    }
  }
}

/** 系统通知正文：关闭预览后只显示通用提示 */
export function systemNotificationBody(showPreview: boolean, body?: string | null): string {
  if (!showPreview || !body) return '你收到一条新消息'
  return body
}

export interface MessageNotificationInput {
  conversationType: string
  senderType: string
  senderId?: string | null
  selfId?: string | null
  mentioned?: boolean
  proactive?: boolean
  aiIndex?: number | null
}

/**
 * 消息是否需要系统弹窗，以及按哪种类型判定。
 * 返回 null 表示这条消息不该打扰（自己发的、系统消息、AI 回复的后续分段）。
 */
export function messageNotificationKind(input: MessageNotificationInput): NotificationKind | null {
  if (input.senderType === 'system') return null
  if (input.selfId && input.senderId === input.selfId) return null
  if (input.aiIndex != null && input.aiIndex > 0) return null
  if (input.mentioned) return 'mention'
  if (input.proactive) return 'ai_proactive'
  if (input.conversationType === 'group') {
    return input.senderType === 'ai' ? 'group_ai' : 'group'
  }
  return 'direct'
}
