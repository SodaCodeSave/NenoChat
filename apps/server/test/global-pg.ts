import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readdirSync } from 'node:fs'
import { Client } from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { testDatabaseName } from './helpers/pg'

/**
 * 全局测试数据库：整个 vitest 进程拉起一个内嵌 PostgreSQL，
 * 为每个测试文件预创建独立数据库实现隔离（文件之间互不可见对方的库）。
 */

const PORT = 54329
const PG_DATA = path.join(os.tmpdir(), 'nenochat-vitest-pg')
const BASE_URL = `postgres://postgres:password@127.0.0.1:${PORT}/postgres`

export async function setup(): Promise<void> {
  // 端口已被占用时视为外部已启动的测试 PG，直接复用
  if (!(await isPortFree(PORT))) return

  // 上次异常退出可能残留数据目录，initdb 不接受非空目录
  fs.rmSync(PG_DATA, { recursive: true, force: true })

  const pg = new EmbeddedPostgres({
    databaseDir: PG_DATA,
    user: 'postgres',
    password: 'password',
    port: PORT,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()

  // 把全局实例挂到全局对象上，teardown 阶段再取回来关闭
  ;(globalThis as Record<string, unknown>).__testPg = pg

  // 为每个测试文件预建独立数据库
  const client = new Client({ connectionString: BASE_URL })
  await client.connect()
  const testDir = import.meta.dirname
  for (const file of readdirSync(testDir)) {
    if (!file.endsWith('.test.ts')) continue
    await client
      .query(`CREATE DATABASE "${testDatabaseName(path.join(testDir, file))}"`)
      .catch(() => undefined)
  }
  await client.end()
}

export async function teardown(): Promise<void> {
  const pg = (globalThis as Record<string, unknown>).__testPg as
    | { stop: () => Promise<void> }
    | undefined
  if (pg) await pg.stop()
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}
