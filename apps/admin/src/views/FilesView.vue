<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { adminApi, type AdminFile, type GcResult } from '@/api/admin'
import { resolveFileUrl } from '@/api/http'
import Pagination from '@/components/Pagination.vue'
import EmptyState from '@/components/EmptyState.vue'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import { formatBytes, formatNumber, formatTime } from '@/utils/format'

const PAGE_SIZE = 20

const KIND_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'file', label: '文件' },
  { value: 'sticker', label: '表情' },
  { value: 'avatar', label: '头像' },
  { value: 'background', label: '背景' },
]

const items = ref<AdminFile[]>([])
const total = ref(0)
const page = ref(1)
const query = ref('')
const kindFilter = ref('')
const includeDeleted = ref(false)
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')

const deleteTarget = ref<{ id: string; filename: string } | null>(null)
const deleting = ref(false)
const gcRunning = ref(false)
const gcResult = ref<GcResult | null>(null)

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.files.list({
      kind: kindFilter.value || undefined,
      q: query.value.trim() || undefined,
      page: page.value,
      includeDeleted: includeDeleted.value,
    })
    items.value = res.items
    total.value = res.total
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([query, kindFilter, includeDeleted], () => {
  page.value = 1
  void load()
})
watch(page, load)

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await adminApi.files.remove(deleteTarget.value.id)
    deleteTarget.value = null
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    deleting.value = false
  }
}

async function runGc(): Promise<void> {
  gcRunning.value = true
  gcResult.value = null
  try {
    const res = await adminApi.files.gc()
    gcResult.value = res.result
    notice.value = `GC 完成：清理 ${res.result.removedRows} 个附件行、${res.result.removedFiles} 个孤儿文件，释放 ${formatBytes(res.result.freedBytes)}`
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : 'GC 执行失败'
  } finally {
    gcRunning.value = false
  }
}

function fileUrl(id: string): string | null {
  const item = items.value.find((f) => f.id === id)
  return resolveFileUrl(item?.url)
}

function isPreviewable(mime: string): boolean {
  return mime.startsWith('image/')
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-[19px] font-semibold text-text-strong">文件存储</h1>
      <div class="flex items-center gap-2">
        <TextInput v-model="query" type="search" placeholder="搜索文件名" icon="search" size="sm" class="w-48" />
        <Segmented v-model="kindFilter" size="sm" aria-label="类型过滤" :options="KIND_OPTIONS" />
        <Button size="sm" :loading="gcRunning" icon="refresh" @click="runGc">执行 GC</Button>
      </div>
    </div>

    <div class="mb-3 flex items-center gap-4">
      <label class="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
        <input v-model="includeDeleted" type="checkbox" class="accent-[var(--accent)]" />
        显示已删除
      </label>
      <span v-if="notice" class="text-[12px] text-success">{{ notice }}</span>
    </div>

    <div v-if="gcResult" class="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-muted">
      扫描 {{ formatNumber(gcResult.scannedFiles) }} 个磁盘文件，{{ formatNumber(gcResult.referencedKeys) }} 个仍被引用；
      清理 {{ formatNumber(gcResult.removedRows) }} 个附件行、{{ formatNumber(gcResult.removedFiles) }} 个孤儿文件
    </div>

    <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div class="overflow-hidden rounded-xl border border-line bg-surface">
      <div v-if="loading && items.length === 0" class="p-4">
        <div v-for="i in 5" :key="i" class="mb-2 h-12 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <EmptyState v-else-if="items.length === 0" text="没有匹配的附件" />
      <table v-else class="w-full text-left text-[12.5px]">
        <thead>
          <tr class="border-b border-line text-[11.5px] text-muted">
            <th class="px-4 py-2 font-medium">文件</th>
            <th class="px-4 py-2 font-medium">类型</th>
            <th class="px-4 py-2 font-medium">上传者</th>
            <th class="px-4 py-2 font-medium">大小</th>
            <th class="px-4 py-2 font-medium">上传时间</th>
            <th class="px-4 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="f in items"
            :key="f.id"
            class="border-b border-line/60 transition-colors last:border-b-0 hover:bg-surface-2"
            :class="f.deleted ? 'opacity-50' : ''"
          >
            <td class="px-4 py-2.5">
              <div class="flex items-center gap-2.5">
                <img
                  v-if="isPreviewable(f.mime) && !f.deleted"
                  :src="fileUrl(f.id) ?? ''"
                  class="h-8 w-8 shrink-0 rounded-md border border-line object-cover"
                  loading="lazy"
                  alt=""
                />
                <div class="min-w-0">
                  <div class="max-w-56 truncate text-text-strong">{{ f.filename }}</div>
                  <div class="text-[11px] text-muted">{{ f.mime }}</div>
                </div>
              </div>
            </td>
            <td class="px-4 py-2.5">
              <span class="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted">{{ f.kind }}</span>
              <span v-if="f.deleted" class="ml-1.5 text-[11px] text-danger">已删除</span>
            </td>
            <td class="px-4 py-2.5 text-muted">{{ f.ownerName ?? '—' }}</td>
            <td class="px-4 py-2.5 text-muted tabular-nums">{{ formatBytes(f.size) }}</td>
            <td class="px-4 py-2.5 text-muted">{{ formatTime(f.createdAt) }}</td>
            <td class="px-4 py-2.5 text-right">
              <Button
                v-if="!f.deleted"
                size="sm"
                variant="danger-ghost"
                @click="deleteTarget = { id: f.id, filename: f.filename }"
              >
                删除
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="border-t border-line px-4 py-2.5">
        <Pagination v-model:page="page" :total="total" :page-size="PAGE_SIZE" />
      </div>
    </div>

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="删除这个文件？"
      :description="`「${deleteTarget?.filename ?? ''}」将标记为删除，引用它的消息/动态会失去该附件；磁盘文件由定时 GC 回收。`"
      confirm-text="删除"
      tone="danger"
      :loading="deleting"
      @update:open="(v: boolean) => { if (!v) deleteTarget = null }"
      @confirm="confirmDelete"
    />
  </div>
</template>
