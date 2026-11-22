<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AiProvider, AiProviderModel } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import Field from '@/components/ui/form/Field.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import NumberInput from '@/components/ui/form/NumberInput.vue'
import Select from '@/components/ui/form/Select.vue'
import Switch from '@/components/ui/form/Switch.vue'
import Button from '@/components/ui/form/Button.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import { aiApi, type ProviderInput } from '@/api/ai'
import { useAiStore } from '@/stores/ai'
import { AI_PROVIDER_PRESETS, matchProviderIcon } from '@/config/ai-providers'
import { isTauri } from '@/platform/device'
import TokenRouterAdBanner from '@/components/settings/TokenRouterAdBanner.vue'
import ModelPicker from '@/components/settings/ModelPicker.vue'

const ai = useAiStore()

const providers = ref<AiProvider[]>([])
/** 服务器统一供 AI 的个人视图；enabled=false 时自定义供应商照常可用 */
const serverAi = ref<{
  enabled: boolean
  balance: number
  rechargeUrl: string | null
  models: AiProviderModel[]
} | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const showProviderForm = ref(false)
const editingProviderId = ref<string | null>(null)
const savingProvider = ref(false)
const testing = ref(false)
const refreshingBalance = ref<Record<string, boolean>>({})
const fetchingModels = ref(false)

/** 当前正在编辑的服务商；为空表示表单处于添加模式 */
const editingProvider = computed(
  () => providers.value.find((p) => p.id === editingProviderId.value) ?? null,
)

const pendingRemoveProvider = ref<AiProvider | null>(null)
const removingProvider = ref(false)

/** 手动往 AI 列表里添加模型的输入草稿 */
const manualModelDraft = ref('')

const providerForm = ref<ProviderInput>({
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  visionModel: '',
  contextWindow: null,
  models: [],
})

/** 分段规则跟随全局设置；读不到时按默认值展示 */
const SEGMENT_FALLBACK = { enabled: true, pattern: '[。！？!?\\n]' }
const segmentEnabled = ref(SEGMENT_FALLBACK.enabled)
const segmentPattern = ref(SEGMENT_FALLBACK.pattern)
const segmentSaving = ref(false)
const segmentSaved = ref(false)
const segmentError = ref<string | null>(null)
let segmentTimer: ReturnType<typeof setTimeout> | null = null

/** 流式输出跟随全局设置；读不到时按默认关闭展示 */
const STREAM_FALLBACK = false
const streamEnabled = ref(false)
const streamSaving = ref(false)
const streamSaved = ref(false)
const streamError = ref<string | null>(null)
let streamTimer: ReturnType<typeof setTimeout> | null = null

/** 调试模式跟随全局设置；读不到时按默认关闭展示 */
const DEBUG_FALLBACK = false
const debugMode = ref(false)
const debugSaving = ref(false)
const debugSaved = ref(false)
const debugError = ref<string | null>(null)
let debugTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => ai.globalSettings,
  (value) => {
    segmentEnabled.value = value?.segmentEnabled ?? SEGMENT_FALLBACK.enabled
    segmentPattern.value = value?.segmentPattern ?? SEGMENT_FALLBACK.pattern
    streamEnabled.value = value?.streamEnabled ?? STREAM_FALLBACK
    debugMode.value = value?.debugMode ?? DEBUG_FALLBACK
  },
  { immediate: true },
)

/** 调试模式开关即时保存：开了之后会话底栏与群聊决策条才会显示 */
async function saveDebugMode(): Promise<void> {
  debugError.value = null
  debugSaving.value = true
  try {
    await ai.saveSettings({ debugMode: debugMode.value })
    debugSaved.value = true
    if (debugTimer) clearTimeout(debugTimer)
    debugTimer = setTimeout(() => {
      debugSaved.value = false
    }, 1600)
  } catch (e) {
    debugError.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    debugSaving.value = false
  }
}

