<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { adminApi, type AdminAuditEntry } from '@/api/admin'
import Pagination from '@/components/Pagination.vue'
import EmptyState from '@/components/EmptyState.vue'
import { formatTime } from '@/utils/format'

const PAGE_SIZE = 20

const ACTION_LABELS: Record<string, string> = {
  'user.disable': '停用用户',
  'user.enable': '启用用户',
  'user.reset_password': '重置密码',
  'user.set_admin': '设置管理员',
  'user.delete': '删除用户',
  'device.remove': '移除设备',
  'invite.create': '创建邀请码',
  'invite.delete': '删除邀请码',
  'message.recall': '撤回消息',
  'post.delete': '删除动态',
  'comment.delete': '删除评论',
  'file.delete': '删除附件',
  'file.gc': '执行存储 GC',
  'settings.update': '修改服务器设置',
}

const items = ref<AdminAuditEntry[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(true)
const errorMessage = ref('')

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.audit(page.value)
    items.value = res.items
    total.value = res.total
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(page, load)

function actionLabel(entry: AdminAuditEntry): string {
  return ACTION_LABELS[entry.action] ?? entry.action
}

function targetLabel(entry: AdminAuditEntry): string {
  if (!entry.targetId) return '—'
  if (entry.targetType === 'invite') return entry.targetId
  return `${entry.targetId.slice(0, 10)}…`
}

function detailLabel(entry: AdminAuditEntry): string {
  const d = entry.detail
  if (d === null || d === undefined) return ''
  return Object.entries(d as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('，')
}
</script>

<template>
  <div>
    <h1 class="mb-4 text-[19px] font-semibold text-text-strong">审计日志</h1>

    <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div class="overflow-hidden rounded-xl border border-line bg-surface">
      <div v-if="loading && items.length === 0" class="p-4">
        <div v-for="i in 6" :key="i" class="mb-2 h-9 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <EmptyState v-else-if="items.length === 0" text="还没有管理操作记录" />
      <table v-else class="w-full text-left text-[12.5px]">
        <thead>
          <tr class="border-b border-line text-[11.5px] text-muted">
            <th class="px-4 py-2 font-medium">时间</th>
            <th class="px-4 py-2 font-medium">操作人</th>
            <th class="px-4 py-2 font-medium">操作</th>
            <th class="px-4 py-2 font-medium">对象</th>
            <th class="px-4 py-2 font-medium">明细</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in items" :key="entry.id" class="border-b border-line/60 last:border-b-0">
            <td class="whitespace-nowrap px-4 py-2.5 text-muted">{{ formatTime(entry.createdAt) }}</td>
            <td class="px-4 py-2.5 text-text">{{ entry.actorName ?? entry.actorId.slice(0, 10) }}</td>
            <td class="px-4 py-2.5">
              <span class="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-text">{{ actionLabel(entry) }}</span>
            </td>
            <td class="px-4 py-2.5 font-mono text-[11.5px] text-muted">{{ targetLabel(entry) }}</td>
            <td class="px-4 py-2.5 text-[11.5px] text-muted">{{ detailLabel(entry) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="border-t border-line px-4 py-2.5">
        <Pagination v-model:page="page" :total="total" :page-size="PAGE_SIZE" />
      </div>
    </div>
  </div>
</template>
