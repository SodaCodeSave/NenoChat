import { buildApp } from './app'
import { env } from './env'
import { closeDb } from './db'

async function main(): Promise<void> {
  const app = await buildApp()

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    closeDb()
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
