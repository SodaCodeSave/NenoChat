<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AiDebugSummary } from '@nenochat/shared'
import { useDebugStore } from '@/stores/debug'
import { formatPercent, formatTokens } from './debug-labels'

/**
 * 会话底部的调试信息栏：缓存命中率、token 消耗、上下文水位、压缩进度。
 * 数据来自服务端聚合，WS 推来新决策时由 debug store 自动刷新。
 */
const props = defineProps<{
  conversationId: string
}>()

const debug = useDebugStore()
const collapsed = ref(false)

const summary = computed<AiDebugSummary | null>(() => debug.summaries[props.conversationId] ?? null)

const hitRate = computed(() => summary.value?.hitRate ?? null)
const contextLevel = computed(() => summary.value?.contextLevel ?? null)
const lastPrompt = computed(() => summary.value?.lastPromptTokens ?? null)

/** 水位条的视觉色：超过 80% 提示该压缩了 */
const levelTone = computed(() => {
  const level = contextLevel.value
  if (level == null) return 'bg-muted'
  if (level >= 0.8) return 'bg-danger'
  if (level >= 0.5) return 'bg-warning'
  return 'bg-success'
})

function reload(): void {
  void debug.loadSummary(props.conversationId)
}

onMounted(reload)
watch(() => props.conversationId, reload)
</script>

<template>
  <div v-if="summary" class="border-t border-line bg-surface-2/60 px-4 py-1.5 text-[11px] text-muted">
    <button
      type="button"
      class="flex w-full items-center gap-3 text-left"
      @click="collapsed = !collapsed"
    >
      <span class="shrink-0 rounded bg-surface-3 px-1 font-mono text-[10px]">debug</span>

      <span class="shrink-0">调用 {{ summary.calls }} 次</span>
      <span class="shrink-0">
        缓存命中 <span class="text-text">{{ formatPercent(hitRate) }}</span>
      </span>
      <span class="shrink-0">
        输入 {{ formatTokens(summary.promptTokens) }} · 输出 {{ formatTokens(summary.completionTokens) }}
      </span>
      <span v-if="summary.contextWindow" class="min-w-0 flex-1">
        <span class="whitespace-nowrap">
          上下文 {{ formatTokens(lastPrompt) }}/{{ formatTokens(summary.contextWindow) }}
          （{{ formatPercent(contextLevel) }}）
        </span>
        <span class="ml-1.5 inline-block h-1 w-16 overflow-hidden rounded-full bg-surface-3 align-middle">
          <span
            class="block h-full"
            :class="levelTone"
            :style="{ width: `${Math.min(100, Math.round((contextLevel ?? 0) * 100))}%` }"
          />
        </span>
      </span>
      <span v-else class="min-w-0 flex-1" />
      <span v-if="summary.lastCompactedSeq != null" class="shrink-0">
        已压缩至 #{{ summary.lastCompactedSeq }}
      </span>
      <span v-if="summary.lastModel" class="shrink-0 truncate max-w-[180px]">{{ summary.lastModel }}</span>
    </button>
  </div>
</template>
