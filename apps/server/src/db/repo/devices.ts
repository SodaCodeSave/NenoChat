import type { Device } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

export interface DeviceRow {
  id: string
  user_id: string
  name: string
  platform: string
  app_version: string | null
  created_at: number
  last_active_at: number | null
}

export function mapDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    platform: row.platform,
    appVersion: row.app_version,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  }
}

export interface DeviceUpsert {
  id: string
  name: string
  platform: string
  appVersion?: string | undefined
}

export function upsert(db: DB, userId: string, device: DeviceUpsert): void {
  const ts = now()
  db.prepare(
    `INSERT INTO devices (id, user_id, name, platform, app_version, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       name = excluded.name,
       platform = excluded.platform,
       app_version = excluded.app_version,
       last_active_at = excluded.last_active_at`,
  ).run(device.id, userId, device.name, device.platform, device.appVersion ?? null, ts, ts)
}

export function list(db: DB, userId: string): DeviceRow[] {
  return db
    .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_active_at DESC')
    .all(userId) as DeviceRow[]
}

/** 仅刷新活跃时间，不改设备名 */
export function touch(db: DB, userId: string, deviceId: string): void {
  db.prepare('UPDATE devices SET last_active_at = ? WHERE user_id = ? AND id = ?').run(
    now(),
    userId,
    deviceId,
  )
}

export function remove(db: DB, userId: string, deviceId: string): void {
  db.prepare('DELETE FROM devices WHERE user_id = ? AND id = ?').run(userId, deviceId)
}
