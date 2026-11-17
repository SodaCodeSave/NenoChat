import type { FastifyInstance } from 'fastify'
import { APP_VERSION } from '../../version'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    ok: true,
    version: APP_VERSION,
    uptime: Math.round(process.uptime()),
  }))
}
