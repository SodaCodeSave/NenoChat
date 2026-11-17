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
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import Field from '@/components/ui/form/Field.vue'
import Select from '@/components/ui/form/Select.vue'
import Button from '@/components/ui/form/Button.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
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

const sizeOptions = computed(() =>
  CACHE_SIZE_OPTIONS.map((bytes) => ({ value: bytes, label: formatBytes(bytes) })),
)
const ageOptions = computed(() =>
  CACHE_AGE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
)

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
  <div class="space-y-3">
    <Alert v-if="error" tone="danger">{{ error }}</Alert>
    <Alert v-else-if="notice" tone="success">{{ notice }}</Alert>

    <SettingsCard id="usage" title="占用总览" icon="folder">
      <template #actions>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          :loading="loading"
          :disabled="loading"
          @click="refresh"
        >
          重新统计
        </Button>
      </template>

      <div class="rounded-lg bg-surface-2 px-3.5 py-3">
        <p class="text-[11.5px] text-muted">本机占用</p>
        <p class="mt-0.5 text-[24px] font-semibold leading-tight tracking-tight text-text-strong">
          {{ loading ? '统计中…' : formatBytes(report?.totalBytes ?? 0) }}
        </p>
        <p class="mt-1 text-[11.5px] text-muted">
          本地镜像 {{ formatBytes(report?.mirrorBytes ?? 0) }}（全部服务器） · 附件缓存
          {{ formatBytes(report?.cacheBytes ?? 0) }}
        </p>
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
    </SettingsCard>

    <SettingsCard
      id="cache"
      title="附件缓存"
      description="服务端图片与文件优先读本机缓存，超过上限时先清理最久未使用的文件"
      icon="image"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="容量上限">
          <Select
            :model-value="policy.maxBytes"
            :options="sizeOptions"
            @update:model-value="
              (value) => value !== null && updatePolicy({ maxBytes: Number(value) })
            "
          />
        </Field>
        <Field label="闲置过期">
          <Select
            :model-value="policy.maxAgeMs"
            :options="ageOptions"
            @update:model-value="
              (value) => value !== null && updatePolicy({ maxAgeMs: Number(value) })
            "
          />
        </Field>
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p class="text-[11.5px] text-muted">已缓存 {{ cacheFileCount }} 个文件</p>
        <Button size="sm" :loading="busy === 'cache'" :disabled="busy !== ''" @click="clearCache">
          {{ busy === 'cache' ? '清理中…' : '清理附件缓存' }}
        </Button>
      </div>
    </SettingsCard>

    <SettingsCard
      id="mirror"
      title="本地消息镜像"
      description="清空后当前服务器在本机的聊天记录会被删除，服务端与其它设备不受影响；重新联网会重新同步历史消息"
      icon="trash"
      tone="danger"
    >
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="danger-ghost"
          size="sm"
          icon="trash"
          :disabled="!hasLocalDb() || busy === 'messages'"
          @click="confirmClearMessages = true"
        >
          {{ busy === 'messages' ? '清理中…' : '清空消息镜像' }}
        </Button>
      </div>

      <ConfirmDialog
        v-model:open="confirmClearMessages"
        title="清空本机消息镜像？"
        description="只会删除这台设备上的消息记录，服务端与其它设备不受影响。清空后需要联网重新同步。"
        confirm-text="确认清空"
        :loading="busy === 'messages'"
        @confirm="clearMessages"
      />
    </SettingsCard>

    <SettingsCard
      id="export"
      title="导出备份"
      description="把当前服务器的本地镜像与本地偏好导出为一份 JSON 备份，可随时导入恢复"
      icon="copy"
    >
      <Button
        variant="primary"
        size="sm"
        icon="copy"
        :loading="busy === 'export'"
        :disabled="!exportable || busy !== ''"
        @click="exportBackup"
      >
        {{ busy === 'export' ? '导出中…' : '导出备份文件' }}
      </Button>
    </SettingsCard>

    <SettingsCard
      id="import"
      title="导入备份"
      description="导入会覆盖当前服务器在备份中出现的同名表数据，建议先导出一份当前备份"
      icon="restore"
    >
      <Button
        size="sm"
        icon="restore"
        :loading="busy === 'pick'"
        :disabled="!hasLocalDb() || busy !== '' || importing"
        @click="chooseImport"
      >
        {{ busy === 'pick' ? '读取中…' : '选择备份文件' }}
      </Button>

      <div
        v-if="pendingImport"
        class="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[11.5px] leading-relaxed"
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
      </div>

      <ConfirmDialog
        :open="Boolean(pendingImport)"
        title="导入这份备份？"
        description="当前服务器在备份中出现的同名表会被覆盖，此操作不可撤销。"
        confirm-text="确认导入"
        :loading="importing"
        @update:open="(value) => !value && (pendingImport = null)"
        @confirm="confirmImport"
      >
        <div v-if="pendingImport" class="rounded-lg bg-surface-2 px-3 py-2 text-[11.5px] text-muted">
          将恢复 {{ pendingImport.summary.totalRows }} 条记录，来自
          {{ pendingImport.backup.server.name }}
        </div>
      </ConfirmDialog>
    </SettingsCard>
  </div>
</template>
