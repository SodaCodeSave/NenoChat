import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readdirSync } from 'node:fs'
import { Client } from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { testDatabaseName, TEST_PG_PORT_ENV, preferredPgPort, pgUrl } from './helpers/pg'

/**
 * 全局测试数据库：整个 vitest 进程拉起一个内嵌 PostgreSQL，
 * 为每个测试文件预创建独立数据库实现隔离（文件之间互不可见对方的库）。
 *
 * 端口选择：首选 54329；被占用时先探测那是不是一个可连的 PG（外部启动的实例，直接复用），
 * 连不上就说明是普通进程碰巧占了端口（Windows 动态端口范围覆盖 54329，出站连接可能随机撞上），
 * 换备用端口拉内嵌 PG，并通过环境变量把端口传给各 worker 进程。
 */

const PG_DATA = path.join(os.tmpdir(), 'nenochat-vitest-pg')
/** 首选端口被普通进程占用时，从这里开始找空闲端口 */
const FALLBACK_PORTS = [54330, 54331, 54332, 54333, 54334]

let activePort = preferredPgPort()

export async function setup(): Promise<void> {
  const preferred = preferredPgPort()
  if (!(await isPortFree(preferred))) {
    if (await isPgAlive(pgUrl('postgres', preferred))) {
      // 外部已启动的测试 PG，直接复用
      activePort = preferred
      process.env[TEST_PG_PORT_ENV] = String(activePort)
      return
    }
    // 端口被无关进程占着，换备用端口
    for (const port of FALLBACK_PORTS) {
      if (await isPortFree(port)) {
        activePort = port
        break
      }
    }
  } else {
    activePort = preferred
  }

  // 把解析出的端口写进环境变量：worker 进程在 setup 之后才 fork，能继承到
  process.env[TEST_PG_PORT_ENV] = String(activePort)

  // 上次异常退出可能残留数据目录，initdb 不接受非空目录
  fs.rmSync(PG_DATA, { recursive: true, force: true })

  const pg = new EmbeddedPostgres({
    databaseDir: PG_DATA,
    user: 'postgres',
    password: 'password',
    port: activePort,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()

  // 把全局实例挂到全局对象上，teardown 阶段再取回来关闭
  ;(globalThis as Record<string, unknown>).__testPg = pg

  // 为每个测试文件预建独立数据库
  const client = new Client({ connectionString: pgUrl('postgres', activePort) })
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

/** 端口上有东西时再探一层：能真正建立 PG 连接才算「外部测试 PG 已就绪」 */
async function isPgAlive(baseUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 2000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}
