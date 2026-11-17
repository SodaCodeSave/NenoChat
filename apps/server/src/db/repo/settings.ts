import type { NotificationSettings, UserSettings } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface UserSettingsRow {
  user_id: string
  theme: string
  accent: string
  font_scale: number
  density: string
  send_key: string
  locale: string
  reduce_motion: number
  updated_at: number
}

export interface NotificationSettingsRow {
  user_id: string
  desktop_enabled: number
  sound_enabled: number
  show_preview: number
  dm_level: string
  group_level: string
  dnd_enabled: number
  dnd_start: string
  dnd_end: string
  timezone: string
  updated_at: number
}

export function mapUserSettings(row: UserSettingsRow): UserSettings {
  return {
    theme: row.theme as UserSettings['theme'],
    accent: row.accent,
    fontScale: row.font_scale,
    density: row.density === 'compact' ? 'compact' : 'cozy',
    sendKey: row.send_key === 'ctrl+enter' ? 'ctrl+enter' : 'enter',
    locale: row.locale,
    reduceMotion: row.reduce_motion === 1,
  }
}

export function mapNotificationSettings(row: NotificationSettingsRow): NotificationSettings {
  return {
    desktopEnabled: row.desktop_enabled === 1,
    soundEnabled: row.sound_enabled === 1,
    showPreview: row.show_preview === 1,
    dmLevel: row.dm_level as NotificationSettings['dmLevel'],
    groupLevel: row.group_level as NotificationSettings['groupLevel'],
    dndEnabled: row.dnd_enabled === 1,
    dndStart: row.dnd_start,
    dndEnd: row.dnd_end,
    timezone: row.timezone,
  }
}

/** 首次访问时补齐默认行，保证后续读取永远有值 */
export function ensureUserSettings(db: DB, userId: string): UserSettingsRow {
  const existing = db
    .prepare('SELECT * FROM user_settings WHERE user_id = ?')
    .get(userId) as UserSettingsRow | undefined
  if (existing) return existing
  db.prepare(
    `INSERT INTO user_settings (user_id, theme, accent, font_scale, density, send_key, locale, reduce_motion, updated_at)
     VALUES (?, 'system', 'blue', 1.0, 'cozy', 'enter', 'zh-CN', 0, ?)`,
  ).run(userId, now())
  return db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettingsRow
}

export function ensureNotificationSettings(db: DB, userId: string): NotificationSettingsRow {
  const existing = db
    .prepare('SELECT * FROM notification_settings WHERE user_id = ?')
    .get(userId) as NotificationSettingsRow | undefined
  if (existing) return existing
  db.prepare(
    `INSERT INTO notification_settings
       (user_id, desktop_enabled, sound_enabled, show_preview, dm_level, group_level,
        dnd_enabled, dnd_start, dnd_end, timezone, updated_at)
     VALUES (?, 1, 1, 1, 'all', 'mentions', 0, '23:00', '08:00', 'Asia/Shanghai', ?)`,
  ).run(userId, now())
  return db
    .prepare('SELECT * FROM notification_settings WHERE user_id = ?')
    .get(userId) as NotificationSettingsRow
}

export function updateUserSettings(db: DB, userId: string, patch: Partial<UserSettings>): UserSettingsRow {
  const current = ensureUserSettings(db, userId)
  db.prepare(
    `UPDATE user_settings
     SET theme = ?, accent = ?, font_scale = ?, density = ?, send_key = ?, locale = ?,
         reduce_motion = ?, updated_at = ?
     WHERE user_id = ?`,
  ).run(
    patch.theme ?? current.theme,
    patch.accent ?? current.accent,
    patch.fontScale ?? current.font_scale,
    patch.density ?? current.density,
    patch.sendKey ?? current.send_key,
    patch.locale ?? current.locale,
    patch.reduceMotion === undefined ? current.reduce_motion : patch.reduceMotion ? 1 : 0,
    now(),
    userId,
  )
  return ensureUserSettings(db, userId)
}

export function updateNotificationSettings(
  db: DB,
  userId: string,
  patch: Partial<NotificationSettings>,
): NotificationSettingsRow {
  const current = ensureNotificationSettings(db, userId)
  const bool = (v: boolean | undefined, fallback: number): number =>
    v === undefined ? fallback : v ? 1 : 0

  db.prepare(
    `UPDATE notification_settings
     SET desktop_enabled = ?, sound_enabled = ?, show_preview = ?, dm_level = ?, group_level = ?,
         dnd_enabled = ?, dnd_start = ?, dnd_end = ?, timezone = ?, updated_at = ?
     WHERE user_id = ?`,
  ).run(
    bool(patch.desktopEnabled, current.desktop_enabled),
    bool(patch.soundEnabled, current.sound_enabled),
    bool(patch.showPreview, current.show_preview),
    patch.dmLevel ?? current.dm_level,
    patch.groupLevel ?? current.group_level,
    bool(patch.dndEnabled, current.dnd_enabled),
    patch.dndStart ?? current.dnd_start,
    patch.dndEnd ?? current.dnd_end,
    patch.timezone ?? current.timezone,
    now(),
    userId,
  )
  return ensureNotificationSettings(db, userId)
}
