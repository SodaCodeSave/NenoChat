import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AiUsageStats, AiUsageWindow } from '@nenochat/shared'
import { aiApi } from '@/api/ai'

/**
 * 用量统计的数据面：按窗口缓存统计结果，切换窗口或手动刷新时重新拉取。
 * 统计页是低频查询，缓存不主动失效，页面卸载不清理（下次打开直接命中）。
 */
export const useStatsStore = defineStore('stats', () => {
  const byWindow = ref<Partial<Record<AiUsageWindow, AiUsageStats>>>({})
  const loading = ref<Partial<Record<AiUsageWindow, boolean>>>({})

  async function load(window: AiUsageWindow, force = false): Promise<AiUsageStats | null> {
    if (!force && byWindow.value[window]) return byWindow.value[window] ?? null
    if (loading.value[window]) return byWindow.value[window] ?? null
    loading.value = { ...loading.value, [window]: true }
    try {
      // 东八区 getTimezoneOffset() = -480，服务端语义是「本地比 UTC 快多少分钟」，取负
      const tzOffset = -new Date().getTimezoneOffset()
      const result = await aiApi.usageStats(window, tzOffset)
      byWindow.value = { ...byWindow.value, [window]: result.stats }
      return result.stats
    } catch {
      // 拉不到就维持旧值，页面显示空态
      return byWindow.value[window] ?? null
    } finally {
      loading.value = { ...loading.value, [window]: false }
    }
  }

  /** 登出等场景清缓存 */
  function reset(): void {
    byWindow.value = {}
    loading.value = {}
  }

  return { byWindow, loading, load, reset }
})
