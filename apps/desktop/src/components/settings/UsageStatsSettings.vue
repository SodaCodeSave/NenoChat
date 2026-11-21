<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AiUsageStats, AiUsageWindow } from '@nenochat/shared'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import Button from '@/components/ui/form/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import { formatPercent, formatTokens } from '@/components/chat/debug-labels'
import { useStatsStore } from '@/stores/stats'
import {
  USAGE_WINDOW_OPTIONS,
  bucketLabel,
  bucketTooltip,
  bucketTotal,
  fillSeries,
  labelStep,
  usageKindLabel,
} from './usage-stats-helpers'

const stats = useStatsStore()

/** 时间窗作用于整页：总览、柱状图与两张榜单 */
const activeWindow = ref<AiUsageWindow>('7d')
/** 按 AI 榜单的维度：角色 / 模型 */
const aiDimension = ref<'persona' | 'model'>('persona')

const current = computed<AiUsageStats | null>(() => stats.byWindow[activeWindow.value] ?? null)
const loading = computed(() => stats.loading[activeWindow.value] === true)
const empty = computed(() => current.value !== null && current.value.totals.calls === 0)

/* ------------------------------ 柱状图 ------------------------------ */

const bars = computed(() => (current.value ? fillSeries(current.value) : []))
const maxBucket = computed(() => Math.max(1, ...bars.value.map((bucket) => bucketTotal(bucket))))
const step = computed(() => labelStep(bars.value.length))

/** 稀疏取样显示横轴标签；末柱始终显示，避免右侧悬空 */
function showLabel(index: number): boolean {
  return index % step.value === 0 || index === bars.value.length - 1
}

function promptHeight(bucket: { promptTokens: number }): string {
  return `${(bucket.promptTokens / maxBucket.value) * 100}%`
}

function completionHeight(bucket: { completionTokens: number }): string {
  return `${(bucket.completionTokens / maxBucket.value) * 100}%`
}

/* ------------------------------ 榜单 ------------------------------ */

interface StatRow {
  key: string
  label: string
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

function rowsOf(
  source: AiUsageStats,
  dimension: 'persona' | 'model',
): StatRow[] {
  if (dimension === 'model') {
    return source.byModel.map((row) => ({
      key: row.model ?? 'unknown',
      label: row.model ?? '未知模型',
      calls: row.calls,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedTokens: row.cachedTokens,
    }))
  }
  return source.byPersona.map((row) => ({
    key: row.personaId,
    label: row.personaName,
    calls: row.calls,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cachedTokens: row.cachedTokens,
  }))
}

const aiRows = computed(() => (current.value ? rowsOf(current.value, aiDimension.value) : []))
const kindRows = computed<StatRow[]>(() =>
  current.value
    ? current.value.byKind.map((row) => ({
        key: row.kind,
        label: usageKindLabel(row.kind),
        calls: row.calls,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        cachedTokens: row.cachedTokens,
      }))
    : [],
)

function rowMax(rows: StatRow[]): number {
  return Math.max(1, ...rows.map((row) => row.promptTokens + row.completionTokens))
}

function share(row: StatRow, max: number): number {
  return Math.max(row.promptTokens + row.completionTokens > 0 ? 1.5 : 0, ((row.promptTokens + row.completionTokens) / max) * 100)
}

function rowTooltip(row: StatRow): string {
  return `输入 ${row.promptTokens} · 输出 ${row.completionTokens} · 缓存 ${row.cachedTokens}`
}

/* ------------------------------ 加载 ------------------------------ */

onMounted(() => {
  void stats.load(activeWindow.value)
})

watch(activeWindow, (value) => {
  void stats.load(value)
})

function refresh(): void {
  void stats.load(activeWindow.value, true)
}
</script>

<template>
  <div class="space-y-3">
    <SettingsCard
      id="overview"
      title="用量总览"
      description="AI 调用的 token 消耗与调用次数"
      icon="chart"
    >
      <template #actions>
        <Segmented
          :model-value="activeWindow"
          :options="USAGE_WINDOW_OPTIONS"
          size="sm"
          aria-label="统计时间窗"
          @update:model-value="(value) => value !== null && (activeWindow = value as AiUsageWindow)"
        />
        <Button variant="ghost" size="sm" icon="refresh" :loading="loading" :disabled="loading" @click="refresh">
          刷新
        </Button>
      </template>

      <div v-if="loading && !current" class="py-6 text-center text-[12px] text-muted">统计中…</div>
      <template v-else-if="current">
        <div class="rounded-lg bg-surface-2 px-3.5 py-3">
          <p class="text-[11.5px] text-muted">Token 总消耗（输入 + 输出）</p>
          <p class="mt-0.5 text-[24px] font-semibold leading-tight tracking-tight text-text-strong tabular-nums">
            {{ formatTokens(current.totals.promptTokens + current.totals.completionTokens) }}
          </p>
          <p class="mt-1 text-[11.5px] text-muted tabular-nums">
            输入 {{ formatTokens(current.totals.promptTokens) }} · 输出
            {{ formatTokens(current.totals.completionTokens) }} · 缓存命中
            {{
              current.totals.promptTokens > 0
                ? formatPercent(current.totals.cachedTokens / current.totals.promptTokens)
                : '-'
            }}
            · 调用 {{ current.totals.calls }} 次
          </p>
        </div>

