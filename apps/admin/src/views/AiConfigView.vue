<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  adminApi,
  type AdminAiProvider,
  type AdminAiProviderModel,
  type AdminBalanceItem,
} from '@/api/admin'
import Pagination from '@/components/Pagination.vue'
import EmptyState from '@/components/EmptyState.vue'
import ModelPicker from '@/components/ModelPicker.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import Field from '@/components/ui/form/Field.vue'
import NumberInput from '@/components/ui/form/NumberInput.vue'
import Switch from '@/components/ui/form/Switch.vue'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import Icon from '@/components/ui/Icon.vue'
import { AI_PROVIDER_PRESETS, matchProviderIcon } from '@/config/ai-providers'
import { formatTime } from '@/utils/format'

const BALANCE_PAGE_SIZE = 20

/* ------------------------------ 加载态 ------------------------------ */

const sharedMode = ref(false)
const providers = ref<AdminAiProvider[]>([])
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.aiConfig.providers()
    sharedMode.value = res.sharedMode
    providers.value = res.providers
    await loadBalances(balancePage.value)
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

/* ------------------------------ 共享模式 ------------------------------ */

const savingMode = ref(false)

async function toggleSharedMode(enabled: boolean): Promise<void> {
  savingMode.value = true
  errorMessage.value = ''
  try {
    const res = await adminApi.aiConfig.setSharedMode(enabled)
    sharedMode.value = res.sharedMode
    notice.value = enabled ? '全服共享已开启，未自配供应商的成员将走服务器供应商并计费' : '全服共享已关闭'
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '保存失败'
    sharedMode.value = !enabled
  } finally {
    savingMode.value = false
  }
}

/* ------------------------------ 供应商表单 ------------------------------ */

const showProviderForm = ref(false)
const editingProviderId = ref<string | null>(null)
const savingProvider = ref(false)
const testing = ref(false)
const modelsByProvider = ref<Record<string, string[]>>({})
const loadingModels = ref<string | null>(null)

interface ProviderFormState {
  name: string
  baseUrl: string
  model: string
  apiKey: string
  visionModel: string
  contextWindow: number | null
  models: AdminAiProviderModel[]
}

const emptyForm = (): ProviderFormState => ({
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  visionModel: '',
  contextWindow: null,
  models: [],
})
const providerForm = ref<ProviderFormState>(emptyForm())

/** 表单可选择的模型：AI 列表里启用的优先，没有列表时用拉取到的全量 */
const formSelectableModels = computed(() => {
  const enabled = providerForm.value.models.filter((m) => m.enabled).map((m) => m.model)
  if (enabled.length > 0) return enabled
  const fetched = editingProviderId.value ? modelsByProvider.value[editingProviderId.value] : []
  return fetched ?? []
})

const editingProvider = computed(
  () => providers.value.find((p) => p.id === editingProviderId.value) ?? null,
)

function applyPreset(presetId: string): void {
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === presetId)
  if (!preset) return
  providerForm.value.name = preset.name
  providerForm.value.baseUrl = preset.baseUrl
  providerForm.value.model = preset.model
}

function openAddForm(): void {
  editingProviderId.value = null
  providerForm.value = emptyForm()
  showProviderForm.value = true
}

function openEditForm(provider: AdminAiProvider): void {
  editingProviderId.value = provider.id
  providerForm.value = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: '',
    visionModel: provider.visionModel ?? '',
    contextWindow: provider.contextWindow ?? null,
    models: (provider.models ?? []).map((m) => ({ ...m })),
  }
  showProviderForm.value = true
  void loadModels(provider.id)
}

function toggleProviderForm(): void {
  if (showProviderForm.value) {
    showProviderForm.value = false
    editingProviderId.value = null
  } else {
    openAddForm()
  }
}

/* AI 列表编辑 */

function addManualModel(): void {
  const name = manualModelName.value.trim()
  if (!name) return
  if (providerForm.value.models.some((m) => m.model === name)) {
    manualModelName.value = ''
    return
  }
  providerForm.value.models.push({ model: name, enabled: true, priceInput: null, priceOutput: null, priceCached: null })
  manualModelName.value = ''
}

const manualModelName = ref('')

