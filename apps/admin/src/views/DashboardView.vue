<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi, type AdminStats } from '@/api/admin'
import StatCard from '@/components/StatCard.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/ui/Icon.vue'
import { formatBytes, formatNumber, formatRelative } from '@/utils/format'

const stats = ref<AdminStats | null>(null)
const loading = ref(true)
const errorMessage = ref('')

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    stats.value = await adminApi.stats()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <h1 class="text-[19px] font-semibold text-text-strong">概览</h1>
      <button
        class="flex items-center gap-1.5 text-[12px] text-muted hover:text-text"
        @click="load"
      >
        <Icon name="refresh" :size="13" />
        刷新
      </button>
    </div>

    <div v-if="errorMessage" class="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div v-else-if="loading" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="i in 8" :key="i" class="h-[92px] animate-pulse rounded-xl border border-line bg-surface-2" />
    </div>

    <template v-else-if="stats">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="用户总数" :value="formatNumber(stats.users.total)" icon="users" :hint="`停用 ${stats.users.disabled} · AI 角色 ${stats.users.bots}`" />
        <StatCard label="24h 活跃" :value="formatNumber(stats.users.active24h)" icon="sparkles" hint="最近一天有动静的用户" />
        <StatCard label="消息总数" :value="formatNumber(stats.messages.total)" icon="message" :hint="`24h 新增 ${formatNumber(stats.messages.last24h)}`" />
        <StatCard label="会话总数" :value="formatNumber(stats.conversations.total)" icon="hash" :hint="`私聊 ${stats.conversations.direct} · 群聊 ${stats.conversations.group} · AI ${stats.conversations.ai}`" />
        <StatCard label="动态数" :value="formatNumber(stats.posts.total)" icon="megaphone" />
        <StatCard label="存储用量" :value="formatBytes(stats.storage.bytes)" icon="folder" :hint="`附件 ${formatNumber(stats.storage.attachments)} 个`" />
        <StatCard label="AI tokens (24h)" :value="formatNumber(stats.ai.tokens24h)" icon="sparkles" :hint="`7d 累计 ${formatNumber(stats.ai.tokens7d)}`" />
        <StatCard label="注册人数" :value="formatNumber(stats.users.total)" icon="user" hint="含已停用账号" />
      </div>

      <section class="mt-6">
        <h2 class="mb-2 text-[14px] font-semibold text-text-strong">最近注册</h2>
        <div class="overflow-hidden rounded-xl border border-line bg-surface">
          <div v-if="stats.recentUsers.length === 0"><EmptyState text="还没有用户" /></div>
          <table v-else class="w-full text-left text-[12.5px]">
            <thead>
              <tr class="border-b border-line text-[11.5px] text-muted">
                <th class="px-4 py-2 font-medium">用户</th>
                <th class="px-4 py-2 font-medium">状态</th>
                <th class="px-4 py-2 font-medium">注册时间</th>
                <th class="px-4 py-2 font-medium">最近活跃</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in stats.recentUsers" :key="u.id" class="border-b border-line/60 last:border-b-0">
                <td class="px-4 py-2">
                  <span class="font-medium text-text-strong">{{ u.displayName }}</span>
                  <span class="ml-2 text-[11.5px] text-muted">@{{ u.username }}</span>
                </td>
                <td class="px-4 py-2"><StatusBadge :status="u.status" /></td>
                <td class="px-4 py-2 text-muted">{{ formatRelative(u.createdAt) }}</td>
                <td class="px-4 py-2 text-muted">{{ formatRelative(u.lastSeenAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
