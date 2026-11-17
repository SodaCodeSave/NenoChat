/**
 * ULID 生成：26 字符，前 10 位为时间戳（字典序即时间序），后 16 位随机。
 * 不依赖第三方库，浏览器与 Node 22 均有全局 crypto。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

let lastTime = -1
let lastRandom: number[] = []

function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b % 32)
}

/** 生成一个 ULID；同一毫秒内递增随机段，保证单调性 */
export function ulid(now: number = Date.now()): string {
  const time = Math.floor(now)
  if (time === lastTime && lastRandom.length === RANDOM_LEN) {
    // 同一毫秒：随机段自增，避免同毫秒 id 顺序错乱
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      if (lastRandom[i]! < 31) {
        lastRandom[i]! += 1
        break
      }
      lastRandom[i] = 0
    }
  } else {
    lastRandom = randomChars()
    lastTime = time
  }

  let timePart = ''
  let t = time
  for (let i = 0; i < TIME_LEN; i++) {
    timePart = ENCODING[t % 32] + timePart
    t = Math.floor(t / 32)
  }

  return timePart + lastRandom.map((n) => ENCODING[n]).join('')
}

/** 从 ULID 还原时间戳 */
export function ulidTime(id: string): number {
  if (id.length !== TIME_LEN + RANDOM_LEN) return 0
  let time = 0
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id[i]!)
    if (idx < 0) return 0
    time = time * 32 + idx
  }
  return time
}

/** 私聊会话唯一键：两个用户 id 排序后拼接，保证双向幂等 */
export function dmKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/** 客户端请求幂等标识 */
export function nonce(): string {
  return ulid()
}