/** 开关即时保存 */
async function saveStream(): Promise<void> {
  streamError.value = null
  streamSaving.value = true
  try {
    await ai.saveSettings({ streamEnabled: streamEnabled.value })
    streamSaved.value = true
    if (streamTimer) clearTimeout(streamTimer)
    streamTimer = setTimeout(() => {
      streamSaved.value = false
    }, 1600)
  } catch (e) {
    streamError.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    streamSaving.value = false
  }
}

/** 开关与正则都即时保存，保存前先校验正则能不能编译 */
async function saveSegment(): Promise<void> {
  segmentError.value = null
  if (!segmentPattern.value.trim()) {
    segmentError.value = '分隔符正则不能为空'
    return
  }
  try {
    new RegExp(segmentPattern.value)
  } catch {
    segmentError.value = '正则写错了，先改好再保存'
    return
  }

  segmentSaving.value = true
  try {
    await ai.saveSettings({
      segmentEnabled: segmentEnabled.value,
      segmentPattern: segmentPattern.value,
    })
    segmentSaved.value = true
    if (segmentTimer) clearTimeout(segmentTimer)
    segmentTimer = setTimeout(() => {
      segmentSaved.value = false
    }, 1600)
  } catch (e) {
    segmentError.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    segmentSaving.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const providerResult = await aiApi.providers()
    providers.value = providerResult.providers
    await ai.load()
    // 服务器统一供 AI 的余额/可用模型；接口失败不打断主流程
    try {
      serverAi.value = await aiApi.balance()
    } catch {
      serverAi.value = null
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取 AI 配置失败'
  } finally {
    loading.value = false
  }
}

async function testConnection(): Promise<void> {
  testing.value = true
  notice.value = null
  error.value = null
  try {
    // 编辑态且密钥留空时改用服务端托管的密钥测试，空 Bearer 打上游必然失败
    const editingId = editingProviderId.value
    const result =
      editingId && !providerForm.value.apiKey
        ? await aiApi.testProviderStored(editingId, {
            baseUrl: providerForm.value.baseUrl,
            model: providerForm.value.model,
          })
        : await aiApi.testProvider({
            baseUrl: providerForm.value.baseUrl,
            apiKey: providerForm.value.apiKey ?? '',
            model: providerForm.value.model,
          })
    notice.value = result.ok ? `连接成功：${result.sample.slice(0, 40)}` : '连接失败'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '连接失败'
  } finally {
    testing.value = false
  }
}

async function saveProvider(): Promise<void> {
  const editingId = editingProviderId.value
  const form = providerForm.value
  error.value = null
  notice.value = null

  const payload: ProviderInput = {
    name: form.name,
    baseUrl: form.baseUrl,
    model: form.model,
    visionModel: form.visionModel?.trim() || null,
    contextWindow: form.contextWindow && form.contextWindow >= 256 ? form.contextWindow : null,
    models: form.models ?? [],
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
  }

  savingProvider.value = true
  try {
    let providerId: string
    if (editingId) {
      const result = await aiApi.updateProvider(editingId, payload)
      providerId = result.provider.id
      notice.value = '已保存修改'
    } else {
      const result = await aiApi.createProvider(payload)
      providerId = result.provider.id
      notice.value = '已添加 AI 服务商'
    }
    stopEditProvider()
    showProviderForm.value = false
    await load()
    void probeMissingBalances()
    await fetchModelsFor(providerId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存服务商失败'
  } finally {
    savingProvider.value = false
  }
}

/** 读取某服务商已缓存的模型列表 */
function modelsOf(providerId?: string | null): string[] {
  return providerId ? ai.modelsByProvider[providerId] ?? [] : []
}

/** 可选模型：配置了 AI 列表时只显示启用的；没配置时回退到拉取到的完整列表 */
function selectableModels(provider: AiProvider | null | undefined): string[] {
  if (!provider) return []
  const list = provider.models ?? []
  if (list.length > 0) return list.filter((m) => m.enabled).map((m) => m.model)
  return modelsOf(provider.id)
}

/** 表单里主模型 / 识图模型的可选项，跟随表单里的 AI 列表实时变化 */
function formSelectableModels(): string[] {
  const list = providerForm.value.models ?? []
  if (list.length > 0) return list.filter((m) => m.enabled).map((m) => m.model)
  return modelsOf(editingProvider.value?.id)
}

/** 表单 AI 列表里追加一个模型；重复添加直接忽略 */
function addFormModel(model: string): void {
  const name = model.trim()
  if (!name) return
  if ((providerForm.value.models ?? []).some((m) => m.model === name)) return
  providerForm.value.models = [
    ...(providerForm.value.models ?? []),
    { model: name, enabled: true, priceInput: null, priceOutput: null, priceCached: null },
  ]
}

/** 手动添加输入框的回车 / 按钮入口 */
function addManualModel(): void {
  addFormModel(manualModelDraft.value)
  manualModelDraft.value = ''
}

/** 把拉取到的模型列表合并进表单：已有条目保留开关与价格，只补新增的 */
function importFormModels(): void {
  const fetched = modelsOf(editingProvider.value?.id)
  if (fetched.length === 0) return
  const existing = new Map((providerForm.value.models ?? []).map((m) => [m.model, m]))
  providerForm.value.models = fetched.map(
    (model) => existing.get(model) ?? { model, enabled: true, priceInput: null, priceOutput: null, priceCached: null },
  )
}

function removeFormModel(index: number): void {
  providerForm.value.models = (providerForm.value.models ?? []).filter((_, i) => i !== index)
}

/** 某服务商已启用几个 AI，列表行的徽标用 */
function enabledCountOf(provider: AiProvider): { enabled: number; total: number } | null {
  const list = provider.models ?? []
  if (list.length === 0) return null
  return { enabled: list.filter((m) => m.enabled).length, total: list.length }
}

/** 保存服务商后自动拉取模型列表；失败只提示，不影响保存结果 */
async function fetchModelsFor(providerId: string): Promise<void> {
  fetchingModels.value = true
  try {
    const models = await ai.loadModels(providerId)
    notice.value = models.length > 0
      ? `已获取 ${models.length} 个模型`
      : '已保存，但这个端点没有返回模型列表，可手动输入模型名'
  } catch {
    notice.value = '已保存，但模型列表获取失败，可手动输入模型名'
  } finally {
    fetchingModels.value = false
  }
}

/** 进入编辑态：云端密钥不可读取，留空表示不改动 */
function startEditProvider(provider: AiProvider): void {
  error.value = null
  notice.value = null
  editingProviderId.value = provider.id
  showProviderForm.value = true
  providerForm.value = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: '',
    visionModel: provider.visionModel ?? '',
    contextWindow: provider.contextWindow ?? null,
    models: (provider.models ?? []).map((m) => ({ ...m })),
  }
}

function stopEditProvider(): void {
  editingProviderId.value = null
  resetProviderForm()
}

function cancelProviderForm(): void {
  stopEditProvider()
  showProviderForm.value = false
}

/** 价格展示：未配置显示 —，数值去掉多余的尾零 */
function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return String(value)
}

