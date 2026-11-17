<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { AiPersona, AiProvider } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import Avatar from '@/components/ui/Avatar.vue'
import PersonaEditor from './PersonaEditor.vue'
import ProactiveSettings from './ProactiveSettings.vue'
import { aiApi, type ProviderInput } from '@/api/ai'
import { useAiStore } from '@/stores/ai'
import { useConversationsStore } from '@/stores/conversations'
import { clearProviderKey, loadProviderKey, saveProviderKey } from '@/platform/ai-keys'
import { AI_PROVIDER_PRESETS, matchProviderIcon } from '@/config/ai-providers'

const router = useRouter()
const conversations = useConversationsStore()
const ai = useAiStore()

const providers = ref<AiProvider[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const showProviderForm = ref(false)
const showPersonaForm = ref(false)
const editingPersona = ref<AiPersona | null>(null)
const testing = ref(false)
const refreshingBalance = ref<Record<string, boolean>>({})

const providerForm = ref<ProviderInput>({
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  keyLocation: 'local',
})

/** 角色列表以 ai store 为准，通讯录与消息分区读的是同一份 */
const personas = computed(() => ai.personas)
const hasProvider = computed(() => providers.value.length > 0)

/** 分段规则跟随全局设置；读不到时按默认值展示 */
const SEGMENT_FALLBACK = { enabled: true, pattern: '[。！？!?\\n]' }
const segment = reactive({ ...SEGMENT_FALLBACK })
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

watch(
  () => ai.globalSettings,
  (value) => {
    segment.enabled = value?.segmentEnabled ?? SEGMENT_FALLBACK.enabled
    segment.pattern = value?.segmentPattern ?? SEGMENT_FALLBACK.pattern
    streamEnabled.value = value?.streamEnabled ?? STREAM_FALLBACK
  },
  { immediate: true },
)

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
  if (!segment.pattern.trim()) {
    segmentError.value = '分隔符正则不能为空'
    return
  }
  try {
    new RegExp(segment.pattern)
  } catch {
    segmentError.value = '正则写错了，先改好再保存'
    return
  }

  segmentSaving.value = true
  try {
    await ai.saveSettings({
      segmentEnabled: segment.enabled,
      segmentPattern: segment.pattern,
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

/** 跟随全局的角色是否真的会主动发消息，要看那条总开关 */
function proactiveActive(persona: AiPersona): boolean {
  if (persona.proactiveMode === 'custom') return persona.proactive.enabled
  return ai.globalSettings?.proactiveEnabled ?? false
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
    const created = await aiApi.createProvider(providerForm.value)
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

async function removeProvider(provider: AiProvider): Promise<void> {
  await aiApi.deleteProvider(provider.id)
  await clearProviderKey(provider.id)
  await load()
}

function startCreate(): void {
  editingPersona.value = null
  showPersonaForm.value = true
}

function startEdit(persona: AiPersona): void {
  editingPersona.value = persona
  showPersonaForm.value = true
}

function closeEditor(): void {
  showPersonaForm.value = false
  editingPersona.value = null
}

async function onPersonaSaved(persona: AiPersona): Promise<void> {
  closeEditor()
  await ai.load()
  // 新建角色会自动建会话，列表要立刻能看到
  await conversations.refresh().catch(() => undefined)
  notice.value = `已保存角色「${persona.name}」`
}

async function removePersona(persona: AiPersona): Promise<void> {
  const label = window.confirm(`删除角色「${persona.name}」？聊天记录会一起移除。`)
  if (!label) return
  error.value = null
  try {
    await aiApi.deletePersona(persona.id)
    ai.removeLocal(persona.id)
    await conversations.refresh().catch(() => undefined)
    notice.value = '已删除角色'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  }
}

async function openChat(persona: AiPersona): Promise<void> {
  error.value = null
  try {
    const providerId = persona.providerId ?? providers.value[0]?.id
    if (!providerId) throw new Error('请先添加 AI 服务商')
    const result = await aiApi.openConversation({ personaId: persona.id, providerId })
    await conversations.refresh()
    await router.push(`/c/${result.conversation.id}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法打开 AI 会话'
  }
}

onMounted(() => {
  void load().then(() => {
    void probeMissingBalances()
  })
})
</script>

<template>
  <div>
    <h2 class="mb-1 text-[15px] font-semibold text-text-strong">AI 与模型</h2>
    <p class="mb-4 text-[12px] text-muted">
      支持任意 OpenAI 兼容端点。密钥默认只存本机钥匙串，不会上传服务器。
    </p>

    <p v-if="error" class="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
      {{ error }}
    </p>
    <p v-if="notice" class="mb-2 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">
      {{ notice }}
    </p>

    <section class="mb-6">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-[12.5px] font-medium text-text">服务商</h3>
        <button
          type="button"
          class="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[12px] text-muted hover:text-text"
          @click="showProviderForm = !showProviderForm"
        >
          <Icon name="plus" :size="12" />
          添加
        </button>
      </div>

      <div
        v-if="showProviderForm"
        class="mb-3 space-y-2 rounded-xl border border-line bg-surface p-3"
      >
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="preset in AI_PROVIDER_PRESETS"
            :key="preset.id"
            type="button"
            class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors"
            :class="
              providerForm.baseUrl === preset.baseUrl
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-line text-muted hover:border-accent/50 hover:text-text'
            "
            @click="applyPreset(preset.id)"
          >
            <img
              :src="preset.icon"
              :alt="preset.label"
              class="h-4 w-4 shrink-0 object-contain"
            />
            <img
              :src="preset.textIcon"
              :alt="preset.label"
              :title="preset.label"
              class="h-3.5 w-auto max-w-[64px] shrink-0 object-contain"
            />
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-muted hover:border-accent/50 hover:text-text"
            @click="resetProviderForm"
          >
            <Icon name="plus" :size="11" />
            自定义
          </button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <input
            v-model="providerForm.name"
            placeholder="名称，如 中转站"
            class="h-8 rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] outline-none focus:border-accent"
          />
          <input
            v-model="providerForm.model"
            placeholder="模型，如 gpt-4o-mini"
            class="h-8 rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] outline-none focus:border-accent"
          />
        </div>
        <input
          v-model="providerForm.baseUrl"
          placeholder="Base URL，如 https://api.openai.com/v1"
          class="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] outline-none focus:border-accent"
        />
        <input
          v-model="providerForm.apiKey"
          type="password"
          placeholder="API Key"
          class="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] outline-none focus:border-accent"
        />
        <div class="flex items-center gap-2">
          <select
            v-model="providerForm.keyLocation"
            class="h-8 rounded-lg border border-line bg-surface-2 px-2 text-[12px] outline-none"
          >
            <option value="local">密钥存本机</option>
            <option value="server">密钥上传服务器（多端共享）</option>
          </select>
          <button
            type="button"
            class="rounded-lg border border-line px-2 py-1 text-[12px] text-muted hover:text-text disabled:opacity-60"
            :disabled="testing"
            @click="testConnection"
          >
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button
            type="button"
            class="ml-auto rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text"
            @click="addProvider"
          >
            保存
          </button>
        </div>
      </div>

      <p v-if="loading" class="text-[12px] text-muted">读取中…</p>
      <p v-else-if="providers.length === 0" class="text-[12px] text-muted">
        还没有服务商，先添加一个 OpenAI 兼容端点。
      </p>
      <div
        v-for="provider in providers"
        :key="provider.id"
        class="mb-1.5 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2"
      >
        <span
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2"
        >
          <img
            v-if="providerIcon(provider)"
            :src="providerIcon(provider)!"
            :alt="provider.name"
            class="h-4 w-4 object-contain"
          />
          <Icon v-else name="sparkles" :size="14" class="text-mention" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-text-strong">
            {{ provider.name }}
            <span class="rounded bg-surface-2 px-1 text-[10px] text-muted">
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
        <button
          type="button"
          class="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-text disabled:opacity-50"
          :title="provider.balanceCheckedAt ? '刷新余额' : '查询余额'"
          :disabled="refreshingBalance[provider.id]"
          @click="refreshBalance(provider)"
        >
          <Icon
            name="refresh"
            :size="13"
            :class="refreshingBalance[provider.id] ? 'animate-spin' : ''"
          />
        </button>
        <button
          type="button"
          class="rounded-md p-1 text-muted hover:bg-danger/10 hover:text-danger"
          title="删除"
          @click="removeProvider(provider)"
        >
          <Icon name="trash" :size="13" />
        </button>
      </div>
    </section>

    <section class="mb-6">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-[12.5px] font-medium text-text">流式输出</h3>
        <span class="text-[11px] text-muted">
          <span v-if="streamSaving">保存中…</span>
          <span v-else-if="streamSaved" class="text-success">已保存</span>
        </span>
      </div>

      <div class="rounded-xl border border-line bg-surface p-3">
        <label class="flex items-start gap-2">
          <input
            v-model="streamEnabled"
            type="checkbox"
            class="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
            @change="saveStream"
          />
          <span class="min-w-0">
            <span class="block text-[12.5px] font-medium text-text-strong">AI 回复流式输出</span>
            <span class="block text-[11px] leading-relaxed text-muted">
              回复逐字生成，像打字一样实时显示。关闭后只要开了下面的「回复分段」，切好的一段仍会立刻显示出来。
            </span>
          </span>
        </label>
        <p v-if="streamError" class="mt-1 pl-[22px] text-[11px] text-danger">{{ streamError }}</p>
      </div>
    </section>

    <section class="mb-6">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-[12.5px] font-medium text-text">回复分段</h3>
        <span class="text-[11px] text-muted">
          <span v-if="segmentSaving">保存中…</span>
          <span v-else-if="segmentSaved" class="text-success">已保存</span>
        </span>
      </div>

      <div class="space-y-2 rounded-xl border border-line bg-surface p-3">
        <label class="flex items-start gap-2">
          <input
            v-model="segment.enabled"
            type="checkbox"
            class="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
            @change="saveSegment"
          />
          <span class="min-w-0">
            <span class="block text-[12.5px] font-medium text-text-strong">把 AI 回复拆成多条消息</span>
            <span class="block text-[11px] leading-relaxed text-muted">
              按下面的正则找断点，默认在句号、感叹号、问号和换行处拆开；空行会被去掉。关掉后整段作为一条消息发出。
            </span>
          </span>
        </label>

        <label v-if="segment.enabled" class="block pl-[22px]">
          <span class="mb-0.5 block text-[11px] text-muted">分隔符正则</span>
          <input
            v-model="segment.pattern"
            placeholder="[。！？!?\n]"
            class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 font-mono text-[12px] outline-none focus:border-accent"
            @change="saveSegment"
          />
        </label>

        <p v-if="segmentError" class="pl-[22px] text-[11px] text-danger">{{ segmentError }}</p>
      </div>
    </section>

    <ProactiveSettings />

    <section>
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-[12.5px] font-medium text-text">AI 角色</h3>
        <button
          type="button"
          class="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[12px] text-muted hover:text-text disabled:opacity-50"
          :disabled="!hasProvider"
          @click="startCreate"
        >
          <Icon name="plus" :size="12" />
          新建
        </button>
      </div>

      <PersonaEditor
        v-if="showPersonaForm"
        class="mb-3"
        :persona="editingPersona"
        :providers="providers"
        @saved="onPersonaSaved"
        @cancel="closeEditor"
      />

      <p v-if="personas.length === 0" class="text-[12px] text-muted">
        还没有 AI 角色，创建一个就会自动出现在消息列表与通讯录里。
      </p>

      <div
        v-for="persona in personas"
        :key="persona.id"
        class="mb-1.5 flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2"
      >
        <Avatar :name="persona.name" :src="persona.avatarUrl" :seed="persona.id" :size="34" />
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-text-strong">
            {{ persona.name }}
            <span
              v-if="proactiveActive(persona)"
              class="rounded bg-accent/12 px-1 text-[10px] font-normal text-accent"
            >
              主动消息
            </span>
            <span
              v-if="persona.proactiveMode === 'global'"
              class="rounded bg-surface-2 px-1 text-[10px] font-normal text-muted"
            >
              跟随全局
            </span>
          </p>
          <p class="truncate text-[11px] text-muted">
            {{ persona.interests.length > 0 ? persona.interests.join(' · ') : persona.systemPrompt.slice(0, 36) }}
          </p>
        </div>
        <button
          type="button"
          class="rounded-lg bg-accent px-2 py-1 text-[11.5px] font-medium text-accent-text"
          @click="openChat(persona)"
        >
          聊天
        </button>
        <button
          type="button"
          class="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-text"
          title="编辑"
          @click="startEdit(persona)"
        >
          <Icon name="edit" :size="13" />
        </button>
        <button
          type="button"
          class="rounded-md p-1 text-muted hover:bg-danger/10 hover:text-danger"
          title="删除"
          @click="removePersona(persona)"
        >
          <Icon name="trash" :size="13" />
        </button>
      </div>
    </section>
  </div>
</template>
