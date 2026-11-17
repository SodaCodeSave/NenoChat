import type { FastifyInstance } from 'fastify'
import { CreateStickerPackSchema, CreateStickerSchema, UpdateStickerPackSchema } from '@nenochat/shared'
import { getDb } from '../../db'
import { parse } from '../plugins/validate'
import { requireUserId } from '../plugins/auth'
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
    return { pack: stickerService.renamePack(db, userId, request.params.id, input.name) }
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

  app.delete<{ Params: { id: string } }>('/stickers/:id', async (request) => {
    const userId = await requireUserId(request)
    stickerService.deleteSticker(db, userId, request.params.id)
    return { ok: true }
  })
}