/** 充值链接：桌面端走系统浏览器，浏览器端新开标签页 */
async function openRecharge(): Promise<void> {
  const url = serverAi.value?.rechargeUrl
  if (!url) return
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

function toggleProviderForm(): void {
  if (showProviderForm.value) stopEditProvider()
  else resetProviderForm()
  showProviderForm.value = !showProviderForm.value
}

function resetProviderForm(): void {
  providerForm.value = {
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
      visionModel: '',
    contextWindow: null,
    models: [],
  }
  manualModelDraft.value = ''
}

/** 把预设的端点与推荐模型填进表单，名字留空时也一并带上 */
function applyPreset(presetId: string): void {
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === presetId)
  if (!preset) return
  providerForm.value = {
    ...providerForm.value,
    name: preset.name,
    baseUrl: preset.baseUrl,
    model: preset.model,
  }
  if (preset.keyless) providerForm.value.apiKey = ''
}

function providerIcon(provider: AiProvider): string | null {
  return matchProviderIcon(provider.name, provider.baseUrl)
}

/** 余额文案：带货币符号，天文数字按不限额度处理 */
function balanceText(provider: AiProvider): string | null {
  if (!provider.balance) return null
  const amount = Number(provider.balance)
  const symbol = provider.balanceCurrency === 'USD' ? '$' : '¥'
  if (Number.isFinite(amount) && amount >= 1e8) return `${symbol}不限`
  return `${symbol}${provider.balance}`
}

