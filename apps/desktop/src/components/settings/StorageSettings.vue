<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { BackupFile, BackupSummary, CachePolicy, StorageReport } from '@nenochat/shared/storage/types'
import {
  BACKUP_PREFERENCE_KEYS,
  backupFileName,
  buildBackup,
  parseBackup,
  retargetBackup,
  summarizeBackup,
} from '@nenochat/shared/storage/backup'
import { CACHE_AGE_OPTIONS, CACHE_SIZE_OPTIONS } from '@nenochat/shared/storage/cache-policy'
import { buildStorageReport, formatBytes } from '@nenochat/shared/storage/stats'
import Icon from '@/components/ui/Icon.vue'
import type { IconName } from '@/components/ui/icons'
import { hasLocalDb } from '@/platform/db'
import {
  attachmentCacheStats,
  clearAttachmentCache,
  getCachePolicy,
  initFileCache,
  saveCachePolicy,
} from '@/platform/file-cache'
import { pickBackupFile, saveBackupFile } from '@/platform/backup'
import { clearMessageMirror, collectMirrorUsage, exportMirrorTables, importMirrorTables } from '@/db/dao/storage'
import { useServersStore } from '@/stores/servers'

const servers = useServersStore()

const loading = ref(true)
const busy = ref<'cache' | 'messages' | 'export' | 'pick' | ''>('')
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const report = ref<StorageReport | null>(null)
const cacheFileCount = ref(0)
const policy = ref<CachePolicy>(getCachePolicy())
const confirmClearMessages = ref(false)

interface PendingImport {
  fileName: string
  backup: BackupFile
  summary: BackupSummary
}
const pendingImport = ref<PendingImport | null>(null)
const importing = ref(false)

const categoryIcons: Record<string, IconName> = {
  messages: 'message',
  images: 'image',
  files: 'folder',
  stickers: 'smile',
  other: 'settings',
}

const exportable = computed(() => hasLocalDb() && Boolean(servers.currentId))

function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function share(bytes: number): number {
  const total = report.value?.totalBytes ?? 0
  if (total <= 0 || bytes <= 0) return 0
  return Math.max(2, Math.min(100, Math.round((bytes / total) * 100)))
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    await initFileCache()
    const [mirror, cache] = await Promise.all([collectMirrorUsage(), attachmentCacheStats()])
    report.value = buildStorageReport({
      mirror,
      cache: cache.entries.map((entry) => ({ kind: entry.kind, size: entry.size })),
    })
    cacheFileCount.value = cache.entries.length
  } catch (e) {
    error.value = e instanceof Error ? e.message : '统计失败'
  } finally {
    loading.value = false
  }
}

async function updatePolicy(patch: Partial<CachePolicy>): Promise<void> {
  policy.value = await saveCachePolicy({ ...policy.value, ...patch })
  await refresh()
}

async function clearCache(): Promise<void> {
  busy.value = 'cache'
  error.value = null
  notice.value = null
  try {
    const result = await clearAttachmentCache()
    notice.value =
      result.removed > 0
        ? `已清理 ${result.removed} 个缓存文件，释放 ${formatBytes(result.freedBytes)}`
        : '附件缓存已经是空的'
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '清理缓存失败'
  } finally {
    busy.value = ''
  }
}

async function clearMessages(): Promise<void> {
  if (!confirmClearMessages.value) {
    confirmClearMessages.value = true
    return
  }
  const serverId = servers.currentId
  if (!serverId) return

  busy.value = 'messages'
  error.value = null
  notice.value = null
  try {
    await clearMessageMirror(serverId)
    notice.value = '已清空本机消息镜像，重新联网后会按服务端记录补齐'
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '清理消息镜像失败'
  } finally {
    confirmClearMessages.value = false
    busy.value = ''
  }
}

async function exportBackup(): Promise<void> {
  const server = servers.current
  const serverId = servers.currentId
  if (!server || !serverId) return

  busy.value = 'export'
  error.value = null
  notice.value = null
  try {
    const tables = await exportMirrorTables(serverId)
    const preferences: Record<string, string> = {}
    for (const key of BACKUP_PREFERENCE_KEYS) {
      const value = localStorage.getItem(key)
      if (value !== null) preferences[key] = value
    }

    const backup = buildBackup({
      server: { id: server.id, name: server.name, baseUrl: server.baseUrl },
      tables,
      preferences,
      appVersion: '0.1.0',
    })
    const result = await saveBackupFile(backupFileName(server.name), JSON.stringify(backup, null, 2))
    if (!result) {
      notice.value = '已取消导出'
      return
    }
    notice.value = `已导出 ${formatBytes(result.bytes)}：${result.path ?? result.fileName}`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '导出失败'
  } finally {
    busy.value = ''
  }
}

