import { env } from '../env'
import { one, run, type DB, type Executor } from '../db'
import { now } from '../util/clock'

/**
 * 服务器级运行时配置。
 *
 * server_settings 表早于管理面板建好但一直没有读写方，这里把它扶正：
 * DB 值优先，env 作为兜底与初始值——没在面板里改过的配置行为与旧版完全一致。
 * 值统一 JSON 编码存储（与 0001 迁移的种子数据 '"NenoChat"' 约定一致）。
 */

const KEY_SERVER_NAME = 'server_name'
const KEY_REGISTRATION_MODE = 'registration_mode'
const KEY_SHARED_AI_MODE = 'ai_shared_mode'
const KEY_AI_RECHARGE_URL = 'ai_recharge_url'

export type RegistrationMode = 'open' | 'invite' | 'closed'

export const REGISTRATION_MODES: readonly RegistrationMode[] = ['open', 'invite', 'closed']

/** 种子行（0001 迁移）updated_at=0 表示出厂默认、从未被面板改过，读取时当作不存在 */
const SEED_SENTINEL_TS = 0

async function readRaw(db: Executor, key: string): Promise<string | undefined> {
  const row = await one<{ value: string; updated_at: number }>(
    db,
    'SELECT value, updated_at FROM server_settings WHERE key = ?',
    [key],
  )
  if (!row || row.updated_at === SEED_SENTINEL_TS) return undefined
  try {
    return JSON.parse(row.value) as string
  } catch {
    return undefined
  }
}

export async function writeRaw(db: Executor, key: string, value: string): Promise<void> {
  // INSERT OR UPDATE：键存在时更新值与时间戳
  await run(
    db,
    `INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), now()],
  )
}

/** 服务器显示名：面板改过则以面板为准，否则回落 env */
export async function getServerName(db: DB): Promise<string> {
  const raw = await readRaw(db, KEY_SERVER_NAME)
  const name = typeof raw === 'string' ? raw.trim() : ''
  return name.length > 0 ? name : env.SERVER_NAME
}

export async function getRegistrationMode(db: DB): Promise<RegistrationMode> {
  const raw = await readRaw(db, KEY_REGISTRATION_MODE)
  if (raw && (REGISTRATION_MODES as readonly string[]).includes(raw)) return raw as RegistrationMode
  return env.REGISTRATION_MODE
}

export async function setServerName(db: DB, name: string): Promise<void> {
  await writeRaw(db, KEY_SERVER_NAME, name)
}

export async function setRegistrationMode(db: DB, mode: RegistrationMode): Promise<void> {
  await writeRaw(db, KEY_REGISTRATION_MODE, mode)
}

/** 全服共享 AI 模式：开启后成员没配供应商时回退到服务器供应商并计费扣余额 */
export async function getSharedAiMode(db: Executor): Promise<boolean> {
  const row = await one<{ value: string }>(db, 'SELECT value FROM server_settings WHERE key = ?', [
    KEY_SHARED_AI_MODE,
  ])
  if (!row) return false
  try {
    return JSON.parse(row.value) === true
  } catch {
    return false
  }
}

export async function setSharedAiMode(db: DB, enabled: boolean): Promise<void> {
  await run(
    db,
    `INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [KEY_SHARED_AI_MODE, JSON.stringify(enabled), now()],
  )
}

/** 充值链接：客户端余额区的「充值」按钮跳转目标；空串/未配置表示没有充值入口 */
export async function getAiRechargeUrl(db: Executor): Promise<string> {
  const row = await one<{ value: string }>(db, 'SELECT value FROM server_settings WHERE key = ?', [
    KEY_AI_RECHARGE_URL,
  ])
  if (!row) return ''
  try {
    const parsed: unknown = JSON.parse(row.value)
    return typeof parsed === 'string' ? parsed : ''
  } catch {
    return ''
  }
}

export async function setAiRechargeUrl(db: DB, url: string): Promise<void> {
  await writeRaw(db, KEY_AI_RECHARGE_URL, url)
}