/** 服务端代查余额并缓存；本机密钥要先从钥匙串取出明文随请求带上 */
async function refreshBalance(provider: AiProvider, quiet = false): Promise<void> {
  if (refreshingBalance.value[provider.id]) return
  refreshingBalance.value[provider.id] = true
  try {
    const result = await aiApi.providerBalance(provider.id)
    const updated = result.provider
    providers.value = providers.value.map((p) => (p.id === updated.id ? updated : p))
    ai.providers = ai.providers.map((p) => (p.id === updated.id ? updated : p))
    if (!quiet) {
      notice.value = updated.balance ? `余额：${balanceText(updated)}` : '没有探到可用的余额接口'
    }
  } catch (e) {
    if (!quiet) error.value = e instanceof Error ? e.message : '余额查询失败'
  } finally {
    delete refreshingBalance.value[provider.id]
  }
}

/** 还没查过余额的服务商在进入设置时静默补查一轮 */
async function probeMissingBalances(): Promise<void> {
  for (const provider of providers.value) {
    if (provider.balanceCheckedAt) continue
    await refreshBalance(provider, true).catch(() => undefined)
  }
}

async function removeProvider(): Promise<void> {
  const provider = pendingRemoveProvider.value
  if (!provider) return
  removingProvider.value = true
  try {
    await aiApi.deleteProvider(provider.id)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除服务商失败'
  } finally {
    removingProvider.value = false
    pendingRemoveProvider.value = null
  }
}

/** 识图模型即时保存：留空表示清掉，发图时改走直传 */
async function saveVisionModel(provider: AiProvider, value: string): Promise<void> {
  const visionModel = value.trim() || null
  if ((provider.visionModel ?? null) === visionModel) return
  try {
    const result = await aiApi.updateProvider(provider.id, { visionModel })
    const updated = result.provider
    providers.value = providers.value.map((p) => (p.id === updated.id ? updated : p))
    ai.providers = ai.providers.map((p) => (p.id === updated.id ? updated : p))
    notice.value = visionModel ? `识图模型已设为 ${visionModel}` : '已清除识图模型'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存识图模型失败'
  }
}

/** 上下文窗口即时保存：留空表示未配置，水位条就不显示 */
async function saveContextWindow(provider: AiProvider, value: number | null): Promise<void> {
  const contextWindow = value && value >= 256 ? value : null
  if ((provider.contextWindow ?? null) === contextWindow) return
  try {
    const result = await aiApi.updateProvider(provider.id, { contextWindow })
    const updated = result.provider
    providers.value = providers.value.map((p) => (p.id === updated.id ? updated : p))
    ai.providers = ai.providers.map((p) => (p.id === updated.id ? updated : p))
    notice.value = contextWindow
      ? `上下文窗口已设为 ${contextWindow}`
      : '已清除上下文窗口配置'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存上下文窗口失败'
  }
}

onMounted(() => {
  void load().then(() => {
    void probeMissingBalances()
    for (const provider of providers.value) {
      if (!ai.modelsByProvider[provider.id]) void ai.loadModels(provider.id).catch(() => undefined)
    }
  })
})

// 「已保存」的闪现定时器随组件清掉，避免切走设置页后还回来改状态
onBeforeUnmount(() => {
  if (segmentTimer) clearTimeout(segmentTimer)
  if (streamTimer) clearTimeout(streamTimer)
  if (debugTimer) clearTimeout(debugTimer)
})
</script>

