import { buildApp } from './app'
import { env } from './env'
import { closeDb } from './db'
import { startEmbeddedDb, stopEmbeddedDb } from './db/embedded'

/**
 * 一体化版由客户端托管：父进程被强杀或崩溃时子进程会变成孤儿，
 * 这里定期探测父进程是否还在，不在就自行退出，避免端口被长期占用。
 */
function watchParent(): void {
  const parentPid = Number(process.env.PARENT_PID || 0)
  if (!parentPid) return
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      process.exit(0)
    }
  }, 5000)
  timer.unref()
}

async function main(): Promise<void> {
  // 一体版没有独立数据库服务：DATABASE_URL 未设置时先拉起内嵌 PostgreSQL
  await startEmbeddedDb()

  const app = await buildApp()
  watchParent()

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    await closeDb()
    await stopEmbeddedDb()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: env.HOST, port: env.PORT })
  app.log.info(`NenoChat server listening on http://${env.HOST}:${env.PORT}`)
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
