import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_UPLOAD_IMAGE_BYTES, type Attachment } from '@nenochat/shared'
import type { DB } from '../db'
import { dataDir } from '../db'
import * as attachmentsRepo from '../db/repo/attachments'
import { err } from '../util/errors'
import { now } from '../util/clock'

/** 允许上传的图片类型（头像、动态配图、表情都走这一套） */
export const IMAGE_MIME = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

/** 允许上传的文本类型（角色卡等） */
export const TEXT_MIME = new Map<string, string>([
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
  ['application/json', '.json'],
])

/** 允许上传的音频类型（用户语音消息；服务端合成的 TTS 也是 wav） */
export const AUDIO_MIME = new Map<string, string>([
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/aac', '.aac'],
])

/**
 * 魔数校验：光看 Content-Type 与扩展名都能伪造，
 * 头像这类会直接进 <img> 的文件至少确认内容真的是图片。
 */
function sniffMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif'
  }
  return null
}

function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, '_').trim()
  return base.slice(0, 120) || 'file'
}

export interface SaveUploadInput {
  userId: string
  buffer: Buffer
  filename: string
  mime: string
  kind: 'avatar' | 'file' | 'sticker'
}

/**
 * 落盘 + 去重 + 写 attachments 行。
 * 文件写入用同步 API（fs.writeFileSync）：文件最大 50MB，
 * 路由层已经把流读成 Buffer，这里再异步化只会增加竞态面。
 */
export async function saveUpload(db: DB, input: SaveUploadInput): Promise<Attachment> {
  const mime = input.mime.split(';')[0]!.trim().toLowerCase()
  const ext = IMAGE_MIME.get(mime) ?? TEXT_MIME.get(mime) ?? AUDIO_MIME.get(mime)
  if (!ext) throw err.validation(`不支持的文件类型：${input.mime}`)

  if (input.kind === 'avatar' || input.kind === 'sticker') {
    const label = input.kind === 'avatar' ? '头像' : '表情'
    if (!IMAGE_MIME.has(mime)) throw err.validation(`${label}只支持 PNG / JPEG / WEBP / GIF`)
    if (input.buffer.length > MAX_UPLOAD_IMAGE_BYTES) {
      throw err.tooLarge(`${label}不能超过 ${Math.round(MAX_UPLOAD_IMAGE_BYTES / 1048576)}MB`)
    }
    if (sniffMime(input.buffer) !== mime) throw err.validation('文件内容与类型不匹配')
  }

  if (input.buffer.length === 0) throw err.validation('文件为空')

  const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex')

  const existing = await attachmentsRepo.findBySha(db, input.userId, sha256)
  // 去重命中也不能直接复用：文件可能与库脱节（容器重建丢盘等场景），
  // 磁盘上真的存在才返回；缺失时按原 storage_key 补写文件自愈，不重复建行
  if (existing) {
    const absolute = path.join(dataDir(), 'files', existing.storage_key)
    if (fs.existsSync(absolute)) {
      return attachmentsRepo.mapAttachment(existing)
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    try {
      fs.writeFileSync(absolute, input.buffer, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    return attachmentsRepo.mapAttachment(existing)
  }

  const folder = input.kind === 'avatar' ? 'avatars' : input.kind === 'sticker' ? 'stickers' : 'files'
  const storageKey = `${folder}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${ext}`
  const absolute = path.join(dataDir(), 'files', storageKey)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })

  try {
    // wx：已存在说明别的用户传过同一张图，直接复用文件即可
    fs.writeFileSync(absolute, input.buffer, { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }

  const row = await attachmentsRepo.create(db, {
    ownerId: input.userId,
    kind: input.kind,
    filename: sanitizeName(input.filename),
    mime,
    size: input.buffer.length,
    sha256,
    storageKey,
    createdAt: now(),
  })
  return attachmentsRepo.mapAttachment(row)
}
