import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_CHECK_INTERVAL_MS,
  compareSemver,
  readLastCheck,
  shouldCheckNow,
  updateSupported,
  writeLastCheck,
} from './update-check'

describe('compareSemver', () => {
  it('逐段比较主次与修订号', () => {
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1)
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0)
    expect(compareSemver('0.1.2', '0.1.10')).toBe(-1)
  })

  it('容忍 v 前缀与预发布后缀', () => {
    expect(compareSemver('v0.2.0', '0.1.0')).toBe(1)
    expect(compareSemver('0.2.0-beta.1', '0.1.0')).toBe(1)
  })

  it('段数不同时缺失段按 0 补齐', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
    expect(compareSemver('1', '0.9.9')).toBe(1)
  })
})

describe('shouldCheckNow', () => {
  it('从未检查过时需要检查', () => {
    expect(shouldCheckNow(null, Date.now())).toBe(true)
  })

  it('间隔内不重复检查，超间隔后重新检查', () => {
    const now = 1_000_000_000
    expect(shouldCheckNow(now - AUTO_CHECK_INTERVAL_MS + 60_000, now)).toBe(false)
    expect(shouldCheckNow(now - AUTO_CHECK_INTERVAL_MS - 1, now)).toBe(true)
  })

  it('支持自定义间隔', () => {
    const now = 2_000_000
    expect(shouldCheckNow(now - 3_599_999, now, 3_600_000)).toBe(false)
    expect(shouldCheckNow(now - 3_600_000, now, 3_600_000)).toBe(true)
  })
})

describe('updateSupported', () => {
  it('只在 Tauri 桌面端生效', () => {
    expect(updateSupported(true, 'win32')).toBe(true)
    expect(updateSupported(true, 'linux')).toBe(true)
    expect(updateSupported(true, 'darwin')).toBe(true)
    expect(updateSupported(false, 'win32')).toBe(false)
    expect(updateSupported(true, 'android')).toBe(false)
    expect(updateSupported(true, 'ios')).toBe(false)
    expect(updateSupported(false, 'web')).toBe(false)
  })
})

describe('lastCheck 持久化', () => {
  beforeEach(() => {
    // node 测试环境没有 localStorage，补一个最简实现
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('写入后能读回时间戳', () => {
    writeLastCheck(123456789)
    expect(readLastCheck()).toBe(123456789)
  })

  it('没有记录时返回 null', () => {
    expect(readLastCheck()).toBeNull()
  })
})
