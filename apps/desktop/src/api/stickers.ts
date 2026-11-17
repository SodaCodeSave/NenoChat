import { API_PREFIX, type Sticker, type StickerPackWithStickers } from '@nenochat/shared'
import { http } from './http'

const p = (path: string): string => `${API_PREFIX}${path}`

export const stickerApi = {
  packs: () => http.get<{ packs: StickerPackWithStickers[] }>(p('/stickers/packs')),
  createPack: (name: string) =>
    http.post<{ pack: StickerPackWithStickers }>(p('/stickers/packs'), { name }),
  renamePack: (id: string, name: string) =>
    http.patch<{ pack: StickerPackWithStickers['pack'] }>(p(`/stickers/packs/${id}`), { name }),
  removePack: (id: string) => http.delete<{ ok: boolean }>(p(`/stickers/packs/${id}`)),
  add: (body: { packId: string; attachmentId: string; keywords?: string[] }) =>
    http.post<{ sticker: Sticker }>(p('/stickers'), body),
  remove: (id: string) => http.delete<{ ok: boolean }>(p(`/stickers/${id}`)),
}
