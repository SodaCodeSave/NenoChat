import { Client } from 'pg'

/** 端口通过环境变量从 globalSetup 传给 worker 进程；没设置时用默认端口 */
export const TEST_PG_PORT_ENV = 'NENOCHAT_TEST_PG_PORT'
/** 首选端口；被无关进程占用时 globalSetup 会换备用端口并写进环境变量 */
export const preferredPgPort = (): number => 54329

/** 当前测试 PG 的端口：globalSetup 已解析并写入环境变量 */
export function testPgPort(): number {
  const raw = Number(process.env[TEST_PG_PORT_ENV])
  return Number.isInteger(raw) && raw > 0 ? raw : preferredPgPort()
}

/** 测试专用 PG 连接串：port 缺省取解析后的端口，db 缺省连 postgres 管理库 */
export function pgUrl(db = 'postgres', port = testPgPort()): string {
  return `postgres://postgres:password@127.0.0.1:${port}/${db}`
}

/** 由测试文件路径派生独立数据库名，全局 setup 按同样规则批量建库 */
export function testDatabaseName(importMetaUrl: string): string {
  const file = importMetaUrl.split(/[\\/]/).pop() ?? 'test'
  const name = file.replace(/\W+/g, '_').replace(/_ts$/, '').replace(/_+$/, '')
  return `nenochat_test_${name}`
}

/** 为当前测试文件写入独立的 DATABASE_URL（同步、必须在 import src 模块之前调用） */
export function testDatabaseUrl(importMetaUrl: string): string {
  const url = pgUrl(testDatabaseName(importMetaUrl))
  process.env.DATABASE_URL = url
  return url
}

/** 兜底建库：globalSetup 已批量创建，重复 CREATE 时吞掉 duplicate 错误 */
export async function ensureTestDatabase(importMetaUrl: string): Promise<void> {
  const name = testDatabaseName(importMetaUrl)
  const client = new Client({ connectionString: pgUrl() })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE "${name}"`)
  } catch (e) {
    if ((e as { code?: string }).code !== '42P04') throw e
  } finally {
    await client.end()
  }
}