async function importFormModels(): Promise<void> {
  const baseUrl = providerForm.value.baseUrl.trim()
  if (!baseUrl) {
    errorMessage.value = '先填 Base URL 再导入模型列表'
    return
  }
  loadingModels.value = editingProviderId.value ?? 'form'
  errorMessage.value = ''
  try {
    const apiKey = providerForm.value.apiKey || undefined
    const res = await adminApi.aiConfig.previewModels({ baseUrl, apiKey })
    const existing = new Map(providerForm.value.models.map((m) => [m.model, m]))
    providerForm.value.models = res.models.map(
      (model) =>
        existing.get(model) ?? { model, enabled: true, priceInput: null, priceOutput: null, priceCached: null },
    )
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '拉取模型列表失败'
  } finally {
    loadingModels.value = null
  }
}

async function loadModels(providerId: string): Promise<void> {
  if (modelsByProvider.value[providerId]) return
  loadingModels.value = providerId
  try {
    const res = await adminApi.aiConfig.providerModels(providerId)
    modelsByProvider.value[providerId] = res.models
  } catch {
    modelsByProvider.value[providerId] = []
  } finally {
    loadingModels.value = null
  }
}

/* 保存 / 测试 / 余额探测 */

async function saveProvider(): Promise<void> {
  if (!providerForm.value.name.trim() || !providerForm.value.baseUrl.trim() || !providerForm.value.model.trim()) {
    errorMessage.value = '名称、Base URL 与模型为必填'
    return
  }
  savingProvider.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    const body: Record<string, unknown> = {
      name: providerForm.value.name.trim(),
      baseUrl: providerForm.value.baseUrl.trim(),
      model: providerForm.value.model.trim(),
      visionModel: providerForm.value.visionModel.trim() || null,
      contextWindow: providerForm.value.contextWindow,
      models: providerForm.value.models,
    }
    // 编辑态密钥留空 = 不改动；空串 = 清空
    body.apiKey = providerForm.value.apiKey.length > 0 ? providerForm.value.apiKey : editingProviderId.value ? '' : undefined
    const res =
      editingProviderId.value !== null
        ? await adminApi.aiConfig.updateProvider(editingProviderId.value, body)
        : await adminApi.aiConfig.createProvider(body)
    const updated = res.provider
    const index = providers.value.findIndex((p) => p.id === updated.id)
    if (index >= 0) providers.value.splice(index, 1, updated)
    else providers.value.push(updated)
    showProviderForm.value = false
    editingProviderId.value = null
    notice.value = `供应商「${updated.name}」已保存`
    void loadModels(updated.id)
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    savingProvider.value = false
  }
}

async function testConnection(): Promise<void> {
  testing.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    const editingId = editingProviderId.value
    const result =
      editingId && !providerForm.value.apiKey
        ? await adminApi.aiConfig.testProviderStored(editingId, {
            baseUrl: providerForm.value.baseUrl.trim() || undefined,
            model: providerForm.value.model.trim() || undefined,
          })
        : await adminApi.aiConfig.testProvider({
            baseUrl: providerForm.value.baseUrl.trim(),
            apiKey: providerForm.value.apiKey,
            model: providerForm.value.model.trim(),
          })
    notice.value = result.ok ? `连接成功：${result.sample.slice(0, 40)}` : '连接失败'
  } catch (e) {
    notice.value = ''
    errorMessage.value = e instanceof Error ? e.message : '测试失败'
  } finally {
    testing.value = false
  }
}

async function refreshProviderBalance(provider: AdminAiProvider): Promise<void> {
  errorMessage.value = ''
  try {
    const res = await adminApi.aiConfig.providerBalance(provider.id)
    const index = providers.value.findIndex((p) => p.id === provider.id)
    if (index >= 0) providers.value.splice(index, 1, res.provider)
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '余额探测失败'
  }
}

/* 删除确认 */

const deleteTarget = ref<AdminAiProvider | null>(null)
const deleting = ref(false)

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await adminApi.aiConfig.removeProvider(deleteTarget.value.id)
    deleteTarget.value = null
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    deleting.value = false
  }
}

function enabledCountOf(provider: AdminAiProvider): number {
  const list = provider.models ?? []
  if (list.length === 0) return -1
  return list.filter((m) => m.enabled).length
}

