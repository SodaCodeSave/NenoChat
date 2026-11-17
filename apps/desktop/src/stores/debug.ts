import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AiDebugSummary, AiGroupDecision, AiUsageEntry } from '@nenochat/shared'
import { aiApi } from '@/api/ai'

/**
 * 调试模式的数据面：
 * - summaries：每个会话的用量汇总（缓存命中率、token、上下文水位）
 * - decisions：群聊里每个 AI 成员的决策过程，按触发消息分组渲染
 * - usageByRef：按 generationId / logId 查最近一次调用的真实用量
 */
export const useDebugStore = defineStore('debug', () => {
  const summaries = ref<Record<string, AiDebugSummary>>({})
  const decisions = ref<Record<string, AiGroupDecision[]>>({})
  const usageByRef = ref<Record<string, AiUsageEntry>>({})
  const summaryLoading = ref<Record<string, boolean>>({})

  async function loadSummary(conversationId: string): Promise<AiDebugSummary | null> {
    if (summaryLoading.value[conversationId]) {
      return summaries.value[conversationId] ?? null
    }
    summaryLoading.value[conversationId] = true
    try {
      const result = await aiApi.debugSummary(conversationId)
      summaries.value[conversationId] = result.summary
      return result.summary
    } catch {
      return summaries.value[conversationId] ?? null
    } finally {
      delete summaryLoading.value[conversationId]
    }
  }

  async function loadDecisions(conversationId: string): Promise<void> {
    try {
      const result = await aiApi.debugDecisions(conversationId)
      decisions.value[conversationId] = result.decisions
    } catch {
      /* 拉不到就先不显示 */
    }
  }

  /** WS 推来的新决策：增量插入并刷新汇总 */
  function applyDecision(decision: AiGroupDecision): void {
    const list = decisions.value[decision.conversationId]
    if (!list) return
    // 模型层回填会复用同一条记录（同 logId），按 id 去重替换
    const index = list.findIndex((item) => item.id === decision.id)
    if (index >= 0) {
      const next = [...list]
      next[index] = decision
      decisions.value[decision.conversationId] = next
    } else {
      decisions.value[decision.conversationId] = [decision, ...list.slice(0, 499)]
    }
    void loadSummary(decision.conversationId)
  }

  /** 消息流需要显示哪些 generation/log 的用量时批量拉一次 */
  async function loadUsageByRefs(refIds: string[]): Promise<void> {
    const missing = refIds.filter((id) => usageByRef.value[id] === undefined)
    if (missing.length === 0) return
    try {
      const result = await aiApi.usageByRefs(missing.slice(0, 200))
      usageByRef.value = { ...usageByRef.value, ...result.usage }
    } catch {
      /* 拉不到就先不显示 */
    }
  }

  function resetConversation(conversationId: string): void {
    delete summaries.value[conversationId]
    delete decisions.value[conversationId]
  }

  return {
    summaries,
    decisions,
    usageByRef,
    loadSummary,
    loadDecisions,
    applyDecision,
    loadUsageByRefs,
    resetConversation,
  }
})
