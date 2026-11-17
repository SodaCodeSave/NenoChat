import Fastify, { type FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { API_PREFIX, MAX_UPLOAD_FILE_BYTES } from '@nenochat/shared'
import { env } from './env'
import { dataDir, getDb } from './db'
import { applyCors } from './http/plugins/cors'
import { applyErrorHandler } from './http/plugins/errors'
import { registerAuthPlugin } from './http/plugins/auth'
import { healthRoutes } from './http/routes/health'
import { serverInfoRoutes } from './http/routes/server-info'
import { authRoutes } from './http/routes/auth'
import { userRoutes } from './http/routes/users'
import { conversationRoutes } from './http/routes/conversations'
import { messageRoutes } from './http/routes/messages'
import { syncRoutes } from './http/routes/sync'
import { aiRoutes } from './http/routes/ai'
import { fileRoutes } from './http/routes/files'
import { postRoutes } from './http/routes/posts'
import { stickerRoutes } from './http/routes/stickers'
import { searchRoutes } from './http/routes/search'
import { contactRoutes } from './http/routes/contacts'
import { settingsRoutes } from './http/routes/settings'
import { registerWs } from './ws/server'
import { startProactiveScheduler } from './services/proactive-service'
import { startMomentsScheduler } from './services/moment-ai-service'
import { startGroupAiScheduler } from './services/group-ai-service'
import { startAttachmentReclaimer } from './services/attachment-gc'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
  })

  // 打开数据库并跑迁移，失败即启动失败（快速失败优于半可用）
  getDb()

  // 允许「带 JSON content-type 但没有 body」的请求（常见的 DELETE/POST 空体场景）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : ''
    if (text.trim().length === 0) {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch (e) {
      done(e as Error)
    }
  })

  applyCors(app)
  applyErrorHandler(app)

  await registerAuthPlugin(app)

  // 上传：multipart 必须在 fileRoutes 之前注册（它给 request 装上 .file()）
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 1, fields: 6, parts: 10 },
    throwFileSizeLimit: true,
  })

  // 静态文件挂在根 scope（/files/），不能进 /api/v1，否则存进库的 URL 要跟着变
  const filesRoot = path.join(dataDir(), 'files')
  fs.mkdirSync(filesRoot, { recursive: true })
  await app.register(fastifyStatic, {
    root: filesRoot,
    prefix: '/files/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '365d',
    immutable: true,
    setHeaders(reply) {
      // 图片要被 web 端跨源引用
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin')
    },
  })

  await app.register(healthRoutes)
  await app.register(
    async (scope) => {
      await scope.register(authRoutes)
      await scope.register(userRoutes)
      await scope.register(conversationRoutes)
      await scope.register(messageRoutes)
      await scope.register(syncRoutes)
      await scope.register(aiRoutes)
      await scope.register(fileRoutes)
      await scope.register(postRoutes)
      await scope.register(stickerRoutes)
      await scope.register(searchRoutes)
      await scope.register(contactRoutes)
      await scope.register(settingsRoutes)
    },
    { prefix: API_PREFIX },
  )

  await app.register(serverInfoRoutes, { prefix: API_PREFIX })
  await registerWs(app)

  // 主动消息调度：由服务端统一判定与生成，多端看到的是同一条
  const stopProactive = startProactiveScheduler(app, getDb())
  // 角色在动态广场的活动：点赞、评论、自己发一条
  const stopMoments = startMomentsScheduler(app, getDb())
  // 群聊里角色自己的主动开口
  const stopGroupAi = startGroupAiScheduler(app, getDb())
  // 无人引用的附件与磁盘孤儿文件，定时回收
  const stopAttachmentGc = startAttachmentReclaimer(getDb())
  app.addHook('onClose', async () => {
    stopProactive()
    stopMoments()
    stopGroupAi()
    stopAttachmentGc()
  })

  return app
}
