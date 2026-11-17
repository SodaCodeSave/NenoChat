import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { Sticker, StickerPackImportResult, StickerPackWithStickers } from '@nenochat/shared'
import { stickerApi } from '@/api/stickers'
import { uploadFile } from '@/api/files'
import { resolveFileUrl } from '@/api/http'
import { isTauri } from '@/platform/device'
import { loadProviderKey } from '@/platform/ai-keys'
import { useAiStore } from './ai'

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

  const STICKER_TAG_PROMPT =
    '这是聊天软件里的一张表情包。请给出 3~5 个描述它的情绪或使用场景的中文标签，' +
    '用逗号分隔（例如：开心,庆祝,可爱）。只输出标签，不要任何解释。'

  function parseTags(raw: string): string[] {
    const seen = new Set<string>()
    for (const piece of raw.split(/[，,、;；\s]+/)) {
      const tag = piece.trim().slice(0, 24)
      if (!tag) continue
      seen.add(tag)
      if (seen.size >= 5) break
    }
    return [...seen]
  }

  async function fetchImageDataUrl(url: string): Promise<string | null> {
    const absolute = resolveFileUrl(url)
    if (!absolute) return null
    try {
      const response = await fetch(absolute)
      if (!response.ok) return null
      const blob = await response.blob()
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }

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

  /**
   * 用识图模型分析一张表情包的情绪标签并写回服务端。
   * 本机密钥由客户端直接调识图模型；托管密钥交给服务端分析。
   * 没有可用识图模型时抛错，由调用方决定怎么提示。
   */
  async function analyzeSticker(stickerId: string): Promise<string[]> {
    const ai = useAiStore()
    const provider = ai.providers.find((p) => p.visionModel)
    if (!provider) throw new Error('没有配置识图模型，请先在 AI 设置里给服务商填识图模型')
    const sticker = findStickerById(stickerId)
    if (!sticker?.url) throw new Error('表情不存在')

    let tags: string[]
    if (provider.keyLocation === 'local') {
      if (!isTauri()) throw new Error('本机密钥模式需要桌面客户端')
      const apiKey = await loadProviderKey(provider.id)
      if (!apiKey) throw new Error('本机没有找到该服务商的密钥')
      const dataUrl = await fetchImageDataUrl(sticker.url)
      if (!dataUrl) throw new Error('表情图片读取失败')
      const result = await invoke<{ content: string }>('ai_complete', {
        baseUrl: provider.baseUrl,
        apiKey,
        model: provider.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: STICKER_TAG_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        maxTokens: 120,
        jsonMode: false,
      })
      tags = parseTags(result.content)
      if (tags.length === 0) throw new Error('识图模型没有返回有效的情绪标签')
      const merged = mergeKeywords(sticker.keywords, tags)
      const updated = await stickerApi.updateKeywords(stickerId, merged)
      upsertSticker(updated.sticker)
    } else {
      const result = await stickerApi.serverAnalyze(stickerId)
      tags = result.tags
      const fresh = findStickerById(stickerId)
      if (fresh) upsertSticker({ ...fresh, keywords: mergeKeywords(fresh.keywords, tags) })
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
