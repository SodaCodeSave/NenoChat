import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  buildBackup,
  parseBackup,
  retargetBackup,
  summarizeBackup,
} from './backup'
import { DEFAULT_CACHE_POLICY, normalizeCachePolicy, planCacheEviction } from './cache-policy'
import { buildStorageReport, formatBytes } from './stats'
import type { CachedFileMeta } from './types'

const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

function meta(key: string, overrides: Partial<CachedFileMeta> = {}): CachedFileMeta {
  return {
    key,
    namespace: 'http://localhost:8787',
    path: `/files/files/ab/cd/${key}.png`,
    kind: 'image',
    size: 10 * MB,
    storedAt: 1_000,
    accessedAt: 1_000,
    ...overrides,
  }
}

describe('formatBytes', () => {
  it('按量级选择单位并去掉多余的零', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-10)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12.5 * MB)).toBe('12.5 MB')
    expect(formatBytes(2048 * MB)).toBe('2 GB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('buildStorageReport', () => {
  it('按类别汇总镜像与缓存，并保证总和一致', () => {
    const report = buildStorageReport({
      mirror: { dbBytes: 100 * MB, messageBytes: 40 * MB, messageCount: 120, otherCount: 8 },
      cache: [
        { kind: 'image', size: 10 * MB },
        { kind: 'avatar', size: 2 * MB },
        { kind: 'file', size: 5 * MB },
        { kind: 'sticker', size: 3 * MB },
      ],
      now: 42,
    })

    expect(report.mirrorBytes).toBe(100 * MB)
    expect(report.cacheBytes).toBe(20 * MB)
    expect(report.totalBytes).toBe(120 * MB)
    expect(report.generatedAt).toBe(42)

    const category = (key: string) => {
      const found = report.categories.find((item) => item.key === key)
      if (!found) throw new Error(`缺少分类 ${key}`)
      return found
    }
    expect(category('messages').bytes).toBe(40 * MB)
    expect(category('messages').items).toBe(120)
    expect(category('images').bytes).toBe(12 * MB)
    expect(category('images').items).toBe(2)
    expect(category('files').bytes).toBe(5 * MB)
    expect(category('stickers').bytes).toBe(3 * MB)
    expect(category('other').bytes).toBe(60 * MB)
    expect(category('other').items).toBe(8)

    const sum = report.categories.reduce((acc, c) => acc + c.bytes, 0)
    expect(sum).toBe(report.totalBytes)
  })

  it('拿不到数据库占用时至少保留消息与缓存', () => {
    const report = buildStorageReport({
      mirror: { dbBytes: 0, messageBytes: 8 * MB, messageCount: 3, otherCount: 0 },
      cache: [{ kind: 'file', size: 2 * MB }],
      now: 1,
    })
    expect(report.mirrorBytes).toBe(8 * MB)
    expect(report.totalBytes).toBe(10 * MB)
  })
})

describe('normalizeCachePolicy', () => {
  it('缺省与非法值回退到默认策略', () => {
    expect(normalizeCachePolicy(undefined)).toEqual(DEFAULT_CACHE_POLICY)
    expect(normalizeCachePolicy({ maxBytes: Number.NaN })).toEqual(DEFAULT_CACHE_POLICY)
  })

  it('过小的上限被抬到下限，0 表示不限制', () => {
    expect(normalizeCachePolicy({ maxBytes: 1024 }).maxBytes).toBe(16 * MB)
    expect(normalizeCachePolicy({ maxBytes: 0 }).maxBytes).toBe(0)
    expect(normalizeCachePolicy({ maxBytes: 9999 * MB }).maxBytes).toBe(8192 * MB)
  })

  it('过期时间 0 表示永不过期', () => {
    expect(normalizeCachePolicy({ maxAgeMs: 0 }).maxAgeMs).toBe(0)
    expect(normalizeCachePolicy({ maxAgeMs: -1 }).maxAgeMs).toBe(0)
    expect(normalizeCachePolicy({ maxAgeMs: 999 * DAY }).maxAgeMs).toBe(365 * DAY)
  })
})

