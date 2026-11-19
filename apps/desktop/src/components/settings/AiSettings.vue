<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AiProvider } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
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
import { clearProviderKey, loadProviderKey, saveProviderKey } from '@/platform/ai-keys'
import { AI_PROVIDER_PRESETS, matchProviderIcon } from '@/config/ai-providers'
import TokenRouterAdBanner from '@/components/settings/TokenRouterAdBanner.vue'

const ai = useAiStore()

const providers = ref<AiProvider[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const showProviderForm = ref(false)
const testing = ref(false)
const refreshingBalance = ref<Record<string, boolean>>({})

const pendingRemoveProvider = ref<AiProvider | null>(null)
const removingProvider = ref(false)

const providerForm = ref<ProviderInput>({
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  keyLocation: 'local',
  visionModel: '',
  contextWindow: null,
})

const keyLocationOptions = [
  { value: 'local', label: '密钥存本机钥匙串', description: '只有这台设备能用' },
  { value: 'server', label: '密钥上传服务器', description: '多端共享，服务端可代发' },
]

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
    const result = await aiApi.testProvider({
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

async function addProvider(): Promise<void> {
  error.value = null
  try {
    const form = {
      ...providerForm.value,
      visionModel: providerForm.value.visionModel?.trim() || null,
      contextWindow:
        providerForm.value.contextWindow && providerForm.value.contextWindow >= 256
          ? providerForm.value.contextWindow
          : null,
    }
    const created = await aiApi.createProvider(form)
    // key 存本地钥匙串，服务端只保存「存哪里」这个标记
    if (providerForm.value.keyLocation === 'local' && providerForm.value.apiKey) {
      await saveProviderKey(created.provider.id, providerForm.value.apiKey)
    }
    await load()
    resetProviderForm()
    showProviderForm.value = false
    notice.value = '已添加 AI 服务商'
    void probeMissingBalances()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '添加失败'
  }
}

function resetProviderForm(): void {
  providerForm.value = {
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    keyLocation: 'local',
    visionModel: '',
    contextWindow: null,
  }
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
    let apiKey: string | undefined
    if (provider.keyLocation === 'local') {
      apiKey = (await loadProviderKey(provider.id)) || undefined
    }
    const result = await aiApi.providerBalance(provider.id, apiKey)
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
    await clearProviderKey(provider.id)
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
      description="支持任意 OpenAI 兼容端点，密钥默认只存本机钥匙串，不会上传服务器"
      icon="sparkles"
    >
      <template #actions>
        <Button
          size="sm"
          :variant="showProviderForm ? 'secondary' : 'secondary'"
          :icon="showProviderForm ? 'close' : 'plus'"
          @click="showProviderForm = !showProviderForm"
        >
          {{ showProviderForm ? '收起' : '添加服务商' }}
        </Button>
      </template>

      <TokenRouterAdBanner />

      <div v-if="showProviderForm" class="mb-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3">
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
              <img :src="preset.icon" :alt="preset.label" class="h-4 w-4 shrink-0 object-contain" />
              <img
                v-if="preset.textIcon"
                :src="preset.textIcon"
                :alt="preset.label"
                :title="preset.label"
                class="h-3.5 w-auto max-w-[64px] shrink-0 object-contain"
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
            <TextInput
              id="provider-model"
              v-model="providerForm.model"
              placeholder="如 gpt-4o-mini"
              spellcheck="false"
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

        <Field label="API Key" for-id="provider-key" hint="留空表示这个端点不需要密钥">
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
            <TextInput
              id="provider-vision"
              :model-value="providerForm.visionModel ?? ''"
              placeholder="如 qwen-vl-plus"
              spellcheck="false"
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

        <Field label="密钥存放位置">
          <Select
            :model-value="providerForm.keyLocation"
            :options="keyLocationOptions"
            @update:model-value="
              (value) => value && (providerForm.keyLocation = value as 'local' | 'server')
            "
          />
        </Field>

        <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
          <Button size="sm" variant="ghost" :loading="testing" @click="testConnection">
            {{ testing ? '测试中…' : '测试连接' }}
          </Button>
          <Button size="sm" variant="primary" @click="addProvider">保存服务商</Button>
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
        >
          <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface">
            <img
              v-if="providerIcon(provider)"
              :src="providerIcon(provider)!"
              :alt="provider.name"
              class="h-4 w-4 object-contain"
            />
            <Icon v-else name="sparkles" :size="14" class="text-mention" />
          </span>

          <div class="min-w-[150px] flex-1">
            <p class="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-text-strong">
              {{ provider.name }}
              <span class="rounded bg-surface px-1 text-[10px] font-normal text-muted">
                {{ provider.keyLocation === 'local' ? '本机 key' : '云端 key' }}
              </span>
              <span
                v-if="provider.balance"
                class="rounded bg-success/10 px-1.5 text-[10px] font-normal text-success"
              >
                余额 {{ balanceText(provider) }}
              </span>
            </p>
            <p class="truncate text-[11px] text-muted">{{ provider.model }} · {{ provider.baseUrl }}</p>
          </div>

          <TextInput
            class="w-36"
            size="sm"
            :model-value="provider.visionModel ?? ''"
            placeholder="识图模型（可选）"
            title="填一个多模态模型名，AI 就能看懂图片；留空则直接把图传给主模型"
            @change="saveVisionModel(provider, ($event.target as HTMLInputElement).value)"
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
      description="角色如果在用它，需要改到其它服务商后才能继续聊天。本机保存的密钥也会一并清除。"
      confirm-text="删除服务商"
      :loading="removingProvider"
      @update:open="(value) => !value && (pendingRemoveProvider = null)"
      @confirm="removeProvider"
    />
  </div>
</template>
