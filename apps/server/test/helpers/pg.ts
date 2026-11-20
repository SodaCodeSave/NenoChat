import { Client } from 'pg'

/** 测试专用 PG 基础连接串，与 test/global-pg.ts 保持一致 */
const BASE_URL = 'postgres://postgres:password@127.0.0.1:54329/postgres'

/** 由测试文件路径派生独立数据库名，全局 setup 按同样规则批量建库 */
export function testDatabaseName(importMetaUrl: string): string {
  const file = importMetaUrl.split(/[\\/]/).pop() ?? 'test'
  const name = file.replace(/\W+/g, '_').replace(/_ts$/, '').replace(/_+$/, '')
  return `nenochat_test_${name}`
}

/** 为当前测试文件写入独立的 DATABASE_URL（同步、必须在 import src 模块之前调用） */
export function testDatabaseUrl(importMetaUrl: string): string {
  const url = `postgres://postgres:password@127.0.0.1:54329/${testDatabaseName(importMetaUrl)}`
  process.env.DATABASE_URL = url
  return url
}

/** 兜底建库：globalSetup 已批量创建，重复 CREATE 时吞掉 duplicate 错误 */
export async function ensureTestDatabase(importMetaUrl: string): Promise<void> {
  const name = testDatabaseName(importMetaUrl)
  const client = new Client({ connectionString: BASE_URL })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE "${name}"`)
  } catch (e) {
    if ((e as { code?: string }).code !== '42P04') throw e
  } finally {
    await client.end()
  }
}
