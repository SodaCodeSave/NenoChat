#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/** 读取当前提交的 tag 与 hash 状态 */
export function readGitInfo(run = git) {
  const exactTagRaw = run(['describe', '--tags', '--exact-match', 'HEAD'])
  const shortHash = (run(['rev-parse', '--short', 'HEAD']) || '').trim() || 'unknown'
  const nearestTagRaw = run(['describe', '--tags', '--abbrev=0'])
  const latestTagRaw = nearestTagRaw || run(['tag', '--list', '--sort=-v:refname']).split('\n')[0] || ''
  const strip = (tag) => tag.replace(/^v/, '').trim()

  return {
    exactTag: exactTagRaw ? strip(exactTagRaw) : '',
    latestTag: latestTagRaw ? strip(latestTagRaw) : '',
    shortHash,
  }
}

/**
 * 根据 git 状态推导各处使用的版本号。
 * 优先级：环境变量 > 当前 tag > 短 hash；最低客户端版本无 tag 时沿用最近 tag。
 */
export function resolveVersion({ env = {}, gitInfo = readGitInfo() } = {}) {
  const envApp = String(env.APP_VERSION || '').trim()
  const envMin = String(env.MIN_CLIENT_VERSION || '').trim()
  const { exactTag, latestTag, shortHash } = gitInfo

  const appVersion = envApp || exactTag || shortHash
  const minClientVersion = envMin || exactTag || latestTag || appVersion
  const packageVersion = SEMVER_RE.test(appVersion) ? appVersion : `0.0.0-${appVersion}`

  return {
    appVersion,
    minClientVersion,
    packageVersion,
    shortHash,
    exactTag,
    latestTag,
  }
}

const FIELDS = [
  'appVersion',
  'minClientVersion',
  'packageVersion',
  'shortHash',
  'exactTag',
  'latestTag',
]

function main() {
  const args = process.argv.slice(2)
  const version = resolveVersion()

  if (args[0] === '--get') {
    const field = args[1]
    if (!FIELDS.includes(field)) {
      console.error(`未知字段: ${field}。可选: ${FIELDS.join(', ')}`)
      process.exit(1)
    }
    process.stdout.write(version[field])
    return
  }

  if (args[0] === '--export') {
    process.stdout.write(
      `APP_VERSION=${version.appVersion}\n` +
      `MIN_CLIENT_VERSION=${version.minClientVersion}\n` +
      `PACKAGE_VERSION=${version.packageVersion}\n`,
    )
    return
  }

  process.stdout.write(JSON.stringify(version, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