function balanceText(provider: AdminAiProvider): string {
  if (!provider.balance) return ''
  const value = Number(provider.balance)
  if (!Number.isFinite(value)) return provider.balance
  if (value >= 1e8) return '不限'
  const currency = provider.balanceCurrency === 'USD' ? '$' : provider.balanceCurrency === 'CNY' ? '¥' : ''
  return `${currency}${value}`
}

/* ------------------------------ 用户余额 ------------------------------ */

const balances = ref<AdminBalanceItem[]>([])
const balanceTotal = ref(0)
const balancePage = ref(1)
const balancesLoading = ref(false)

const adjustTarget = ref<AdminBalanceItem | null>(null)
const adjustDelta = ref<number | null>(1)
const adjustSaving = ref(false)
const adjustError = ref('')

async function loadBalances(page: number): Promise<void> {
  balancesLoading.value = true
  try {
    const res = await adminApi.aiConfig.balances(page)
    balances.value = res.items
    balanceTotal.value = res.total
  } catch {
    /* 余额列表失败不打断主界面 */
  } finally {
    balancesLoading.value = false
  }
}

watch(balancePage, (page) => void loadBalances(page))

function openAdjust(item: AdminBalanceItem): void {
  adjustTarget.value = item
  adjustDelta.value = 10
  adjustError.value = ''
}

