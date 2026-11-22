import { afterEach, describe, expect, it } from 'vitest'
import { randomId } from '@/stores/auth'

/**
 * 设备标识生成的上下文兼容性回归。
 * crypto.randomUUID 只在安全上下文（HTTPS/localhost）暴露；面板从局域网
 * 明文 HTTP 访问时 window.crypto 上没有它——曾直接调用导致登录页报
 * "crypto.randomUUID is not a function"，这里按三种真实环境钉死行为。
 */

const HEX_RE = /^[0-9a-f]{20,}$/

/** 临时替换全局 crypto，模拟目标运行环境 */
function withCrypto<T>(value: unknown, run: () => T): T {
  const original = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', {
    value,
    configurable: true,
    writable: true,
  })
  try {
    return run()
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      value: original,
      configurable: true,
      writable: true,
    })
  }
}

afterEach(() => {
  withCrypto(undefined, () => undefined)
})

describe('设备标识生成（安全上下文兼容）', () => {
  it('安全上下文：randomUUID 可用时正常生成', () => {
    const id = withCrypto(globalThis.crypto, () => randomId())
    expect(id).toMatch(HEX_RE)
  })

  it('非安全上下文（局域网 HTTP）：只有 getRandomValues 也能生成', () => {
    // 复刻 http://192.168.x.x 下的 window.crypto：没有 randomUUID/subtle
    const real = globalThis.crypto
    const insecure = {
      getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes),
    }
    const id = withCrypto(insecure, () => randomId())
    expect(id).toMatch(HEX_RE)
  })

  it('crypto 不可用：时间+随机兜底仍可用且不重复', () => {
    const a = withCrypto(undefined, () => randomId())
    const b = withCrypto(undefined, () => randomId())
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('getRandomValues 抛异常时降级到时间兜底', () => {
    const throwing = {
      getRandomValues: () => {
        throw new Error('blocked')
      },
    }
    const id = withCrypto(throwing, () => randomId())
    expect(id).toBeTruthy()
  })
})
