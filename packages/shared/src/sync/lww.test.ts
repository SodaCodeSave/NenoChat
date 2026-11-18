import { describe, expect, it } from 'vitest'
import {
  CLOCK_SKEW_TOLERANCE_MS,
  TOMBSTONE_TTL_MS,
  clampClientTime,
  fieldMerge,
  resolveLww,
} from './lww'

describe('resolveLww', () => {
  it('本地不存在时直接应用', () => {
    expect(resolveLww(null, { updatedAt: 1 })).toBe('apply')
    expect(resolveLww(undefined, { updatedAt: 1 })).toBe('apply')
  })

  it('updatedAt 大者胜出', () => {
    expect(resolveLww({ updatedAt: 10 }, { updatedAt: 11 })).toBe('apply')
    expect(resolveLww({ updatedAt: 10 }, { updatedAt: 9 })).toBe('skip')
  })

  it('时间相等时用设备字典序决胜，保证多端收敛', () => {
    const a = { updatedAt: 10, updatedByDevice: 'dev-a' }
    const b = { updatedAt: 10, updatedByDevice: 'dev-b' }
    expect(resolveLww(a, b)).toBe('apply')
    expect(resolveLww(b, a)).toBe('skip')
  })

  it('时间相等且都无设备号时应用（后到覆盖）', () => {
    expect(resolveLww({ updatedAt: 10 }, { updatedAt: 10 })).toBe('apply')
  })
})

describe('fieldMerge', () => {
  it('只覆盖显式出现的字段', () => {
    const merged = fieldMerge({ a: 1, b: 2 }, { a: 9 })
    expect(merged).toEqual({ a: 9, b: 2 })
  })

  it('undefined 不参与覆盖', () => {
    const merged = fieldMerge({ a: 1, b: 2 }, { a: undefined, b: 5 })
    expect(merged).toEqual({ a: 1, b: 5 })
  })

  it('null 作为显式值覆盖', () => {
    const local: { a: number | null } = { a: 1 }
    const merged = fieldMerge(local, { a: null })
    expect(merged.a).toBeNull()
  })

  it('不修改原对象', () => {
    const local = { a: 1 }
    fieldMerge(local, { a: 9 })
    expect(local.a).toBe(1)
  })
})

describe('clampClientTime', () => {
  it('容差内的时间保持不变', () => {
    expect(clampClientTime(1000 + 100, 1000)).toBe(1100)
    expect(clampClientTime(1000 - 100, 1000)).toBe(900)
  })

  it('超出上界钳到上界', () => {
    expect(clampClientTime(1000 + CLOCK_SKEW_TOLERANCE_MS + 1, 1000)).toBe(1000 + CLOCK_SKEW_TOLERANCE_MS)
  })

  it('超出下界钳到下界', () => {
    expect(clampClientTime(1000 - CLOCK_SKEW_TOLERANCE_MS - 1, 1000)).toBe(1000 - CLOCK_SKEW_TOLERANCE_MS)
  })

  it('非法时间回退到服务端时间', () => {
    expect(clampClientTime(Number.NaN, 1000)).toBe(1000)
    expect(clampClientTime(Number.POSITIVE_INFINITY, 1000)).toBe(1000)
  })
})

describe('常量', () => {
  it('墓碑保留期为 30 天', () => {
    expect(TOMBSTONE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