async function chooseImport(): Promise<void> {
  busy.value = 'pick'
  error.value = null
  notice.value = null
  try {
    const picked = await pickBackupFile()
    if (!picked) return
    const parsed = parseBackup(picked.text)
    if (!parsed.ok) {
      pendingImport.value = null
      error.value = parsed.error
      return
    }
    pendingImport.value = {
      fileName: picked.fileName,
      backup: parsed.backup,
      summary: summarizeBackup(parsed.backup),
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取备份文件失败'
  } finally {
    busy.value = ''
  }
}

async function confirmImport(): Promise<void> {
  const serverId = servers.currentId
  const pending = pendingImport.value
  if (!serverId || !pending) return

  importing.value = true
  error.value = null
  notice.value = null
  try {
    const backup = retargetBackup(pending.backup, serverId)
    const result = await importMirrorTables(serverId, backup.tables, { replace: true })

    for (const key of BACKUP_PREFERENCE_KEYS) {
      const value = backup.preferences?.[key]
      if (typeof value === 'string') localStorage.setItem(key, value)
    }
    policy.value = getCachePolicy()

    pendingImport.value = null
    notice.value = `已恢复 ${result.rows} 条记录（${result.tables} 张表），重启应用后偏好完全生效`
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '导入失败'
  } finally {
    importing.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <div>
    <h2 class="mb-1 text-[15px] font-semibold text-text-strong">存储与数据</h2>
    <p class="mb-4 text-[12px] text-muted">
      消息、图片与文件会镜像到本机，离线也能查看；所有清理只影响当前设备
    </p>

    <p v-if="error" class="mb-3 text-[12px] text-danger">{{ error }}</p>
    <p v-else-if="notice" class="mb-3 text-[12px] text-accent">{{ notice }}</p>

    <!-- 占用总览 -->
    <section class="mb-4 rounded-xl border border-line bg-surface p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[12px] text-muted">本机占用</p>
          <p class="mt-0.5 text-[22px] font-semibold leading-tight text-text-strong">
            {{ loading ? '统计中…' : formatBytes(report?.totalBytes ?? 0) }}
          </p>
          <p class="mt-1 text-[11.5px] text-muted">
            本地镜像 {{ formatBytes(report?.mirrorBytes ?? 0) }}（全部服务器） · 附件缓存
            {{ formatBytes(report?.cacheBytes ?? 0) }}
          </p>
        </div>
        <button
          type="button"
          class="rounded-lg border border-line p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          title="重新统计"
          :disabled="loading"
          @click="refresh"
        >
          <Icon name="refresh" :size="14" />
        </button>
      </div>

      <div class="mt-3 space-y-2.5">
        <div v-for="category in report?.categories ?? []" :key="category.key">
          <div class="flex items-center gap-2 text-[12px]">
            <Icon :name="categoryIcons[category.key] ?? 'folder'" :size="13" class="text-muted" />
            <span class="min-w-0 flex-1 truncate text-text">{{ category.label }}</span>
            <span class="shrink-0 text-[11px] text-muted">{{ category.items }} 项</span>
            <span class="shrink-0 tabular-nums text-text-strong">{{ formatBytes(category.bytes) }}</span>
          </div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              class="h-full rounded-full bg-accent transition-[width] duration-300"
              :style="{ width: `${share(category.bytes)}%` }"
            />
          </div>
        </div>
      </div>

      <p v-if="!hasLocalDb()" class="mt-3 text-[11px] text-muted">
        浏览器模式没有本地镜像，统计仅包含附件缓存
      </p>
    </section>

    <!-- 附件缓存 -->
    <section class="mb-4 rounded-xl border border-line bg-surface p-4">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-[13px] font-medium text-text-strong">附件缓存</p>
          <p class="mt-0.5 text-[11.5px] text-muted">
            服务端图片与文件优先读本机缓存，已缓存 {{ cacheFileCount }} 个文件
          </p>
        </div>
      </div>

      <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">容量上限</span>
          <select
            class="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-[12.5px] text-text outline-none focus:border-accent"
            :value="policy.maxBytes"
            @change="updatePolicy({ maxBytes: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option v-for="bytes in CACHE_SIZE_OPTIONS" :key="bytes" :value="bytes">
              {{ formatBytes(bytes) }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] text-muted">闲置过期</span>
          <select
            class="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-[12.5px] text-text outline-none focus:border-accent"
            :value="policy.maxAgeMs"
            @change="updatePolicy({ maxAgeMs: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option v-for="option in CACHE_AGE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
      </div>

      <button
        type="button"
        class="mt-3 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-text hover:bg-surface-2 disabled:opacity-60"
        :disabled="busy === 'cache'"
        @click="clearCache"
      >
        {{ busy === 'cache' ? '清理中…' : '清理附件缓存' }}
      </button>
    </section>

    <!-- 本地镜像 -->
    <section class="mb-4 rounded-xl border border-line bg-surface p-4">
      <p class="text-[13px] font-medium text-text-strong">本地消息镜像</p>
      <p class="mt-0.5 text-[11.5px] leading-relaxed text-muted">
        清空后当前服务器在本机的聊天记录会被删除，服务端与其它设备不受影响；重新联网会重新同步历史消息。
      </p>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-lg border px-3 py-1.5 text-[12.5px] disabled:opacity-60"
          :class="
            confirmClearMessages
              ? 'border-danger bg-danger/10 text-danger'
              : 'border-line text-text hover:bg-surface-2'
          "
          :disabled="!hasLocalDb() || busy === 'messages'"
          @click="clearMessages"
        >
          {{ busy === 'messages' ? '清理中…' : confirmClearMessages ? '确认清空消息镜像' : '清空消息镜像' }}
        </button>
        <button
          v-if="confirmClearMessages"
          type="button"
          class="rounded-lg px-2 py-1.5 text-[12.5px] text-muted hover:text-text"
          @click="confirmClearMessages = false"
        >
          取消
        </button>
      </div>
    </section>

    <!-- 导出 -->
    <section class="mb-4 rounded-xl border border-line bg-surface p-4">
      <p class="text-[13px] font-medium text-text-strong">导出备份</p>
      <p class="mt-0.5 text-[11.5px] leading-relaxed text-muted">
        把当前服务器的本地镜像与本地偏好导出为一份 JSON 备份，可随时导入恢复。
      </p>
      <button
        type="button"
        class="mt-3 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-text disabled:opacity-60"
        :disabled="!exportable || busy === 'export'"
        @click="exportBackup"
      >
        <Icon name="copy" :size="13" />
        {{ busy === 'export' ? '导出中…' : '导出备份文件' }}
      </button>
    </section>

    <!-- 导入 -->
    <section class="rounded-xl border border-line bg-surface p-4">
      <p class="text-[13px] font-medium text-text-strong">导入备份</p>
      <p class="mt-0.5 text-[11.5px] leading-relaxed text-muted">
        导入会覆盖当前服务器在备份中出现的同名表数据，建议先导出一份当前备份。
      </p>

      <button
        type="button"
        class="mt-3 flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-text hover:bg-surface-2 disabled:opacity-60"
        :disabled="!hasLocalDb() || busy === 'pick' || importing"
        @click="chooseImport"
      >
        <Icon name="restore" :size="13" />
        {{ busy === 'pick' ? '读取中…' : '选择备份文件' }}
      </button>

      <div
        v-if="pendingImport"
        class="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-[11.5px] leading-relaxed"
      >
        <p class="truncate text-[12px] font-medium text-text-strong">{{ pendingImport.fileName }}</p>
        <p class="mt-0.5 text-muted">
          来自 {{ pendingImport.backup.server.name }} · 导出于
          {{ formatTime(pendingImport.backup.exportedAt) }}
        </p>
        <p class="mt-1 text-muted">
          消息 {{ pendingImport.summary.messages }} · 会话
          {{ pendingImport.summary.conversations }} · 成员 {{ pendingImport.summary.members }} · 用户
          {{ pendingImport.summary.users }} · 共 {{ pendingImport.summary.totalRows }} 条
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text disabled:opacity-60"
            :disabled="importing"
            @click="confirmImport"
          >
            {{ importing ? '导入中…' : '确认导入' }}
          </button>
          <button
            type="button"
            class="rounded-lg px-2 py-1 text-[12px] text-muted hover:text-text"
            :disabled="importing"
            @click="pendingImport = null"
          >
            取消
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
