import type { Device } from '@nenochat/shared'
import { all, run, type Executor } from '../index'
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

export async function upsert(db: Executor, userId: string, device: DeviceUpsert): Promise<void> {
  const ts = now()
  await run(
    db,
    `INSERT INTO devices (id, user_id, name, platform, app_version, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       name = excluded.name,
       platform = excluded.platform,
       app_version = excluded.app_version,
       last_active_at = excluded.last_active_at`,
    [device.id, userId, device.name, device.platform, device.appVersion ?? null, ts, ts],
  )
}

export async function list(db: Executor, userId: string): Promise<DeviceRow[]> {
  return all<DeviceRow>(db, 'SELECT * FROM devices WHERE user_id = ? ORDER BY last_active_at DESC', [
    userId,
  ])
}

/** 仅刷新活跃时间，不改设备名 */
export async function touch(db: Executor, userId: string, deviceId: string): Promise<void> {
  await run(db, 'UPDATE devices SET last_active_at = ? WHERE user_id = ? AND id = ?', [
    now(),
    userId,
    deviceId,
  ])
}

export async function remove(db: Executor, userId: string, deviceId: string): Promise<void> {
  await run(db, 'DELETE FROM devices WHERE user_id = ? AND id = ?', [userId, deviceId])
}
