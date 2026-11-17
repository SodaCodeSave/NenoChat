<script setup lang="ts">
import { computed } from 'vue'
import type { AiGroupDecision } from '@nenochat/shared'
import { describeDecision, formatTokens } from './debug-labels'

/** 消息流里的调试行：显示某个 AI 成员在触发消息后的决策过程 */
const props = defineProps<{
  decision: AiGroupDecision
}>()

const text = computed(() => {
  const parts = [`${props.decision.personaName}：${describeDecision(props.decision)}`]
  if (props.decision.mood) parts.push(`心情「${props.decision.mood}」`)
  if (props.decision.energy != null) parts.push(`体力 ${Math.round(props.decision.energy)}`)
  return parts.join(' · ')
})

const usageTokens = computed(() => {
  const usage = props.decision.usage
  if (!usage) return null
  return `输入 ${formatTokens(usage.promptTokens)} · 输出 ${formatTokens(usage.completionTokens)}`
})
</script>

<template>
  <div class="mx-4 my-0.5 flex items-baseline gap-1.5 pl-[46px] text-[11px] leading-relaxed text-muted/80">
    <span class="shrink-0 rounded bg-surface-2 px-1 font-mono text-[10px] text-muted">debug</span>
    <span class="min-w-0">{{ text }}</span>
    <span v-if="usageTokens" class="shrink-0 text-muted/60">{{ usageTokens }}</span>
  </div>
</template>