async function confirmAdjust(): Promise<void> {
  const target = adjustTarget.value
  const delta = adjustDelta.value
  if (!target || delta === null || delta === 0 || !Number.isFinite(delta)) {
    adjustError.value = '请输入非 0 的金额'
    return
  }
  adjustSaving.value = true
  adjustError.value = ''
  try {
    const res = await adminApi.aiConfig.adjustBalance(target.userId, delta)
    notice.value = `「${target.displayName}」余额已调整为 ¥${res.balance.toFixed(2)}`
    adjustTarget.value = null
    await loadBalances(balancePage.value)
  } catch (e) {
    adjustError.value = e instanceof Error ? e.message : '调整失败'
  } finally {
    adjustSaving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <h1 class="mb-4 text-[19px] font-semibold text-text-strong">AI 配置</h1>

    <Alert v-if="notice" tone="success" class="mb-3">
      {{ notice }}
      <button class="ml-1 underline" @click="notice = ''">知道了</button>
    </Alert>

    <div v-if="errorMessage" class="mb-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {{ errorMessage }}
    </div>

    <div v-if="loading" class="space-y-3">
      <div v-for="i in 3" :key="i" class="h-24 animate-pulse rounded-xl border border-line bg-surface-2" />
    </div>

    <template v-else>
      <SettingsCard
        id="shared"
        title="全服共享模式"
        description="开启后成员没配自己的供应商时，AI 调用自动走服务器供应商，并按模型单价从个人余额扣费"
        icon="cpu"
      >
        <SettingRow
          label="启用全服共享"
          :description="
            sharedMode
              ? '已开启：自有供应商优先，没配的走服务器供应商并计费（余额耗尽会被拒绝）'
              : '已关闭：各成员使用自己配置的供应商，服务器供应商不参与解析'
          "
        >
          <Switch :model-value="sharedMode" :disabled="savingMode" @update:model-value="toggleSharedMode" />
        </SettingRow>
        <SettingRow
          label="模型计费单价"
          description="在供应商的「AI 列表」里按模型配置输入/输出单价（元/百万 token）；没配价格的模型不扣费"
        >
          <span class="text-[11.5px] text-muted">元 / 百万 token</span>
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        id="providers"
        class="mt-3"
        title="服务器供应商"
        description="供应商密钥加密保存在服务端，仅全服共享模式下参与解析"
        icon="sparkles"
      >
        <template #actions>
          <Button
            size="sm"
            :icon="showProviderForm ? 'close' : 'plus'"
            @click="toggleProviderForm"
          >
            {{ showProviderForm ? '收起' : '添加供应商' }}
          </Button>
        </template>

        <div v-if="providers.length === 0 && !showProviderForm" class="py-6 text-center text-[12.5px] text-muted">
          还没有服务器供应商。添加一个并开启共享模式，成员就能直接使用
        </div>

        <div v-else class="space-y-2">
          <div
            v-for="p in providers"
            :key="p.id"
            class="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
            :class="editingProviderId === p.id ? 'border-accent/60 bg-accent-soft/30' : 'border-line bg-surface-2'"
          >
            <span class="grid h-7 w-7 shrink-0 place-items-center">
              <SvgIcon
                v-if="matchProviderIcon(p.name, p.baseUrl)"
                :source="matchProviderIcon(p.name, p.baseUrl)!"
                :label="p.name"
              />
              <Icon v-else name="sparkles" :size="16" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[12.5px] font-medium text-text-strong">{{ p.name }}</span>
                <span
                  v-if="!p.apiKeyMasked"
                  class="rounded-full bg-danger/10 px-1.5 py-0.5 text-[10.5px] text-danger"
                >
                  未配置密钥
                </span>
                <span
                  v-else-if="p.balance"
                  class="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent"
                >
                  余额 {{ balanceText(p) }}
                </span>
                <span
                  v-if="enabledCountOf(p) >= 0"
                  class="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10.5px] text-muted"
                >
                  AI {{ enabledCountOf(p) }}/{{ p.models?.length }}
                </span>
              </div>
              <div class="mt-0.5 truncate text-[11.5px] text-muted">
                {{ p.model }} · {{ p.baseUrl }}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" @click="refreshProviderBalance(p)">查余额</Button>
              <Button size="sm" variant="ghost" @click="openEditForm(p)">编辑</Button>
              <Button size="sm" variant="danger-ghost" @click="deleteTarget = p">删除</Button>
            </div>
          </div>
        </div>

        <!-- 供应商编辑表单 -->
        <div v-if="showProviderForm" class="mt-4 space-y-4 rounded-xl border border-line bg-surface-2 p-4">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="mr-1 text-[11.5px] text-muted">快速预设</span>
            <button
              v-for="preset in AI_PROVIDER_PRESETS"
              :key="preset.id"
              class="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-accent/50 hover:text-text"
              @click="applyPreset(preset.id)"
            >
              <SvgIcon :source="preset.icon" :label="preset.label" class="h-3.5 w-3.5" />
              {{ preset.label }}
            </button>
          </div>

          <div class="grid gap-3 md:grid-cols-2">
            <Field label="名称">
              <TextInput v-model="providerForm.name" placeholder="供应商名称" />
            </Field>
            <Field label="模型" hint="默认模型；角色可用模型覆盖">
              <ModelPicker v-model="providerForm.model" :models="formSelectableModels" />
            </Field>
            <Field label="Base URL" class="md:col-span-2">
              <TextInput v-model="providerForm.baseUrl" placeholder="https://api.example.com/v1" />
            </Field>
            <Field
              label="API Key"
              class="md:col-span-2"
              :hint="editingProviderId ? '留空表示不改动密钥；输入空格后清空可删除密钥' : '服务端加密存储，不会回显'"
            >
              <TextInput v-model="providerForm.apiKey" type="password" placeholder="sk-..." />
            </Field>
            <Field label="识图模型" hint="可选；配置后表情识别等功能可用">
              <ModelPicker v-model="providerForm.visionModel" :models="formSelectableModels" />
            </Field>
            <Field label="上下文窗口" hint="可选；用于记忆压缩估算">
              <NumberInput v-model="providerForm.contextWindow" :min="256" :step="1000" allow-empty suffix="token" />
            </Field>
          </div>

          <div>
            <div class="mb-2 flex items-center justify-between">
              <div class="text-[12px] font-medium text-text-strong">
                AI 列表（{{ providerForm.models.length }}）
                <span class="ml-1.5 font-normal text-muted">每模型的开关与计费单价（元/百万 token）</span>
              </div>
              <div class="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" :loading="loadingModels === (editingProviderId ?? 'form')" @click="importFormModels">
                  导入模型列表
                </Button>
              </div>
            </div>
            <div v-if="providerForm.models.length === 0" class="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-muted">
              填好 Base URL 后「导入模型列表」，或手动添加。未出现在这里（或未配价格）的模型不参与计费
            </div>
            <div v-else class="space-y-1.5">
              <div
                v-for="(m, i) in providerForm.models"
                :key="m.model"
                class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5"
              >
                <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-text">{{ m.model }}</span>
                <NumberInput v-model="m.priceInput" :min="0" :step="0.1" :integer="false" allow-empty size="sm" class="w-28" placeholder="输入价" />
                <NumberInput v-model="m.priceCached" :min="0" :step="0.1" :integer="false" allow-empty size="sm" class="w-28" placeholder="缓存价" />
                <NumberInput v-model="m.priceOutput" :min="0" :step="0.1" :integer="false" allow-empty size="sm" class="w-28" placeholder="输出价" />
                <Switch v-model="m.enabled" size="sm" />
                <Button size="sm" variant="danger-ghost" @click="providerForm.models.splice(i, 1)">移除</Button>
              </div>
            </div>
            <div class="mt-2 flex items-center gap-1.5">
              <TextInput
                v-model="manualModelName"
                type="text"
                placeholder="手动添加模型名"
                size="sm"
                class="w-56"
                @keydown.enter="addManualModel"
              />
              <Button size="sm" variant="secondary" icon="plus" @click="addManualModel">添加</Button>
            </div>
          </div>

          <div class="flex items-center justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" @click="toggleProviderForm">取消</Button>
            <Button variant="secondary" :loading="testing" @click="testConnection">测试连接</Button>
            <Button variant="primary" :loading="savingProvider" @click="saveProvider">保存</Button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        id="balances"
        class="mt-3"
        title="用户余额"
        description="共享模式计费的扣费对象；正数充值、负数扣减"
        icon="users"
      >
        <EmptyState v-if="balances.length === 0 && !balancesLoading" text="还没有活跃用户" />
        <table v-else class="w-full text-left text-[12.5px]">
          <thead>
            <tr class="border-b border-line text-[11.5px] text-muted">
              <th class="px-1 py-2 font-medium">用户</th>
              <th class="px-1 py-2 font-medium">余额</th>
              <th class="px-1 py-2 font-medium">最近变动</th>
              <th class="px-1 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in balances" :key="b.userId" class="border-b border-line/60 last:border-b-0">
              <td class="px-1 py-2">
                <span class="font-medium text-text-strong">{{ b.displayName }}</span>
                <span class="ml-2 text-[11.5px] text-muted">@{{ b.username }}</span>
              </td>
              <td class="px-1 py-2 tabular-nums" :class="b.balance > 0 ? 'text-text' : b.balance < 0 ? 'text-danger' : 'text-muted'">
                ¥ {{ b.balance.toFixed(2) }}
              </td>
              <td class="px-1 py-2 text-muted">{{ b.updatedAt ? formatTime(b.updatedAt) : '—' }}</td>
              <td class="px-1 py-2 text-right">
                <Button size="sm" variant="ghost" @click="openAdjust(b)">充值 / 扣减</Button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="mt-3">
          <Pagination v-model:page="balancePage" :total="balanceTotal" :page-size="BALANCE_PAGE_SIZE" />
        </div>
      </SettingsCard>
    </template>

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="删除服务器供应商？"
      :description="`「${deleteTarget?.name ?? ''}」删除后，共享模式下依赖它的成员将无法调用 AI（除非自配供应商）。`"
      confirm-text="删除"
      tone="danger"
      :loading="deleting"
      @update:open="(v: boolean) => { if (!v) deleteTarget = null }"
      @confirm="confirmDelete"
    />

    <ConfirmDialog
      :open="adjustTarget !== null"
      title="调整用户余额"
      :description="`为「${adjustTarget?.displayName ?? ''}」（@${adjustTarget?.username ?? ''}）充值或扣减。正数充值，负数扣减，不能为 0。`"
      confirm-text="确认调整"
      tone="primary"
      :loading="adjustSaving"
      @update:open="(v: boolean) => { if (!v) adjustTarget = null }"
      @confirm="confirmAdjust"
    >
      <div class="mt-1">
        <NumberInput v-model="adjustDelta" :min="-1000000" :max="1000000" :step="10" :integer="false" class="w-full" suffix="元" />
        <div v-if="adjustError" class="mt-1.5 text-[11.5px] text-danger">{{ adjustError }}</div>
      </div>
    </ConfirmDialog>
  </div>
</template>
