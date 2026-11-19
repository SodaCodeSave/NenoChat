import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Sticker, StickerPackImportResult, StickerPackWithStickers } from '@nenochat/shared'
import { stickerApi } from '@/api/stickers'
import { uploadFile } from '@/api/files'

/** 表情包：服务端为权威源，客户端只做内存缓存与乐观更新 */
export const useStickersStore = defineStore('stickers', () => {
  const packs = ref<StickerPackWithStickers[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const uploading = ref(false)
  const error = ref<string | null>(null)
  /** 正在补扫的情绪分析数量，界面拿它显示进度 */
  const analyzing = ref(0)

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

  /**
   * 导入 AstrBot 格式表情包 zip。整包上传由服务端解压入库，
   * 完成后重新拉取分组，返回导入统计供界面提示。
   */
  async function importPack(
    file: File,
    options: { onProgress?: (percent: number) => void } = {},
  ): Promise<StickerPackImportResult> {
    uploading.value = true
    error.value = null
    try {
      const result = await stickerApi.importPack(file, options)
      await load(true)
      return result
    } catch (e) {
      error.value = e instanceof Error ? e.message : '导入表情包失败'
      throw e
    } finally {
      uploading.value = false
    }
  }

  function upsertSticker(sticker: Sticker): void {
    const target = packs.value.find((entry) => entry.pack.id === sticker.packId)
    if (!target) return
    const index = target.stickers.findIndex((item) => item.id === sticker.id)
    if (index === -1) target.stickers = [...target.stickers, sticker]
    else target.stickers[index] = sticker
  }

  /* --------------------------- AI 情绪分析 --------------------------- */

  function findStickerById(stickerId: string): Sticker | null {
    for (const entry of packs.value) {
      const target = entry.stickers.find((item) => item.id === stickerId)
      if (target) return target
    }
    return null
  }

  function mergeKeywords(existing: string[], tags: string[]): string[] {
    return [...new Set([...existing, ...tags])].slice(0, 10)
  }

  /** 用服务端识图模型分析一张表情包的情绪标签并写回 */
  async function analyzeSticker(stickerId: string): Promise<string[]> {
    const result = await stickerApi.serverAnalyze(stickerId)
    const fresh = findStickerById(stickerId)
    const tags = result.tags
    if (fresh) {
      const merged = [...new Set([...fresh.keywords, ...tags])].slice(0, 10)
      upsertSticker({ ...fresh, keywords: merged })
    }
    return tags
  }

  /** 导入后自动排队分析；同一张只排一次 */
  const analysisQueue = new Set<string>()
  let analysisRunning = false

  function queueAnalysis(stickerId: string): void {
    analysisQueue.add(stickerId)
    void runAnalysisQueue()
  }

  async function runAnalysisQueue(): Promise<void> {
    if (analysisRunning) return
    analysisRunning = true
    try {
      while (analysisQueue.size > 0) {
        const id = [...analysisQueue][0]!
        analysisQueue.delete(id)
        analyzing.value += 1
        try {
          await analyzeSticker(id)
        } catch {
          /* 单张失败不阻塞队列 */
        } finally {
          analyzing.value = Math.max(0, analyzing.value - 1)
        }
      }
    } finally {
      analysisRunning = false
    }
  }

  /**
   * 一键补扫：把所有还没有情绪标签的图片表情排队分析。
   * 返回成功与失败张数，进度通过 analyzing 反映。
   */
  async function backfillAnalysis(): Promise<{ ok: number; failed: number }> {
    const pending = allStickers.value.filter(
      (sticker) =>
        (sticker.kind === 'image' || sticker.kind === 'gif') &&
        sticker.keywords.length === 0 &&
        sticker.url,
    )
    let ok = 0
    let failed = 0
    for (const sticker of pending) {
      analyzing.value += 1
      try {
        await analyzeSticker(sticker.id)
        ok += 1
      } catch {
        failed += 1
      } finally {
        analyzing.value = Math.max(0, analyzing.value - 1)
      }
    }
    return { ok, failed }
  }

  /** 逐包授权 AI 使用表情；服务端确认后本地才更新 */
  async function setPackAllowAi(packId: string, value: boolean): Promise<void> {
    const result = await stickerApi.updatePack(packId, { allowAi: value })
    const target = packs.value.find((entry) => entry.pack.id === packId)
    if (target) target.pack.allowAi = result.pack.allowAi
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
    analyzing,
    allStickers,
    hasStickers,
    load,
    createPack,
    renamePack,
    removePack,
    addSticker,
    importPack,
    removeSticker,
    upsertSticker,
    setPackAllowAi,
    analyzeSticker,
    queueAnalysis,
    backfillAnalysis,
    reset,
  }
})
