import { describe, expect, it } from 'vitest'

/**
 * 迁移一致性回归：SQL 文本会被 include_str! 编进二进制并参与 sqlx 校验和，
 * 任何字节变化（行尾、漏注册）都会让已经跑过的本地库在启动时直接崩溃。
 */
const rawMigrations = import.meta.glob('../../src-tauri/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const dbSource = Object.values(
  import.meta.glob('../../src-tauri/src/db.rs', { query: '?raw', import: 'default', eager: true }),
)[0] as string

const migrationFiles = Object.entries(rawMigrations).sort(([a], [b]) => a.localeCompare(b))
const registeredVersions = new Set(
  Array.from(dbSource.matchAll(/version:\s*(\d+)/g), (match) => Number(match[1])),
)

const versionOf = (path: string): number => Number(/(\d{4})_[^/]+\.sql$/.exec(path)?.[1])

describe('本地镜像库迁移', () => {
  it('磁盘上的每个迁移文件都在 db.rs 里注册', () => {
    expect(migrationFiles.length).toBeGreaterThan(0)
    const missing = migrationFiles
      .filter(([path]) => !registeredVersions.has(versionOf(path)))
      .map(([path]) => path.split('/').pop())
    expect(missing, `未注册的迁移：${missing.join(', ')}`).toEqual([])
  })

  it('迁移 SQL 必须是纯 LF，不能被检出成 CRLF', () => {
    const polluted = migrationFiles
      .filter(([, sql]) => sql.includes('\r\n'))
      .map(([path]) => path.split('/').pop())
    expect(polluted, `含 CRLF 的迁移：${polluted.join(', ')}`).toEqual([])
  })
})
