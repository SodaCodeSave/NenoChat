import { describe, expect, it } from 'vitest'
import type { NotificationSettings } from '../entities'
import { NotificationLevel } from '../enums'
import {
  isInDndWindow,
  minutesOfDay,
  notificationPreview,
  parseHm,
  resolveNotificationLevel,
  shouldShowSystemNotification,
  systemNotificationBody,
} from './rules'

const baseSettings: NotificationSettings = {
  desktopEnabled: true,
  soundEnabled: true,
  showPreview: true,
  dmLevel: NotificationLevel.All,
  groupLevel: NotificationLevel.Mentions,
  dndEnabled: false,
  dndStart: '23:00',
  dndEnd: '08:00',
  timezone: 'Asia/Shanghai',
}

describe('parseHm / minutesOfDay', () => {
  it('解析合法时间并拒绝脏值', () => {
    expect(parseHm('00:00')).toBe(0)
    expect(parseHm('23:59')).toBe(1439)
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('8:00')).toBeNull()
  })

  it('按给定时区计算当天分钟数', () => {
    // UTC 16:30 = Asia/Shanghai 次日 00:30
    expect(minutesOfDay(new Date('2026-01-01T16:30:00Z'), 'Asia/Shanghai')).toBe(30)
  })
})

describe('isInDndWindow', () => {
  it('普通时段与跨零点时段都能正确判断', () => {
    const noon = new Date('2026-01-01T04:00:00Z') // 上海 12:00
    expect(isInDndWindow('11:00', '13:00', noon, 'Asia/Shanghai')).toBe(true)
    expect(isInDndWindow('13:00', '14:00', noon, 'Asia/Shanghai')).toBe(false)

    const lateNight = new Date('2026-01-01T16:30:00Z') // 上海 00:30
    expect(isInDndWindow('23:00', '08:00', lateNight, 'Asia/Shanghai')).toBe(true)
    expect(isInDndWindow('08:00', '23:00', lateNight, 'Asia/Shanghai')).toBe(false)
  })

  it('起止相同或非法时不生效', () => {
    const now = new Date('2026-01-01T04:00:00Z')
    expect(isInDndWindow('09:00', '09:00', now, 'Asia/Shanghai')).toBe(false)
    expect(isInDndWindow('bad', '08:00', now, 'Asia/Shanghai')).toBe(false)
  })
})

describe('resolveNotificationLevel', () => {
  it('会话设置覆盖全局，缺省按类型取默认', () => {
    expect(resolveNotificationLevel('direct', baseSettings)).toBe(NotificationLevel.All)
    expect(resolveNotificationLevel('group', baseSettings)).toBe(NotificationLevel.Mentions)
    expect(resolveNotificationLevel('group', baseSettings, NotificationLevel.All)).toBe(NotificationLevel.All)
    expect(resolveNotificationLevel('system', baseSettings)).toBe(NotificationLevel.All)
  })
})

describe('shouldShowSystemNotification', () => {
  it('总开关关闭时不打扰', () => {
    expect(
      shouldShowSystemNotification({
        kind: 'direct',
        settings: { ...baseSettings, desktopEnabled: false },
      }),
    ).toBe(false)
  })

  it('正在看的会话与前台的窗口不重复提醒', () => {
    expect(
      shouldShowSystemNotification({
        kind: 'direct',
        settings: baseSettings,
        conversationVisible: true,
        appFocused: true,
      }),
    ).toBe(false)
    expect(
      shouldShowSystemNotification({
        kind: 'direct',
        settings: baseSettings,
        conversationVisible: true,
        appFocused: false,
      }),
    ).toBe(true)
  })

  it('免打扰时段内不提醒', () => {
    const atNight = Date.parse('2026-01-01T16:30:00Z')
    expect(
      shouldShowSystemNotification({
        kind: 'mention',
        mentioned: true,
        settings: { ...baseSettings, dndEnabled: true },
        now: atNight,
      }),
    ).toBe(false)
  })

  it('群聊默认仅提醒 @，AI 接话例外', () => {
    expect(shouldShowSystemNotification({ kind: 'group', settings: baseSettings })).toBe(false)
    expect(
      shouldShowSystemNotification({ kind: 'group', settings: baseSettings, mentioned: true }),
    ).toBe(true)
    expect(shouldShowSystemNotification({ kind: 'mention', mentioned: true, settings: baseSettings })).toBe(true)
    expect(shouldShowSystemNotification({ kind: 'group_ai', settings: baseSettings })).toBe(true)
  })

  it('会话静音后任何类型都不提醒', () => {
    expect(
      shouldShowSystemNotification({
        kind: 'mention',
        mentioned: true,
        settings: { ...baseSettings, groupLevel: NotificationLevel.All },
        conversationLevel: NotificationLevel.None,
      }),
    ).toBe(false)
  })
})

describe('通知文案', () => {
  it('按消息类型生成摘要', () => {
    expect(notificationPreview('text', '  你好   世界 ')).toBe('你好 世界')
    expect(notificationPreview('image', '')).toBe('[图片]')
    expect(notificationPreview('file', '')).toBe('[文件]')
    expect(notificationPreview('sticker', '')).toBe('[表情]')
    expect(notificationPreview('text', 'a'.repeat(200), 10)).toBe('aaaaaaaaaa…')
  })

  it('关闭预览后使用通用正文', () => {
    expect(systemNotificationBody(true, '具体内容')).toBe('具体内容')
    expect(systemNotificationBody(false, '具体内容')).toBe('你收到一条新消息')
  })
})
