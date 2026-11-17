<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Connector, ConnectorType } from '@nenochat/shared'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import Field from '@/components/ui/form/Field.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Textarea from '@/components/ui/form/Textarea.vue'
import NumberInput from '@/components/ui/form/NumberInput.vue'
import Button from '@/components/ui/form/Button.vue'
import Switch from '@/components/ui/form/Switch.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import { connectorApi } from '@/api/connectors'
import { CONNECTOR_PRESETS, type ConnectorPreset } from '@/config/connectors'

const connectors = ref<Connector[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const activePreset = ref<ConnectorPreset | null>(null)
const editingId = ref<string | null>(null)
const saving = ref(false)
const testingId = ref<string | null>(null)
const togglingId = ref<string | null>(null)
const pendingRemove = ref<Connector | null>(null)
const removing = ref(false)

const form = ref({
  name: '',
  apiKey: '',
  cookie: '',
  baseUrl: '',
  count: 5 as number | null,
  maxComments: 8 as number | null,
})

function connectorOf(type: ConnectorType): Connector | null {
  return connectors.value.find((item) => item.type === type) ?? null
}

const editingConnector = computed(() =>
  editingId.value ? (connectors.value.find((item) => item.id === editingId.value) ?? null) : null,
)

async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await connectorApi.list()
    connectors.value = result.connectors
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取连接器失败'
  } finally {
    loading.value = false
  }
}

function openForm(preset: ConnectorPreset): void {
  const existing = connectorOf(preset.type)
  activePreset.value = preset
  editingId.value = existing?.id ?? null
  form.value = {
    name: existing?.name ?? preset.name,
    apiKey: '',
    cookie: '',
    baseUrl: existing?.config.baseUrl ?? '',
    count: existing?.config.count ?? 5,
    maxComments: existing?.config.maxComments ?? 8,
  }
  error.value = null
  notice.value = null
}

function closeForm(): void {
  activePreset.value = null
  editingId.value = null
}

