<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { adminApi, type AdminAiUsage } from '@/api/admin'
import EmptyState from '@/components/EmptyState.vue'
import StatCard from '@/components/StatCard.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import { formatNumber } from '@/utils/format'

const window = ref<'24h' | '7d' | '30d'>('7d')
const usage = ref<AdminAiUsage | null>(null)
const loading = ref(true)
const errorMessage = ref('')

const KIND_LABELS: Record<string, string> = {
  chat: '私聊对话',
  group_reply: '群聊回复',
  proactive: '主动消息',
  moment: '动态',
  schedule: '日程',
  summary: '记忆摘要',
  vision: '看图',
  title: '标题生成',
  client_report: '客户端上报',
}

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    usage.value = await adminApi.aiUsage(window.value)
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(window, load)
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <h1 class="text-[19px] font-semibold text-text-strong">AI 用量</h1>
      <Segmented
        v-model="window"
        size="sm"
        aria-label="统计窗口"
        :options="[
          { value: '24h', label: '24 小时' },
          { value: '7d', label: '7 天' },
          { value: '30d', label: '30 天' },
        ]"
      />
    </div>

    <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div v-else-if="loading" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="i in 4" :key="i" class="h-[92px] animate-pulse rounded-xl border border-line bg-surface-2" />
    </div>

    <template v-else-if="usage">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="调用次数" :value="formatNumber(usage.totals.calls)" icon="sparkles" />
        <StatCard label="输入 tokens" :value="formatNumber(usage.totals.promptTokens)" />
        <StatCard label="输出 tokens" :value="formatNumber(usage.totals.completionTokens)" />
        <StatCard label="命中缓存" :value="formatNumber(usage.totals.cachedTokens)" hint="计费时通常按缓存折扣" />
      </div>

      <div class="mt-6 grid gap-4 lg:grid-cols-2">
        <section class="rounded-xl border border-line bg-surface">
          <h2 class="border-b border-line px-4 py-2.5 text-[13.5px] font-semibold text-text-strong">按用途</h2>
          <EmptyState v-if="usage.byKind.length === 0" text="这段时间没有 AI 调用" />
          <table v-else class="w-full text-left text-[12.5px]">
            <thead>
              <tr class="border-b border-line text-[11.5px] text-muted">
                <th class="px-4 py-2 font-medium">用途</th>
                <th class="px-4 py-2 font-medium">次数</th>
                <th class="px-4 py-2 font-medium">输入</th>
                <th class="px-4 py-2 font-medium">输出</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in usage.byKind" :key="row.kind" class="border-b border-line/60 last:border-b-0">
                <td class="px-4 py-2 text-text">{{ KIND_LABELS[row.kind] ?? row.kind }}</td>
                <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.calls) }}</td>
                <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.promptTokens) }}</td>
                <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.completionTokens) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="rounded-xl border border-line bg-surface">
          <h2 class="border-b border-line px-4 py-2.5 text-[13.5px] font-semibold text-text-strong">按用户（前 20）</h2>
          <EmptyState v-if="usage.byUser.length === 0" text="这段时间没有 AI 调用" />
          <table v-else class="w-full text-left text-[12.5px]">
            <thead>
              <tr class="border-b border-line text-[11.5px] text-muted">
                <th class="px-4 py-2 font-medium">用户</th>
                <th class="px-4 py-2 font-medium">次数</th>
                <th class="px-4 py-2 font-medium">输入</th>
                <th class="px-4 py-2 font-medium">输出</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in usage.byUser" :key="row.userId" class="border-b border-line/60 last:border-b-0">
                <td class="px-4 py-2 text-text">{{ row.displayName ?? '未知用户' }}</td>
                <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.calls) }}</td>
                <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.promptTokens) }}</td>
                <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.completionTokens) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <section v-if="usage.byModel.length > 0" class="mt-4 rounded-xl border border-line bg-surface">
        <h2 class="border-b border-line px-4 py-2.5 text-[13.5px] font-semibold text-text-strong">按模型</h2>
        <table class="w-full text-left text-[12.5px]">
          <thead>
            <tr class="border-b border-line text-[11.5px] text-muted">
              <th class="px-4 py-2 font-medium">模型</th>
              <th class="px-4 py-2 font-medium">次数</th>
              <th class="px-4 py-2 font-medium">输入</th>
              <th class="px-4 py-2 font-medium">输出</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in usage.byModel" :key="i" class="border-b border-line/60 last:border-b-0">
              <td class="px-4 py-2 font-mono text-[12px] text-text">{{ row.model ?? '未知' }}</td>
              <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.calls) }}</td>
              <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.promptTokens) }}</td>
              <td class="px-4 py-2 text-muted tabular-nums">{{ formatNumber(row.completionTokens) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>