describe('planCacheEviction', () => {
  it('先淘汰闲置过期的条目', () => {
    const now = 100 * DAY
    const plan = planCacheEviction(
      [
        meta('fresh', { accessedAt: now - DAY, storedAt: now - DAY }),
        meta('stale', { accessedAt: now - 40 * DAY, storedAt: now - 40 * DAY }),
      ],
      { maxBytes: 0, maxAgeMs: 30 * DAY },
      now,
    )
    expect(plan.evict).toEqual(['stale'])
    expect(plan.expired).toBe(1)
    expect(plan.kept).toBe(1)
  })

  it('超出容量时按最久未访问淘汰', () => {
    const now = 10 * DAY
    const plan = planCacheEviction(
      [
        meta('a', { size: 10 * MB, accessedAt: now - 3 * DAY, storedAt: now - 3 * DAY }),
        meta('b', { size: 10 * MB, accessedAt: now - DAY, storedAt: now - DAY }),
        meta('c', { size: 10 * MB, accessedAt: now, storedAt: now }),
      ],
      { maxBytes: 25 * MB, maxAgeMs: 30 * DAY },
      now,
    )
    expect(plan.evict).toEqual(['a'])
    expect(plan.keptBytes).toBe(20 * MB)
    expect(plan.freedBytes).toBe(10 * MB)
  })

  it('总量在上限内时什么也不做，且不修改入参', () => {
    const entries = [meta('a'), meta('b')]
    const snapshot = JSON.parse(JSON.stringify(entries))
    const plan = planCacheEviction(entries, { maxBytes: 100 * MB, maxAgeMs: 30 * DAY }, 2_000)
    expect(plan.evict).toEqual([])
    expect(plan.kept).toBe(2)
    expect(entries).toEqual(snapshot)
  })
})

describe('备份文件', () => {
  const server = { id: 'srv-1', name: '我的服务器', baseUrl: 'http://localhost:8787' }

  it('构建时只保留白名单列，并过滤未知表', () => {
    const backup = buildBackup({
      server,
      now: 123,
      appVersion: '0.1.0',
      tables: {
        messages: [
          { server_id: 'srv-1', id: 'm1', content: '你好', seq: 1, hacked: 'x' },
          { server_id: 'srv-1', id: 'm2', content: '晚安', seq: 2, pinned_at: null },
        ],
        unknown_table: [{ id: 'x' }],
      },
      preferences: { 'nenochat.theme': 'dark', 'other.key': 'ignored' },
    })

    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(backup.version).toBe(BACKUP_VERSION)
    expect(backup.exportedAt).toBe(123)
    expect(backup.tables.messages).toHaveLength(2)
    expect(backup.tables.messages?.[0]).not.toHaveProperty('hacked')
    expect(backup.tables).not.toHaveProperty('unknown_table')
    expect(backup.preferences).toEqual({ 'nenochat.theme': 'dark' })
  })

  it('解析备份并生成摘要', () => {
    const backup = buildBackup({
      server,
      tables: {
        messages: [{ server_id: 'srv-1', id: 'm1', content: 'hi', seq: 1 }],
        conversations: [{ server_id: 'srv-1', id: 'c1', type: 'direct' }],
        drafts: [{ server_id: 'srv-1', conversation_id: 'c1', channel_id: '', content: '草稿' }],
      },
    })

    const parsed = parseBackup(JSON.stringify(backup))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(summarizeBackup(parsed.backup)).toEqual({
      messages: 1,
      conversations: 1,
      members: 0,
      users: 0,
      notifications: 0,
      drafts: 1,
      totalRows: 3,
    })
  })

  it('拒绝非 JSON、错误格式与更高版本', () => {
    expect(parseBackup('not json').ok).toBe(false)
    expect(parseBackup(JSON.stringify({ format: 'other' })).ok).toBe(false)

    const future = buildBackup({ server, tables: { messages: [{ server_id: 'srv-1', id: 'm1' }] } })
    future.version = BACKUP_VERSION + 1
    const result = parseBackup(JSON.stringify(future))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('更高版本')
  })

  it('导入时把 server_id 改写为目标服务器', () => {
    const backup = buildBackup({
      server,
      tables: {
        messages: [{ server_id: 'srv-1', id: 'm1', content: 'hi' }],
        app_settings: [{ server_id: 'srv-1', key: 'k', value: 'v' }],
      },
    })
    const retargeted = retargetBackup(backup, 'srv-2')
    expect(retargeted.tables.messages?.[0]?.server_id).toBe('srv-2')
    expect(retargeted.tables.app_settings?.[0]?.server_id).toBe('srv-2')
  })

  it('生成安全且带时间戳的文件名', () => {
    expect(backupFileName('我的/服务器?: 1', new Date(2026, 10, 17, 15, 30))).toBe(
      '我的_服务器_1-备份-20261117-1530.json',
    )
    expect(backupFileName('   ', new Date(2026, 0, 2, 3, 4))).toBe('NenoChat-备份-20260102-0304.json')
  })
})
