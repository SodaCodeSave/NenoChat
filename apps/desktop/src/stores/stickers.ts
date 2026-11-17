import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Sticker, StickerPackWithStickers } from '@nenochat/shared'
import { stickerApi } from '@/api/stickers'
import { uploadFile } from '@/api/files'

/** 表情包：服务端为权威源，客户端只做内存缓存与乐观更新 */
export const useStickersStore = defineStore('stickers', () => {
  const packs = ref<StickerPackWithStickers[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const uploading = ref(false)
  const error = ref<string | null>(null)

  const allStickers = computed(() => packs.value.flatMap((entry) => entry.stickers))
  const hasStickers = computed(() => allStickers.value.length > 0)

  async function load(force = false): Promise<void> {
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    error.value = null
    try {
      const result = await stickerApi.packs()
      packs.value = result.packs
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : '读取表情包失败'
    } finally {
      loading.value = false
    }
  }

  async function createPack(name: string): Promise<void> {
    const result = await stickerApi.createPack(name)
    packs.value = [...packs.value, result.pack]
  }

  async function renamePack(packId: string, name: string): Promise<void> {
    const result = await stickerApi.renamePack(packId, name)
    const target = packs.value.find((entry) => entry.pack.id === packId)
    if (target) target.pack.name = result.pack.name
  }

  async function removePack(packId: string): Promise<void> {
    await stickerApi.removePack(packId)
    packs.value = packs.value.filter((entry) => entry.pack.id !== packId)
  }

  /** 上传图片 → 建表情记录。两者分两步是因为文件接口与表情接口职责不同 */
  async function addSticker(packId: string, file: File, keywords: string[] = []): Promise<Sticker> {
    uploading.value = true
    error.value = null
    try {
      const attachment = await uploadFile(file, { kind: 'sticker' })
      const result = await stickerApi.add({
        packId,
        attachmentId: attachment.id,
        keywords,
      })
      upsertSticker(result.sticker)
      return result.sticker
    } catch (e) {
      error.value = e instanceof Error ? e.message : '添加表情失败'
      throw e
    } finally {
      uploading.value = false
    }
  }

  async function removeSticker(stickerId: string): Promise<void> {
    await stickerApi.remove(stickerId)
    for (const entry of packs.value) {
      entry.stickers = entry.stickers.filter((sticker) => sticker.id !== stickerId)
    }
  }

  function upsertSticker(sticker: Sticker): void {
    const target = packs.value.find((entry) => entry.pack.id === sticker.packId)
    if (!target) return
    const index = target.stickers.findIndex((item) => item.id === sticker.id)
    if (index === -1) target.stickers = [...target.stickers, sticker]
    else target.stickers[index] = sticker
  }

  function reset(): void {
    packs.value = []
    loaded.value = false
    error.value = null
  }

  return {
    packs,
    loaded,
    loading,
    uploading,
    error,
    allStickers,
    hasStickers,
    load,
    createPack,
    renamePack,
    removePack,
    addSticker,
    removeSticker,
    upsertSticker,
    reset,
  }
})