<template>
  <div class="space-y-3">
    <Alert v-if="error" tone="danger">{{ error }}</Alert>
    <Alert v-else-if="notice" tone="success">{{ notice }}</Alert>

    <SettingsCard
      id="providers"
      title="AI 服务商"
      description="支持任意 OpenAI 兼容端点，密钥加密保存在服务端，保存后自动获取模型列表"
      icon="sparkles"
    >
      <template #actions>
        <Button
          v-if="!serverAi?.enabled"
          size="sm"
          :variant="showProviderForm ? 'secondary' : 'secondary'"
          :icon="showProviderForm ? 'close' : 'plus'"
          @click="toggleProviderForm"
        >
          {{ showProviderForm ? '收起' : '添加服务商' }}
        </Button>
      </template>

      <!-- 服务器统一供 AI：大字余额 + 充值 + 可用模型价格，自定义供应商停用 -->
      <div v-if="serverAi?.enabled" class="space-y-4">
        <div class="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3.5">
          <div class="min-w-0">
            <div class="text-[11.5px] text-muted">余额</div>
            <div class="text-[28px] font-semibold leading-tight tabular-nums text-text-strong">
              ¥ {{ (serverAi.balance ?? 0).toFixed(2) }}
            </div>
          </div>
          <Button
            v-if="serverAi.rechargeUrl"
            variant="primary"
            icon="globe"
            @click="openRecharge"
          >
            充值
          </Button>
        </div>

        <div>
          <div class="mb-1.5 text-[12px] font-medium text-text-strong">可用模型</div>
          <p class="mb-2 text-[11px] leading-relaxed text-muted">
            按实际用量计费（元 / 百万 token）；缓存命中部分按缓存价计，未配缓存价按输入价计
          </p>
          <div class="overflow-hidden rounded-lg border border-line">
            <div
              v-for="m in serverAi.models"
              :key="m.model"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-3 py-2 text-[12px] last:border-b-0"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-text">{{ m.model }}</span>
              <span class="shrink-0 text-muted tabular-nums">输入 {{ fmtPrice(m.priceInput) }}</span>
              <span class="shrink-0 text-muted tabular-nums">缓存 {{ fmtPrice(m.priceCached) }}</span>
              <span class="shrink-0 text-muted tabular-nums">输出 {{ fmtPrice(m.priceOutput) }}</span>
            </div>
            <div v-if="serverAi.models.length === 0" class="px-3 py-3 text-center text-[11.5px] text-muted">
              暂无可用的模型，请联系管理员
            </div>
          </div>
        </div>

        <Alert tone="info">当前由服务器统一提供 AI 服务，自定义服务商已停用。</Alert>
      </div>
      <template v-else>
        <TokenRouterAdBanner />

      <div v-if="showProviderForm" class="mb-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3">
        <p v-if="editingProvider" class="text-[12px] text-muted">
          正在编辑 <span class="font-medium text-text-strong">{{ editingProvider.name }}</span>
        </p>
        <div>
          <p class="mb-1.5 text-[11.5px] font-medium text-muted">快速预设</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="preset in AI_PROVIDER_PRESETS"
              :key="preset.id"
              type="button"
              class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors"
              :class="
                providerForm.baseUrl === preset.baseUrl
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-line bg-surface text-muted hover:border-accent/50 hover:text-text'
              "
              @click="applyPreset(preset.id)"
            >
              <SvgIcon :source="preset.icon" :label="preset.label" class="h-4 w-4" />
              <SvgIcon
                v-if="preset.textIcon"
                :source="preset.textIcon"
                :label="preset.label"
                auto-width
                class="h-3.5 max-w-[64px]"
              />
              <span v-else>{{ preset.label }}</span>
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-muted hover:border-accent/50 hover:text-text"
              @click="resetProviderForm"
            >
              <Icon name="plus" :size="11" />
              自定义
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="名称" for-id="provider-name">
            <TextInput id="provider-name" v-model="providerForm.name" placeholder="如 中转站" />
          </Field>
          <Field label="模型" for-id="provider-model">
            <ModelPicker
              id="provider-model"
              v-model="providerForm.model"
              :models="formSelectableModels()"
              placeholder="选择或输入模型名"
            />
          </Field>
        </div>

        <Field label="Base URL" for-id="provider-base-url">
          <TextInput
            id="provider-base-url"
            v-model="providerForm.baseUrl"
            placeholder="https://api.openai.com/v1"
            spellcheck="false"
          />
        </Field>

        <Field
          label="API Key"
          for-id="provider-key"
          :hint="
            editingProvider && !editingProvider.apiKeyMasked && !providerForm.apiKey
              ? '这个服务商还没有密钥（旧版本机密钥不会自动迁移），请重新填写'
              : '留空表示不改动密钥；服务端密钥加密存储，不会回显'
          "
        >
          <TextInput
            id="provider-key"
            :model-value="providerForm.apiKey ?? ''"
            type="password"
            placeholder="sk-..."
            autocomplete="off"
            spellcheck="false"
            @update:model-value="providerForm.apiKey = $event"
          />
        </Field>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="识图模型" for-id="provider-vision" optional>
            <ModelPicker
              id="provider-vision"
              :model-value="providerForm.visionModel ?? ''"
              :models="formSelectableModels()"
              placeholder="选择或输入识图模型名"
              @update:model-value="providerForm.visionModel = $event"
            />
          </Field>
          <Field label="上下文窗口" for-id="provider-context" optional hint="调试模式的上下文水位按它计算">
            <NumberInput
              id="provider-context"
              v-model="providerForm.contextWindow"
              :min="256"
              :step="1000"
              allow-empty
              placeholder="如 128000"
              suffix="token"
            />
          </Field>
        </div>

        <div>
          <div class="mb-1.5 flex items-center justify-between">
            <p class="text-[11.5px] font-medium text-muted">AI 列表</p>
            <Button
              size="sm"
              variant="ghost"
              :disabled="modelsOf(editingProvider?.id).length === 0"
              @click="importFormModels"
            >
              导入模型列表
            </Button>
          </div>
          <p class="mb-2 text-[11px] text-muted">
            关闭的 AI 不可被角色或会话选用；价格（元 / 百万 token）用于共享模式计费，缓存价未配置时缓存部分按输入价计。
          </p>
          <div v-if="(providerForm.models ?? []).length > 0" class="space-y-1.5">
            <div
              v-for="(entry, index) in providerForm.models"
              :key="entry.model"
              class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5"
            >
              <span
                class="min-w-[120px] flex-1 truncate text-[12px]"
                :class="entry.enabled ? 'text-text' : 'text-muted line-through'"
                :title="entry.model"
              >
                {{ entry.model }}
              </span>
              <NumberInput
                class="w-28"
                size="sm"
                :integer="false"
                :min="0"
                :step="0.1"
                allow-empty
                :model-value="entry.priceInput"
                placeholder="输入价"
                title="输入价格（元 / 百万 token），用于共享模式计费"
                @update:model-value="entry.priceInput = $event"
              />
              <NumberInput
                class="w-28"
                size="sm"
                :integer="false"
                :min="0"
                :step="0.1"
                allow-empty
                :model-value="entry.priceCached"
                placeholder="缓存价"
                title="缓存命中价格（元 / 百万 token），未配置时缓存部分按输入价计"
                @update:model-value="entry.priceCached = $event"
              />
              <NumberInput
                class="w-28"
                size="sm"
                :integer="false"
                :min="0"
                :step="0.1"
                allow-empty
                :model-value="entry.priceOutput"
                placeholder="输出价"
                title="输出价格（元 / 百万 token），用于共享模式计费"
                @update:model-value="entry.priceOutput = $event"
              />
              <Switch
                :model-value="entry.enabled"
                :aria-label="`启用 ${entry.model}`"
                @update:model-value="entry.enabled = $event"
              />
              <IconButton
                icon="trash"
                :size="14"
                label="从 AI 列表移除"
                @click="removeFormModel(index)"
              />
            </div>
          </div>
          <p v-else class="mb-2 rounded-lg border border-dashed border-line px-2.5 py-2 text-[11px] text-muted">
            列表为空：点「导入模型列表」拉取这个端点支持的 AI，或手动添加。
          </p>
          <div class="mt-2 flex items-center gap-1.5">
            <TextInput
              v-model="manualModelDraft"
              placeholder="手动添加模型名，如 gpt-4o"
              spellcheck="false"
              @keydown.enter.prevent="addManualModel"
            />
            <Button size="sm" variant="secondary" icon="plus" @click="addManualModel">添加</Button>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
          <Button size="sm" variant="ghost" :loading="testing" @click="testConnection">
            {{ testing ? '测试中…' : '测试连接' }}
          </Button>
          <Button v-if="editingProvider" size="sm" variant="ghost" @click="cancelProviderForm">
            取消
          </Button>
          <Button size="sm" variant="primary" :loading="savingProvider" @click="saveProvider">
            {{ fetchingModels ? '获取模型中…' : editingProvider ? '保存修改' : '保存服务商' }}
          </Button>
        </div>
      </div>

      <p v-if="loading" class="py-2 text-[12px] text-muted">读取中…</p>
      <p v-else-if="providers.length === 0" class="py-2 text-[12px] text-muted">
        还没有服务商，先添加一个 OpenAI 兼容端点。
      </p>

      <div v-else class="space-y-2">
        <div
          v-for="provider in providers"
          :key="provider.id"
          class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2"
          :class="editingProviderId === provider.id ? 'border-accent' : ''"
        >
          <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface">
            <SvgIcon
              v-if="providerIcon(provider)"
              :source="providerIcon(provider)!"
              :label="provider.name"
              class="h-4 w-4"
            />
            <Icon v-else name="sparkles" :size="14" class="text-mention" />
          </span>

          <div class="min-w-[150px] flex-1">
            <p class="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-text-strong">
              {{ provider.name }}
              <span
                v-if="!provider.apiKeyMasked"
                class="rounded bg-danger/10 px-1.5 text-[10px] font-normal text-danger"
                title="旧版本的本机密钥不会自动迁移，点编辑重新填写；若刚保存过，可能是服务端加密密钥变动导致解密失败"
              >
                未配置密钥
              </span>
              <span
                v-if="provider.balance"
                class="rounded bg-success/10 px-1.5 text-[10px] font-normal text-success"
              >
                余额 {{ balanceText(provider) }}
              </span>
              <span
                v-if="enabledCountOf(provider)"
                class="rounded bg-accent/10 px-1.5 text-[10px] font-normal text-accent"
                title="AI 列表里启用的模型数"
              >
                AI {{ enabledCountOf(provider)!.enabled }}/{{ enabledCountOf(provider)!.total }}
              </span>
            </p>
            <p class="flex items-center gap-1 truncate text-[11px] text-muted">
              {{ provider.model }} · {{ provider.baseUrl }}
              <IconButton
                icon="refresh"
                :size="12"
                label="刷新模型列表"
                @click="() => void fetchModelsFor(provider.id)"
              />
            </p>
          </div>

          <ModelPicker
            class="w-36"
            :model-value="provider.visionModel ?? ''"
            :models="selectableModels(provider)"
            placeholder="识图模型（可选）"
            size="sm"
            @update:model-value="saveVisionModel(provider, $event)"
          />
          <NumberInput
            class="w-28"
            size="sm"
            :model-value="provider.contextWindow ?? null"
            :min="256"
            :step="1000"
            allow-empty
            placeholder="窗口 128k"
            title="模型上下文窗口（token 数），调试模式的上下文水位按它计算"
            @update:model-value="saveContextWindow(provider, $event)"
          />

          <Button
            variant="ghost"
            size="sm"
            icon="edit"
            title="编辑服务商"
            aria-label="编辑服务商"
            @click="startEditProvider(provider)"
          />
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            :loading="Boolean(refreshingBalance[provider.id])"
            :disabled="Boolean(refreshingBalance[provider.id])"
            :title="provider.balanceCheckedAt ? '刷新余额' : '查询余额'"
            aria-label="刷新余额"
            @click="refreshBalance(provider)"
          />
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            class="hover:!bg-danger/10 hover:!text-danger"
            title="删除服务商"
            aria-label="删除服务商"
            @click="pendingRemoveProvider = provider"
          />
        </div>
      </div>
      </template>
    </SettingsCard>

    <SettingsCard id="reply" title="回复与调试" description="即时生效，无需保存" icon="message">
      <SettingRow
        label="AI 回复流式输出"
        description="回复逐字生成，像打字一样实时显示。关闭后只要开了「回复分段」，切好的一段仍会立刻显示。"
      >
        <template #hint>
          <p v-if="streamError" class="mt-1 text-[11px] text-danger">{{ streamError }}</p>
          <p v-else-if="streamSaving" class="mt-1 text-[11px] text-muted">保存中…</p>
          <p v-else-if="streamSaved" class="mt-1 text-[11px] text-success">已保存</p>
        </template>
        <Switch
          :model-value="streamEnabled"
          aria-label="AI 回复流式输出"
          @update:model-value="
            (value) => {
              streamEnabled = value
              saveStream()
            }
          "
        />
      </SettingRow>

      <SettingRow
        label="显示 AI 调试信息"
        description="会话底部显示缓存命中率、token 消耗与上下文水位；群聊里能看到每个 AI 成员的决策过程。仅本机可见。"
      >
        <template #hint>
          <p v-if="debugError" class="mt-1 text-[11px] text-danger">{{ debugError }}</p>
          <p v-else-if="debugSaving" class="mt-1 text-[11px] text-muted">保存中…</p>
          <p v-else-if="debugSaved" class="mt-1 text-[11px] text-success">已保存</p>
        </template>
        <Switch
          :model-value="debugMode"
          aria-label="显示 AI 调试信息"
          @update:model-value="
            (value) => {
              debugMode = value
              saveDebugMode()
            }
          "
        />
      </SettingRow>

      <SettingRow
        label="把 AI 回复拆成多条消息"
        description="按正则找断点，默认在句号、感叹号、问号和换行处拆开；空行会被去掉。关掉后整段作为一条消息发出。"
      >
        <template #hint>
          <p v-if="segmentError" class="mt-1 text-[11px] text-danger">{{ segmentError }}</p>
          <p v-else-if="segmentSaving" class="mt-1 text-[11px] text-muted">保存中…</p>
          <p v-else-if="segmentSaved" class="mt-1 text-[11px] text-success">已保存</p>
        </template>
        <Switch
          :model-value="segmentEnabled"
          aria-label="把 AI 回复拆成多条消息"
          @update:model-value="
            (value) => {
              segmentEnabled = value
              saveSegment()
            }
          "
        />
      </SettingRow>

      <div v-if="segmentEnabled" class="border-t border-line pt-3">
        <Field label="分隔符正则" for-id="segment-pattern">
          <TextInput
            id="segment-pattern"
            :model-value="segmentPattern"
            mono
            placeholder="[。！？!?\n]"
            spellcheck="false"
            @update:model-value="segmentPattern = $event"
            @change="saveSegment"
          />
        </Field>
      </div>
    </SettingsCard>

    <ConfirmDialog
      :open="Boolean(pendingRemoveProvider)"
      title="删除这个服务商？"
      description="角色如果在用它，需要改到其它服务商后才能继续聊天。服务端保存的密钥也会一并清除。"
      confirm-text="删除服务商"
      :loading="removingProvider"
      @update:open="(value) => !value && (pendingRemoveProvider = null)"
      @confirm="removeProvider"
    />
  </div>
</template>
