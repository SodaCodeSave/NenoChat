import { describe, expect, it } from 'vitest'
import { readGitInfo, resolveVersion } from '../../../scripts/version.mjs'

describe('resolveVersion', () => {
  const onTag = { exactTag: '0.2.0', latestTag: '0.2.0', shortHash: 'abc1234' }
  const offTag = { exactTag: '', latestTag: '0.2.0', shortHash: '5907354' }
  const noTag = { exactTag: '', latestTag: '', shortHash: 'abc1234' }

  it('在 tag 上时各处版本均取纯 tag（去除 v 前缀）', () => {
    const v = resolveVersion({ gitInfo: onTag })
    expect(v.appVersion).toBe('0.2.0')
    expect(v.minClientVersion).toBe('0.2.0')
    expect(v.packageVersion).toBe('0.2.0')
  })

  it('无 tag 时应用版本用「v + 最近 tag - 短 hash」，最低客户端版本沿用最近 tag', () => {
    const v = resolveVersion({ gitInfo: offTag })
    expect(v.appVersion).toBe('v0.2.0-5907354')
    expect(v.minClientVersion).toBe('0.2.0')
    expect(v.packageVersion).toBe('0.2.0-5907354')
  })

  it('完全没有 tag 时最低客户端版本回退到应用版本', () => {
    const v = resolveVersion({ gitInfo: noTag })
    expect(v.appVersion).toBe('abc1234')
    expect(v.minClientVersion).toBe('abc1234')
  })

  it('环境变量覆盖 git 推导结果', () => {
    const v = resolveVersion({
      env: { APP_VERSION: '1.2.3', MIN_CLIENT_VERSION: '1.0.0' },
      gitInfo: offTag,
    })
    expect(v.appVersion).toBe('1.2.3')
    expect(v.minClientVersion).toBe('1.0.0')
    expect(v.packageVersion).toBe('1.2.3')
  })

  it('环境变量给非 semver 的应用版本时包版本补 0.0.0- 前缀', () => {
    const v = resolveVersion({ env: { APP_VERSION: 'deadbeef' }, gitInfo: offTag })
    expect(v.packageVersion).toBe('0.0.0-deadbeef')
  })

  it('环境变量值为空白时忽略', () => {
    const v = resolveVersion({ env: { APP_VERSION: '   ', MIN_CLIENT_VERSION: '' }, gitInfo: onTag })
    expect(v.appVersion).toBe('0.2.0')
    expect(v.minClientVersion).toBe('0.2.0')
  })
})

describe('readGitInfo', () => {
  it('用注入的 git 执行器解析 tag 与 hash', () => {
    const run = (args: string[]) => {
      if (args.includes('--exact-match')) return 'v1.5.0\n'
      if (args.includes('--abbrev=0')) return 'v1.5.0\n'
      if (args[1] === '--short') return 'f00ba12\n'
      return ''
    }
    expect(readGitInfo(run)).toEqual({ exactTag: '1.5.0', latestTag: '1.5.0', shortHash: 'f00ba12' })
  })

  it('git 命令失败时返回空 tag 与 unknown hash', () => {
    expect(readGitInfo(() => '')).toEqual({ exactTag: '', latestTag: '', shortHash: 'unknown' })
  })
})
