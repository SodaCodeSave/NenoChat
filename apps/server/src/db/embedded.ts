// 一体版内嵌 PostgreSQL：安装包里没有独立数据库服务，DATABASE_URL 未设置时
// 在数据目录（DATA_DIR/pgdata）里拉起一份随应用分发的 PG 实例。
// persistent 保证重启后数据还在；实例只监听回环地址，口令随包分发无保密意义。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type EmbeddedPostgres from 'embedded-postgres'
import { dataDir } from './index'

let instance: EmbeddedPostgres | null = null

/** 取一个当前空闲的回环端口；绑完立刻释放，交给 postgres 去监听 */
function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 客户端退出走的是强杀，embedded-postgres 的退出钩子来不及执行，
 * 残留的 postgres 会锁住数据目录。通过 postmaster.pid 找到残留进程：
 * 先校验 PID 对应的确实是 postgres（防止 PID 被系统复用后误杀别的进程），
 * 再终结它并清掉过期的 pid 文件。PG 自己在启动时也会清理已失效的 pid 文件。
 */
async function killStalePostmaster(pgdata: string): Promise<void> {
  const pidFile = path.join(pgdata, 'postmaster.pid')
  let pid = 0
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').split('\n')[0]?.trim())
  } catch {
    return
  }
  if (!Number.isFinite(pid) || pid <= 0) return

  const nameOf = (): string | null => {
    try {
      if (process.platform === 'win32') {
        // tasklist 输出 CSV，第一列是映像名；进程不存在时输出 INFO: 无任务
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        })
        return /^"([^"]+)"/.exec(out)?.[1]?.toLowerCase() ?? null
      }
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    } catch {
      return null
    }
  }

  const name = nameOf()
  if (name && !name.startsWith('postgres')) {
    // PID 已被其他进程复用：数据目录实际是空闲的，清掉过期 pid 文件即可
    fs.rmSync(pidFile, { force: true })
    return
  }
  if (!name) {
    // 进程已不在，交给 PG 启动时自清理
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  // 最多等 5 秒锁释放；强杀导致的脏状态由 PG 下次启动的崩溃恢复处理
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0)
      await sleep(100)
    } catch {
      break
    }
  }
  fs.rmSync(pidFile, { force: true })
}

/** 拉起内嵌 PG 并写入 DATABASE_URL；外部已显式配置数据库时直接跳过 */
export async function startEmbeddedDb(): Promise<void> {
  if (process.env.DATABASE_URL) return

  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const pgdata = path.join(dataDir(), 'pgdata')
  fs.mkdirSync(pgdata, { recursive: true })
  await killStalePostmaster(pgdata)

  const port = await pickPort()
  const pg = new EmbeddedPostgres({
    databaseDir: pgdata,
    user: 'postgres',
    // 固定口令，且必须与连接串一致：initdb 会把口令固化进集群，
    // 随机生成会导致重启后 28P01 认证失败
    password: 'nenochat-local',
    port,
    // 数据必须跨重启保留；persistent=false 会在 stop 时删除整个数据目录
    persistent: true,
  })

  // initdb 只能在空目录上跑一次，已有集群标记文件时直接启动
  if (!fs.existsSync(path.join(pgdata, 'PG_VERSION'))) {
    await pg.initialise()
  }
  await pg.start()

  instance = pg
  // 直接用集群自带的 postgres 库，避免重复建库的幂等处理
  process.env.DATABASE_URL = `postgres://postgres:nenochat-local@127.0.0.1:${port}/postgres`
}

/** 退出时停掉 PG 子进程；正常退出由 embedded-postgres 的退出钩子兜底 */
export async function stopEmbeddedDb(): Promise<void> {
  if (!instance) return
  const pg = instance
  instance = null
  await pg.stop()
}
