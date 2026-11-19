import { randomInt } from 'node:crypto'

/**
 * 手机接入配对码：电脑上的一次性口令，扫码后手机凭它换一份会话。
 * 只存在内存里，服务端重启即全部失效，避免长期有效的后门。
 */

/** 去掉容易看错的 0/O/1/I，扫码失败时用户还能手抄 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const TTL_MS = 5 * 60_000
/** 同时最多保留几个未使用的码，防止反复点「刷新」把内存撑满 */
const MAX_ACTIVE = 8

interface Entry {
  expiresAt: number
  used: boolean
}

const active = new Map<string, Entry>()

function sweep(now: number): void {
  for (const [code, entry] of active) {
    if (entry.used || entry.expiresAt <= now) active.delete(code)
  }
}

function generate(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(0, ALPHABET.length)]
  }
  return code
}

export interface PairingCode {
  code: string
  /** 过期时间戳 */
  expiresAt: number
}

/** 生成一个新的配对码 */
export function issueCode(now = Date.now()): PairingCode {
  sweep(now)
  if (active.size >= MAX_ACTIVE) {
    // 超出上限先丢掉最早过期的那个，保证新码一定可用
    const oldest = [...active.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
    if (oldest) active.delete(oldest[0])
  }
  const code = generate()
  const expiresAt = now + TTL_MS
  active.set(code, { expiresAt, used: false })
  return { code, expiresAt }
}

/** 校验并消费配对码；成功返回 true，一码只能用一次 */
export function consumeCode(code: string, now = Date.now()): boolean {
  sweep(now)
  const normalized = code.trim().toUpperCase()
  const entry = active.get(normalized)
  if (!entry || entry.used || entry.expiresAt <= now) return false
  entry.used = true
  active.delete(normalized)
  return true
}

/** 测试用：清空所有待用配对码 */
export function clearCodes(): void {
  active.clear()
}
