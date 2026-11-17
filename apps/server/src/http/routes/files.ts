import type { FastifyInstance } from 'fastify'
import { MAX_UPLOAD_FILE_BYTES } from '@nenochat/shared'
import { getDb } from '../../db'
import { requireUserId } from '../plugins/auth'
import { rateLimit } from '../plugins/rate-limit'
import { err } from '../../util/errors'
import { saveUpload } from '../../services/file-service'

/**
 * 文件上传。multipart 走流式，大小由 @fastify/multipart 的 limits.fileSize
 * 与 saveUpload 的二次校验共同把关（JSON 的 bodyLimit 对 multipart 不生效）。
 *
 * 返回值里的 url 是相对路径（/files/...），客户端按当前服务器 baseUrl 拼绝对地址，
 * 这样同一份数据在 localhost 与局域网 IP 下都能正确显示。
 */
export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.post<{ Querystring: { kind?: string } }>(
    '/files',
    { preHandler: rateLimit({ max: 30, windowMs: 60_000 }) },
    async (request) => {
      const userId = await requireUserId(request)
      const rawKind = request.query.kind
      const kind = rawKind === 'avatar' ? 'avatar' : rawKind === 'sticker' ? 'sticker' : 'file'

      let part: Awaited<ReturnType<typeof request.file>> | undefined
      try {
        part = await request.file()
      } catch {
        throw err.tooLarge(`文件不能超过 ${Math.round(MAX_UPLOAD_FILE_BYTES / 1048576)}MB`)
      }
      if (!part) throw err.validation('缺少文件字段 file')

      let buffer: Buffer
      try {
        buffer = await part.toBuffer()
      } catch {
        throw err.tooLarge(`文件不能超过 ${Math.round(MAX_UPLOAD_FILE_BYTES / 1048576)}MB`)
      }

      const attachment = saveUpload(db, {
        userId,
        buffer,
        filename: part.filename ?? 'file',
        mime: part.mimetype ?? 'application/octet-stream',
        kind,
      })

      return { attachment }
    },
  )
}