async function save(): Promise<void> {
  const preset = activePreset.value
  if (!preset) return
  error.value = null
  notice.value = null

  const name = form.value.name.trim()
  if (!name) {
    error.value = '给连接器起个名字'
    return
  }
  if (preset.type === 'deepseek_search' && !editingId.value && !form.value.apiKey.trim()) {
    error.value = 'DeepSeek 搜索需要填写 API Key'
    return
  }

  const config =
    preset.type === 'deepseek_search'
      ? {
          baseUrl: form.value.baseUrl.trim() || null,
          count: form.value.count ?? 5,
        }
      : { maxComments: form.value.maxComments ?? 8 }

  // 编辑时留空表示保持原凭据不变，避免误清空
  const secret: { apiKey?: string; cookie?: string } = {}
  if (preset.type === 'deepseek_search' && form.value.apiKey.trim()) {
    secret.apiKey = form.value.apiKey.trim()
  }
  if (preset.type === 'bilibili' && form.value.cookie.trim()) {
    secret.cookie = form.value.cookie.trim()
  }

  saving.value = true
  try {
    if (editingId.value) {
      await connectorApi.update(editingId.value, {
        name,
        config,
        ...(Object.keys(secret).length > 0 ? { secret } : {}),
      })
    } else {
      await connectorApi.create({ type: preset.type, name, enabled: true, config, secret })
    }
    await load()
    closeForm()
    notice.value = `${name} 已保存`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

function replaceConnector(next: Connector): void {
  const index = connectors.value.findIndex((item) => item.id === next.id)
  if (index >= 0) connectors.value[index] = next
  else connectors.value.push(next)
}

async function toggle(connector: Connector, enabled: boolean): Promise<void> {
  error.value = null
  togglingId.value = connector.id
  try {
    const result = await connectorApi.toggle(connector.id, enabled)
    replaceConnector(result.connector)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '切换状态失败'
  } finally {
    togglingId.value = null
  }
}

async function test(connector: Connector): Promise<void> {
  error.value = null
  notice.value = null
  testingId.value = connector.id
  try {
    const result = await connectorApi.test(connector.id)
    replaceConnector(result.connector)
    if (result.ok) notice.value = result.message
    else error.value = result.message
  } catch (e) {
    error.value = e instanceof Error ? e.message : '测试失败'
  } finally {
    testingId.value = null
  }
}

async function remove(): Promise<void> {
  const target = pendingRemove.value
  if (!target) return
  removing.value = true
  error.value = null
  try {
    await connectorApi.remove(target.id)
    connectors.value = connectors.value.filter((item) => item.id !== target.id)
    if (editingId.value === target.id) closeForm()
    pendingRemove.value = null
    notice.value = '连接器已删除'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    removing.value = false
  }
}

function statusLabel(connector: Connector | null): string {
  if (!connector) return '未配置'
  return connector.enabled ? '已启用' : '已停用'
}

function statusClass(connector: Connector | null): string {
  if (!connector) return 'bg-surface-3 text-muted'
  return connector.enabled ? 'bg-success/10 text-success' : 'bg-surface-3 text-muted'
}

function lastTestText(connector: Connector): string {
  if (connector.lastTestAt === null || connector.lastTestAt === undefined) return '还没有测试过'
  const time = new Date(connector.lastTestAt)
  const stamp = `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  const result = connector.lastTestOk ? '通过' : '失败'
  return `上次测试 ${stamp} · ${result}${connector.lastTestMessage ? `：${connector.lastTestMessage}` : ''}`
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="space-y-3">
    <Alert v-if="error" tone="danger">{{ error }}</Alert>
    <Alert v-else-if="notice" tone="success">{{ notice }}</Alert>

    <SettingsCard
      id="connectors"
      title="连接器"
      description="连接第三方数据源。凭据统一加密保存在服务端，客户端只看到掩码。"
      icon="globe"
    >
      <p v-if="loading" class="py-2 text-[12px] text-muted">读取中…</p>

      <div v-else class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div
          v-for="preset in CONNECTOR_PRESETS"
          :key="preset.id"
          class="flex flex-col rounded-lg border border-line bg-surface-2 p-3"
        >
          <div class="flex items-start gap-2.5">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface">
              <img :src="preset.icon" :alt="preset.label" class="h-5 w-5 object-contain" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-text-strong">
                <img
                  v-if="preset.textIcon"
                  :src="preset.textIcon"
                  :alt="preset.label"
                  class="h-3.5 w-auto max-w-[84px] object-contain"
                />
                <span v-else>{{ preset.label }}</span>
                <span
                  class="rounded px-1.5 text-[10px] font-normal"
                  :class="statusClass(connectorOf(preset.type))"
                >
                  {{ statusLabel(connectorOf(preset.type)) }}
                </span>
              </p>
              <p class="mt-1 text-[11.5px] leading-relaxed text-muted">{{ preset.description }}</p>
            </div>
            <Switch
              v-if="connectorOf(preset.type)"
              :model-value="connectorOf(preset.type)!.enabled"
              :disabled="togglingId === connectorOf(preset.type)!.id"
              size="sm"
              :aria-label="`启用 ${preset.label}`"
              @update:model-value="(value) => toggle(connectorOf(preset.type)!, value)"
            />
          </div>

          <p class="mt-2 text-[11px] leading-relaxed text-muted/80">{{ preset.capability }}</p>

          <p
            v-if="connectorOf(preset.type)"
            class="mt-1.5 truncate text-[10.5px]"
            :class="connectorOf(preset.type)!.lastTestOk === false ? 'text-danger' : 'text-muted'"
            :title="lastTestText(connectorOf(preset.type)!)"
          >
            {{ lastTestText(connectorOf(preset.type)!) }}
          </p>

          <div class="mt-auto flex flex-wrap items-center gap-1.5 pt-2.5">
            <Button size="sm" variant="secondary" icon="edit" @click="openForm(preset)">
              {{ connectorOf(preset.type) ? '编辑' : '配置' }}
            </Button>
            <Button
              v-if="connectorOf(preset.type)"
              size="sm"
              variant="ghost"
              icon="refresh"
              :loading="testingId === connectorOf(preset.type)!.id"
              @click="test(connectorOf(preset.type)!)"
            >
              测试
            </Button>
            <Button
              v-if="connectorOf(preset.type)"
              size="sm"
              variant="ghost"
              icon="trash"
              class="ml-auto hover:!bg-danger/10 hover:!text-danger"
              aria-label="删除连接器"
              @click="pendingRemove = connectorOf(preset.type)"
            />
          </div>
        </div>
      </div>

      <div
        v-if="activePreset"
        class="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3"
      >
        <div class="flex items-center justify-between gap-2">
          <p class="text-[12.5px] font-medium text-text-strong">
            {{ editingConnector ? `编辑 ${activePreset.label}` : `配置 ${activePreset.label}` }}
          </p>
          <Button size="sm" variant="ghost" icon="close" @click="closeForm">收起</Button>
        </div>

        <Field label="名称" for-id="connector-name">
          <TextInput id="connector-name" v-model="form.name" :placeholder="activePreset.name" />
        </Field>

        <template v-if="activePreset.type === 'deepseek_search'">
          <Field
            label="API Key"
            for-id="connector-key"
            :hint="
              editingConnector?.secretMasked.apiKey
                ? `已保存：${editingConnector.secretMasked.apiKey}，留空表示不修改`
                : '服务端加密保存，接口只回显掩码'
            "
          >
            <TextInput
              id="connector-key"
              v-model="form.apiKey"
              type="password"
              placeholder="sk-..."
              autocomplete="off"
              spellcheck="false"
            />
          </Field>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Base URL" for-id="connector-base" optional hint="留空使用 api.deepseek.com">
              <TextInput
                id="connector-base"
                v-model="form.baseUrl"
                placeholder="https://api.deepseek.com"
                spellcheck="false"
              />
            </Field>
            <Field label="结果条数" for-id="connector-count" hint="1-20 条，默认 5">
              <NumberInput
                id="connector-count"
                v-model="form.count"
                :min="1"
                :max="20"
                suffix="条"
              />
            </Field>
          </div>
        </template>

        <template v-else>
          <Field
            label="B 站 Cookie"
            for-id="connector-cookie"
            optional
            :hint="
              editingConnector?.secretMasked.cookie
                ? `已保存：${editingConnector.secretMasked.cookie}，留空表示不修改`
                : '登录 B 站后从浏览器开发者工具复制 Cookie；填了才能抓取字幕，否则只能读公开信息与热评'
            "
          >
            <Textarea
              id="connector-cookie"
              v-model="form.cookie"
              :rows="3"
              mono
              placeholder="SESSDATA=...; bili_jct=...;"
              spellcheck="false"
            />
          </Field>
          <Field label="热评条数" for-id="connector-comments" hint="无字幕降级时取多少条热评，0 表示不取">
            <NumberInput
              id="connector-comments"
              v-model="form.maxComments"
              :min="0"
              :max="20"
              suffix="条"
            />
          </Field>
        </template>

        <div class="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button size="sm" variant="ghost" @click="closeForm">取消</Button>
          <Button size="sm" variant="primary" :loading="saving" @click="save">保存连接器</Button>
        </div>
      </div>
    </SettingsCard>

    <ConfirmDialog
      :open="Boolean(pendingRemove)"
      title="删除这个连接器？"
      :description="`「${pendingRemove?.name ?? ''}」的加密凭据会被一并清除，已缓存的视频总结保留。`"
      confirm-text="删除连接器"
      :loading="removing"
      @update:open="(value) => !value && (pendingRemove = null)"
      @confirm="remove"
    />
  </div>
</template>
