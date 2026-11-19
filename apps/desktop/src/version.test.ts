import { describe, expect, it } from 'vitest'
import { CLIENT_VERSION } from './version'

describe('CLIENT_VERSION', () => {
  it('是由构建注入的非空版本号', () => {
    expect(typeof CLIENT_VERSION).toBe('string')
    expect(CLIENT_VERSION.length).toBeGreaterThan(0)
  })
})
