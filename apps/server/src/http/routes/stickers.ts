import type { FastifyInstance } from 'fastify'
import {
  CreateStickerPackSchema,
  CreateStickerSchema,
  MAX_STICKER_PACK_BYTES,
  UpdateStickerKeywordsSchema,
  UpdateStickerPackSchema,
} from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
import { err } from '../../util/errors'
import * as stickerService from '../../services/sticker-service'

/**
 * 表情包管理。表情本体是 attachments 里的一条图片记录，
 * 所以多端同步、去重、静态访问都与头像/动态配图共用同一套。
 */
export async function stickerRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/stickers/packs', async (request) => {
    const userId = await requireUserId(request)
    return { packs: stickerService.listPacks(db, userId) }
  })

  app.post('/stickers/packs', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(CreateStickerPackSchema, request.body)
    return { pack: stickerService.createPack(db, userId, input.name) }
  })

  app.patch<{ Params: { id: string } }>('/stickers/packs/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(UpdateStickerPackSchema, request.body)
    return { pack: stickerService.updatePack(db, userId, request.params.id, input) }
  })

  app.delete<{ Params: { id: string } }>('/stickers/packs/:id', async (request) => {
    const userId = await requireUserId(request)
    stickerService.deletePack(db, userId, request.params.id)
    return { ok: true }
  })

  app.post('/stickers', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(CreateStickerSchema, request.body)
    return {
      sticker: stickerService.addSticker(db, userId, {
        packId: input.packId,
        attachmentId: input.attachmentId,
        keywords: input.keywords,
      }),
    }
  })

  /** 覆写表情关键词：本机识图分析完情绪标签后回传 */
  app.patch<{ Params: { id: string } }>('/stickers/:id', async (request) => {
    const userId = await requireUserId(request)
    const input = parse(UpdateStickerKeywordsSchema, request.body)
    return { sticker: stickerService.updateStickerKeywords(db, userId, request.params.id, input.keywords) }
  })

  app.delete<{ Params: { id: string } }>('/stickers/:id', async (request) => {
    const userId = await requireUserId(request)
    stickerService.deleteSticker(db, userId, request.params.id)
    return { ok: true }
  })

  /**
   * 导入 AstrBot 格式的表情包 zip：上传整包，服务端解压后逐张落盘建表情。
   * 单个 zip 比普通上传大得多，所以这里单独放宽 multipart 的大小限制。
   */
  app.post('/stickers/import', async (request) => {
    const userId = await requireUserId(request)
    const tooLarge = `表情包不能超过 ${Math.round(MAX_STICKER_PACK_BYTES / 1048576)}MB`

    let part: Awaited<ReturnType<typeof request.file>> | undefined
    try {
      part = await request.file({ limits: { fileSize: MAX_STICKER_PACK_BYTES } })
    } catch {
      throw err.tooLarge(tooLarge)
    }
    if (!part) throw err.validation('缺少文件字段 file')

    let buffer: Buffer
    try {
      buffer = await part.toBuffer()
    } catch {
      throw err.tooLarge(tooLarge)
    }
    if (buffer.length === 0) throw err.validation('上传的压缩包为空')

    return stickerService.importAstrbotPack(db, userId, buffer)
  })
}