        <div class="mt-3">
          <div class="flex items-center gap-3 pb-2 text-[11px] text-muted">
            <span class="inline-flex items-center gap-1">
              <span class="h-2 w-2 rounded-sm bg-accent-soft" />输入
            </span>
            <span class="inline-flex items-center gap-1">
              <span class="h-2 w-2 rounded-sm bg-accent" />输出
            </span>
          </div>

          <!-- 柱状图：每柱输入/输出两段堆叠，零桶占位灰点 -->
          <div class="flex h-32 items-stretch gap-[2px]">
            <div
              v-for="(bucket, index) in bars"
              :key="bucket.bucketStart"
              class="flex min-w-0 flex-1 flex-col justify-end gap-[1px]"
              :title="bucketTooltip(bucket, activeWindow)"
            >
              <template v-if="bucketTotal(bucket) > 0">
                <div
                  class="w-full rounded-t-[2px] bg-accent-soft"
                  :style="{ height: promptHeight(bucket) }"
                />
                <div class="w-full rounded-b-[2px] bg-accent" :style="{ height: completionHeight(bucket) }" />
              </template>
              <div v-else class="w-full">
                <div class="mx-auto h-[2px] w-2/3 rounded-full bg-surface-3" />
              </div>
              <span class="sr-only">{{ bucketLabel(bucket.bucketStart, activeWindow) }}</span>
            </div>
          </div>

          <!-- 横轴稀疏标签，按比例定位避免拥挤 -->
          <div class="relative mt-1.5 h-4">
            <span
              v-for="(bucket, index) in bars"
              v-show="showLabel(index)"
              :key="`label-${bucket.bucketStart}`"
              class="absolute -translate-x-1/2 whitespace-nowrap text-[10px] leading-none text-muted tabular-nums"
              :style="{ left: `${((index + 0.5) / bars.length) * 100}%` }"
            >
              {{ bucketLabel(bucket.bucketStart, activeWindow) }}
            </span>
          </div>
        </div>
      </template>
    </SettingsCard>

    <SettingsCard
      id="by-ai"
      title="按 AI 统计"
      description="每个角色与模型各自消耗的 token"
      icon="sparkles"
    >
      <template #actions>
        <Segmented
          :model-value="aiDimension"
          :options="[
            { value: 'persona', label: '角色' },
            { value: 'model', label: '模型' },
          ]"
          size="sm"
          aria-label="按 AI 统计维度"
          @update:model-value="(value) => value !== null && (aiDimension = value as 'persona' | 'model')"
        />
      </template>

      <div v-if="loading && !current" class="py-4 text-center text-[12px] text-muted">统计中…</div>
      <p v-else-if="empty" class="py-4 text-center text-[12px] text-muted">窗口内还没有 AI 调用记录</p>
      <div v-else-if="aiRows.length === 0" class="py-4 text-center text-[12px] text-muted">
        {{ aiDimension === 'persona' ? '窗口内的调用都没有关联角色' : '窗口内没有模型记录' }}
      </div>
      <div v-else class="space-y-2.5">
        <div v-for="row in aiRows" :key="row.key">
          <div class="flex items-center gap-2 text-[12px]" :title="rowTooltip(row)">
            <span class="min-w-0 flex-1 truncate text-text">{{ row.label }}</span>
            <span class="shrink-0 text-[11px] text-muted">{{ row.calls }} 次</span>
            <span class="shrink-0 tabular-nums text-text-strong">
              {{ formatTokens(row.promptTokens + row.completionTokens) }}
            </span>
          </div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              class="h-full rounded-full bg-accent transition-[width] duration-300"
              :style="{ width: `${share(row, rowMax(aiRows))}%` }"
            />
          </div>
        </div>
      </div>
    </SettingsCard>

    <SettingsCard
      id="by-kind"
      title="按功能统计"
      description="对话、记忆、识图等各场景消耗的 token"
      icon="memory"
    >
      <div v-if="loading && !current" class="py-4 text-center text-[12px] text-muted">统计中…</div>
      <p v-else-if="empty" class="py-4 text-center text-[12px] text-muted">窗口内还没有 AI 调用记录</p>
      <div v-else class="space-y-2.5">
        <div v-for="row in kindRows" :key="row.key">
          <div class="flex items-center gap-2 text-[12px]" :title="rowTooltip(row)">
            <Icon :name="row.key === 'vision' ? 'image' : row.key === 'summary' ? 'memory' : row.key === 'schedule' ? 'calendar' : 'sparkles'" :size="13" class="text-muted" />
            <span class="min-w-0 flex-1 truncate text-text">{{ row.label }}</span>
            <span class="shrink-0 text-[11px] text-muted">{{ row.calls }} 次</span>
            <span class="shrink-0 tabular-nums text-text-strong">
              {{ formatTokens(row.promptTokens + row.completionTokens) }}
            </span>
          </div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              class="h-full rounded-full bg-accent transition-[width] duration-300"
              :style="{ width: `${share(row, rowMax(kindRows))}%` }"
            />
          </div>
        </div>
      </div>

      <p class="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
        仅统计服务端发起的 AI 调用；本机密钥代跑与语音合成、语音识别不产生 token 记录。
      </p>
    </SettingsCard>
  </div>
</template>
