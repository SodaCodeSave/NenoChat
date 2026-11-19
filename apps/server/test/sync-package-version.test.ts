import { describe, expect, it } from 'vitest'
import {
  replaceCargoLockVersion,
  replaceJsonVersion,
  replaceTomlVersion,
} from '../../../scripts/sync-package-version.mjs'

describe('replaceJsonVersion', () => {
  it('替换首个 version 字段并保留其余内容', () => {
    const src = '{\n  "name": "x",\n  "version": "0.1.0",\n  "private": true\n}\n'
    expect(replaceJsonVersion(src, '1.2.3')).toContain('"version": "1.2.3"')
    expect(replaceJsonVersion(src, '1.2.3')).toContain('"private": true')
  })

  it('没有 version 字段时报错', () => {
    expect(() => replaceJsonVersion('{"name":"x"}', '1.2.3')).toThrow('未找到 version 字段')
  })
})

describe('replaceTomlVersion', () => {
  it('只替换 [package] 段的 version', () => {
    const src = '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\ntauri = { version = "2" }\n'
    const out = replaceTomlVersion(src, '0.0.0-abc1234')
    expect(out).toContain('version = "0.0.0-abc1234"')
    expect(out).toContain('tauri = { version = "2" }')
  })

  it('没有 [package].version 时报错', () => {
    expect(() => replaceTomlVersion('[dependencies]\ntauri = "2"\n', '1.0.0')).toThrow(
      '未找到 [package].version 字段',
    )
  })
})

describe('replaceCargoLockVersion', () => {
  it('只替换根包 nenochat 的版本', () => {
    const src = '[[package]]\nname = "nenochat"\nversion = "0.1.0"\n\n[[package]]\nname = "other"\nversion = "9.9.9"\n'
    const out = replaceCargoLockVersion(src, '0.2.0')
    expect(out).toContain('name = "nenochat"\nversion = "0.2.0"')
    expect(out).toContain('name = "other"\nversion = "9.9.9"')
  })

  it('兼容 CRLF 换行（Windows runner checkout 会把 Cargo.lock 转成 CRLF）', () => {
    const src = '[[package]]\r\nname = "nenochat"\r\nversion = "0.1.0"\r\n\r\n[[package]]\r\nname = "other"\r\nversion = "9.9.9"\r\n'
    const out = replaceCargoLockVersion(src, '0.2.0')
    expect(out).toContain('name = "nenochat"\r\nversion = "0.2.0"')
    expect(out).toContain('name = "other"\r\nversion = "9.9.9"')
  })

  it('没有根包条目时报错', () => {
    expect(() => replaceCargoLockVersion('[[package]]\nname = "other"\n', '1.0.0')).toThrow(
      '未找到 Cargo.lock 中 nenochat 版本',
    )
  })
})
