import {
  API_PREFIX,
  type Sticker,
  type StickerPackImportResult,
  type StickerPackWithStickers,
} from '@nenochat/shared'
import { http } from './http'
import { postFile, type UploadOptions } from './files'

const p = (path: string): string => `${API_PREFIX}${path}`

export const stickerApi = {
  packs: () => http.get<{ packs: StickerPackWithStickers[] }>(p('/stickers/packs')),
  createPack: (name: string) =>
    http.post<{ pack: StickerPackWithStickers }>(p('/stickers/packs'), { name }),
  renamePack: (id: string, name: string) =>
    http.patch<{ pack: StickerPackWithStickers['pack'] }>(p(`/stickers/packs/${id}`), { name }),
  /** 分组改名与「允许 AI 使用」开关共用一个入口 */
  updatePack: (id: string, body: { name?: string; allowAi?: boolean }) =>
    http.patch<{ pack: StickerPackWithStickers['pack'] }>(p(`/stickers/packs/${id}`), body),
  removePack: (id: string) => http.delete<{ ok: boolean }>(p(`/stickers/packs/${id}`)),
  add: (body: { packId: string; attachmentId: string; keywords?: string[] }) =>
    http.post<{ sticker: Sticker }>(p('/stickers'), body),
  remove: (id: string) => http.delete<{ ok: boolean }>(p(`/stickers/${id}`)),
  /** 覆写表情关键词：本机情绪分析完成后回传 */
  updateKeywords: (id: string, keywords: string[]) =>
    http.patch<{ sticker: Sticker }>(p(`/stickers/${id}`), { keywords }),
  /** 服务端识图分析表情情绪（密钥托管模式） */
  serverAnalyze: (id: string) =>
    http.post<{ tags: string[] }>(p('/ai/stickers/analyze'), { stickerId: id }),
  /** 导入 AstrBot 格式表情包 zip：整包交给服务端解压 */
  importPack: (file: File, options: UploadOptions = {}) =>
    postFile<StickerPackImportResult>(p('/stickers/import'), file, options),
}
