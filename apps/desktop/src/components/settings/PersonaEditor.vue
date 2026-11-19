<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AiPersona, AiProvider } from '@nenochat/shared'
import AvatarUploader from './AvatarUploader.vue'
import Icon from '@/components/ui/Icon.vue'
import Field from '@/components/ui/form/Field.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Textarea from '@/components/ui/form/Textarea.vue'
import Select from '@/components/ui/form/Select.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import Switch from '@/components/ui/form/Switch.vue'
import NumberInput from '@/components/ui/form/NumberInput.vue'
import Button from '@/components/ui/form/Button.vue'
import Alert from '@/components/ui/form/Alert.vue'
import { aiApi, type PersonaInput } from '@/api/ai'
import { uploadFile } from '@/api/files'
import { PROACTIVE_DEFAULTS } from '@nenochat/shared'
import { useAiStore } from '@/stores/ai'
import ModelPicker from './ModelPicker.vue'

const props = defineProps<{
  persona?: AiPersona | null
  providers: AiProvider[]
}>()

const emit = defineEmits<{
  (e: 'saved', persona: AiPersona): void
  (e: 'cancel'): void
}>()

const ai = useAiStore()

/** 当前角色所选服务商的模型列表；默认服务商取第一个 */
const modelsForSelectedProvider = computed(() => {
  const id = form.value.providerId ?? props.providers[0]?.id
  return id ? ai.modelsByProvider[id] ?? [] : []
})

const MAX_INTERESTS = 20
const MAX_CARD_BYTES = 1024 * 1024

const EMPTY_PROACTIVE = {
  enabled: false,
  triggerMode: PROACTIVE_DEFAULTS.triggerMode as 'idle' | 'chance',
  minIdleHours: PROACTIVE_DEFAULTS.minIdleHours,
  maxPerDay: PROACTIVE_DEFAULTS.maxPerDay,
  chanceUnit: PROACTIVE_DEFAULTS.chanceUnit as 'minute' | 'hour',
  chanceProbability: PROACTIVE_DEFAULTS.chanceProbability,
  chanceCooldownMinutes: PROACTIVE_DEFAULTS.chanceCooldownMinutes,
}

const form = ref<PersonaInput>(emptyForm())
const saving = ref(false)
const error = ref<string | null>(null)
const interestDraft = ref('')
const cardBusy = ref(false)

const cardInput = ref<HTMLInputElement | null>(null)
const editing = computed(() => Boolean(props.persona?.id))
const title = computed(() => (editing.value ? `编辑「${props.persona?.name}」` : '新建 AI 角色'))

function emptyForm(): PersonaInput {
  return {
    name: '',
    systemPrompt: '你是用户的朋友，说话自然口语化，句子短，不用 Markdown 标题。',
    avatarUrl: null,
    interests: [],
    card: null,
    cardUrl: null,
    cardFilename: null,
    inContacts: true,
    providerId: null,
    modelOverride: null,
    replyStyle: 'chatty',
    greeting: null,
    proactiveMode: 'global',
    proactive: { ...EMPTY_PROACTIVE },
  }
}

function fromPersona(persona: AiPersona | null | undefined): PersonaInput {
  if (!persona) return emptyForm()
  return {
    name: persona.name,
    systemPrompt: persona.systemPrompt,
    avatarUrl: persona.avatarUrl ?? null,
    interests: [...persona.interests],
    card: persona.card ?? null,
    cardUrl: persona.cardUrl ?? null,
    cardFilename: persona.cardFilename ?? null,
    inContacts: persona.inContacts,
    providerId: persona.providerId ?? null,
    modelOverride: persona.modelOverride ?? null,
    replyStyle: persona.replyStyle,
    greeting: persona.greeting ?? null,
    proactiveMode: persona.proactiveMode ?? 'global',
    proactive: {
      enabled: persona.proactive.enabled,
      triggerMode: persona.proactive.triggerMode ?? PROACTIVE_DEFAULTS.triggerMode,
      minIdleHours: persona.proactive.minIdleHours,
      maxPerDay: persona.proactive.maxPerDay,
      chanceUnit: persona.proactive.chanceUnit ?? PROACTIVE_DEFAULTS.chanceUnit,
      chanceProbability: persona.proactive.chanceProbability ?? PROACTIVE_DEFAULTS.chanceProbability,
      chanceCooldownMinutes:
        persona.proactive.chanceCooldownMinutes ?? PROACTIVE_DEFAULTS.chanceCooldownMinutes,
      windowStart: persona.proactive.windowStart,
      windowEnd: persona.proactive.windowEnd,
    },
  }
}

watch(
  () => props.persona,
  (persona) => {
    form.value = fromPersona(persona)
    interestDraft.value = ''
    error.value = null
  },
  { immediate: true },
)

const interests = computed(() => form.value.interests ?? [])
const proactive = computed(() => form.value.proactive ?? { ...EMPTY_PROACTIVE })
const chanceMode = computed(() => (proactive.value.triggerMode ?? 'idle') === 'chance')
const followsGlobal = computed(() => (form.value.proactiveMode ?? 'global') === 'global')

/** 跟随全局时把总设置摊开给用户看，免得「为什么它不发」 */
const globalSummary = computed(() => {
  const settings = ai.globalSettings
  if (!settings) return '还没读到全局设置'
  if (!settings.proactiveEnabled && !settings.momentsEnabled) return '全局关掉了自动互动，这个角色不会主动发消息或发动态'
  const quota = settings.maxPerDay < 0 ? '不限条数' : `每天最多 ${settings.maxPerDay} 条`
  const parts = [
    settings.proactiveEnabled
      ? settings.triggerMode === 'chance'
        ? `每${settings.chanceUnit === 'minute' ? '分钟' : '小时'}按概率主动找我，${quota}`
        : `空闲 ${settings.minIdleHours} 小时后主动找我，${quota}`
      : '不主动找我',
    settings.momentsEnabled
      ? `动态：每天 ${settings.momentsPostsPerDay} 条动态 / ${settings.momentsCommentsPerDay} 条评论 / ${settings.momentsLikesPerDay} 个赞`
      : '不在动态广场活动',
  ]
  return parts.join('；')
})

function setMode(mode: 'global' | 'custom'): void {
  form.value.proactiveMode = mode
}

/** 主动互动参数统一走这里，避免模板里到处展开对象 */
function setProactive(patch: Partial<NonNullable<PersonaInput['proactive']>>): void {
  form.value.proactive = { ...proactive.value, ...patch }
}

/** 概率用百分比展示，内部存 0-1 */
function setChanceProbability(percent: number | null): void {
  const value = Math.min(100, Math.max(0, Math.round(percent ?? 10)))
  setProactive({ chanceProbability: value / 100 })
}

function addInterest(): void {
  const value = interestDraft.value.trim().replace(/[,，]$/, '')
  interestDraft.value = ''
  if (!value) return
  if (interests.value.includes(value)) return
  if (interests.value.length >= MAX_INTERESTS) {
    error.value = `兴趣最多 ${MAX_INTERESTS} 个`
    return
  }
  form.value.interests = [...interests.value, value.slice(0, 24)]
}

function removeInterest(value: string): void {
  form.value.interests = interests.value.filter((item) => item !== value)
}

function onInterestKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault()
    addInterest()
  }
  // 退格删掉最后一个标签，输入框空的时候才生效
  if (event.key === 'Backspace' && !interestDraft.value && interests.value.length > 0) {
    form.value.interests = interests.value.slice(0, -1)
  }
}

async function importCard(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return

  if (file.size > MAX_CARD_BYTES) {
    error.value = '角色卡文件不能超过 1MB'
    return
  }
  if (!/\.(md|txt|json)$/i.test(file.name)) {
    error.value = '只支持 .md / .txt / .json'
    return
  }

  error.value = null
  cardBusy.value = true
  try {
    // 文本直接进提示词，同时上传留档，换设备也能回下载
    const text = await file.text()
    form.value.card = text.slice(0, 8000)
    form.value.cardFilename = file.name
    try {
      const attachment = await uploadFile(file, { kind: 'file' })
      form.value.cardUrl = attachment.url
    } catch {
      // 留档失败不影响使用，正文已经拿到
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '导入失败'
  } finally {
    cardBusy.value = false
  }
}

function clearCard(): void {
  form.value.card = null
  form.value.cardUrl = null
  form.value.cardFilename = null
}

async function save(): Promise<void> {
  if (!form.value.name.trim()) {
    error.value = '给角色起个名字'
    return
  }
  saving.value = true
  error.value = null
  try {
    const payload: PersonaInput = {
      ...form.value,
      name: form.value.name.trim(),
      systemPrompt: form.value.systemPrompt.trim() || '你是用户的朋友，说话自然口语化。',
      interests: interests.value,
      greeting: form.value.greeting?.trim() ? form.value.greeting : null,
      providerId: form.value.providerId || props.providers[0]?.id || null,
    }
    const result = props.persona?.id
      ? await aiApi.updatePersona(props.persona.id, payload)
      : await aiApi.createPersona(payload)
    emit('saved', result.persona)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-3 rounded-xl border border-dashed border-line bg-surface-2/50 p-3">
    <div class="flex items-center justify-between">
      <h4 class="text-[12.5px] font-semibold text-text-strong">{{ title }}</h4>
      <Button
        variant="ghost"
        size="sm"
        icon="close"
        title="关闭"
        aria-label="关闭角色编辑器"
        @click="emit('cancel')"
      />
    </div>

    <Alert v-if="error" tone="danger">{{ error }}</Alert>

    <AvatarUploader
      :src="form.avatarUrl ?? null"
      :name="form.name || '新角色'"
      :size="52"
      hint="角色头像，聊天与通讯录都会用它"
      @uploaded="form.avatarUrl = $event"
    />

    <Field label="名称" for-id="persona-name">
      <TextInput
        id="persona-name"
        v-model="form.name"
        placeholder="角色名，如 小禾"
        maxlength="32"
      />
    </Field>

    <div>
      <span class="mb-1 block text-[11.5px] font-medium text-muted">
        兴趣 <span class="text-muted/70">（回车或逗号添加，最多 {{ MAX_INTERESTS }} 个）</span>
      </span>
      <div
        class="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface-2 px-2 py-1.5"
      >
        <span
          v-for="item in interests"
          :key="item"
          class="flex items-center gap-1 rounded-md bg-accent/12 px-1.5 py-0.5 text-[11.5px] text-accent"
        >
          {{ item }}
          <button type="button" class="text-accent/70 hover:text-accent" @click="removeInterest(item)">
            <Icon name="close" :size="10" />
          </button>
        </span>
        <input
          v-model="interestDraft"
          placeholder="例如：独立音乐、深夜写代码"
          class="h-6 min-w-[120px] flex-1 bg-transparent text-[12px] outline-none"
          @keydown="onInterestKeydown"
          @blur="addInterest"
        />
      </div>
    </div>

    <div>
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="text-[12px] font-medium text-muted">角色卡</span>
        <div class="flex items-center gap-1.5">
          <span v-if="form.cardFilename" class="max-w-[140px] truncate text-[11px] text-muted">
            {{ form.cardFilename }}
          </span>
          <Button
            size="sm"
            :loading="cardBusy"
            :disabled="cardBusy"
            @click="cardInput?.click()"
          >
            {{ cardBusy ? '导入中…' : '导入文件' }}
          </Button>
          <Button
            v-if="form.card"
            variant="ghost"
            size="sm"
            class="hover:!bg-danger/10 hover:!text-danger"
            @click="clearCard"
          >
            清空
          </Button>
        </div>
      </div>
      <Textarea
        :model-value="form.card ?? ''"
        :rows="5"
        placeholder="世界观、经历、说话习惯、和你的关系……也可以直接导入 .md / .txt / .json"
        @update:model-value="form.card = $event"
      />
      <input ref="cardInput" type="file" accept=".md,.txt,.json" class="hidden" @change="importCard" />
    </div>

    <Field label="提示词（怎么说话）" for-id="persona-prompt">
      <Textarea
        id="persona-prompt"
        v-model="form.systemPrompt"
        :rows="4"
        placeholder="人设提示词"
      />
    </Field>

    <Field label="开场白" for-id="persona-greeting" optional hint="只在首次建会话时发一次">
      <Textarea
        id="persona-greeting"
        :model-value="form.greeting ?? ''"
        :rows="2"
        :resize="false"
        placeholder="比如：你来啦，今天想聊点什么？"
        @update:model-value="form.greeting = $event"
      />
    </Field>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="服务商">
        <Select
          :model-value="form.providerId ?? '__default__'"
          :options="[
            { value: '__default__', label: '默认服务商' },
            ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
          ]"
          @update:model-value="
            (value) => (form.providerId = value === '__default__' ? null : String(value))
          "
        />
      </Field>
      <Field label="回复风格">
        <Select
          :model-value="form.replyStyle ?? 'chatty'"
          :options="[
            { value: 'chatty', label: '闲聊（分条较多）' },
            { value: 'concise', label: '简洁（分条较少）' },
            { value: 'narrative', label: '叙述（长段落）' },
          ]"
          @update:model-value="
            (value) =>
              (form.replyStyle = value as 'chatty' | 'concise' | 'narrative')
          "
        />
      </Field>
    </div>

    <Field label="模型覆盖" for-id="persona-model" optional hint="留空则使用服务商配置的模型">
      <ModelPicker
        id="persona-model"
        :model-value="form.modelOverride ?? ''"
        :models="modelsForSelectedProvider"
        placeholder="选择或输入模型名"
        @update:model-value="form.modelOverride = $event || null"
      />
    </Field>

    <div class="rounded-lg border border-line bg-surface-2 p-2.5">
      <Segmented
        :model-value="form.proactiveMode ?? 'global'"
        full
        size="sm"
        :options="[
          { value: 'global', label: '跟随全局' },
          { value: 'custom', label: '单独设置' },
        ]"
        aria-label="主动消息来源"
        @update:model-value="setMode($event as 'global' | 'custom')"
      />

      <template v-if="followsGlobal">
        <p class="mt-2 text-[11.5px] leading-relaxed text-muted">{{ globalSummary }}</p>
        <p class="mt-1 text-[11px] leading-relaxed text-muted">
          想改这些就切到「单独设置」，或者在设置页调整全局默认值。
        </p>
      </template>

      <template v-else>
        <div class="mt-2 flex items-center justify-between gap-3">
          <span class="text-[12px] font-medium text-text">允许主动找我</span>
          <Switch
            size="sm"
            :model-value="proactive.enabled"
            aria-label="允许主动找我"
            @update:model-value="setProactive({ enabled: $event })"
          />
        </div>

        <div v-if="proactive.enabled" class="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="触发方式">
            <Select
              :model-value="proactive.triggerMode ?? 'idle'"
              :options="[
                { value: 'idle', label: '空闲几小时后找' },
                { value: 'chance', label: '定时随机找话题' },
              ]"
              @update:model-value="
                setProactive({ triggerMode: $event as 'idle' | 'chance' })
              "
            />
          </Field>
          <Field label="每天最多几条">
            <div class="flex items-center gap-2">
              <NumberInput
                class="min-w-0 flex-1"
                :model-value="proactive.maxPerDay"
                :min="0"
                :max="998"
                :disabled="proactive.maxPerDay < 0"
                @update:model-value="setProactive({ maxPerDay: $event ?? 0 })"
              />
              <label class="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
                <Switch
                  size="sm"
                  :model-value="proactive.maxPerDay < 0"
                  aria-label="主动消息无上限"
                  @update:model-value="setProactive({ maxPerDay: $event ? -1 : 1 })"
                />
                无上限
              </label>
            </div>
          </Field>

          <template v-if="(proactive.triggerMode ?? 'idle') === 'idle'">
            <Field label="空闲多久后找">
              <NumberInput
                :model-value="proactive.minIdleHours"
                :min="0"
                :max="720"
                suffix="小时"
                @update:model-value="setProactive({ minIdleHours: $event ?? 0 })"
              />
            </Field>
          </template>
          <template v-else>
            <Field label="掷骰间隔">
              <Select
                :model-value="proactive.chanceUnit ?? 'hour'"
                :options="[
                  { value: 'minute', label: '每分钟' },
                  { value: 'hour', label: '每小时' },
                ]"
                @update:model-value="
                  setProactive({ chanceUnit: $event as 'minute' | 'hour' })
                "
              />
            </Field>
            <Field label="每次触发概率">
              <NumberInput
                :model-value="Math.round((proactive.chanceProbability ?? 0.1) * 100)"
                :min="0"
                :max="100"
                suffix="%"
                @update:model-value="setChanceProbability"
              />
            </Field>
            <Field label="两条之间最少间隔">
              <NumberInput
                :model-value="proactive.chanceCooldownMinutes"
                :min="0"
                :max="1440"
                suffix="分钟"
                @update:model-value="setProactive({ chanceCooldownMinutes: $event ?? 0 })"
              />
            </Field>
          </template>

          <Field label="免打扰开始" hint="可跨零点">
            <TextInput
              type="time"
              :model-value="proactive.windowStart ?? ''"
              @change="
                setProactive({ windowStart: ($event.target as HTMLInputElement).value })
              "
            />
          </Field>
          <Field label="免打扰结束">
            <TextInput
              type="time"
              :model-value="proactive.windowEnd ?? ''"
              @change="
                setProactive({ windowEnd: ($event.target as HTMLInputElement).value })
              "
            />
          </Field>
        </div>

        <p v-if="proactive.enabled && chanceMode" class="mt-2 text-[11px] leading-relaxed text-muted">
          每个间隔掷一次骰子，中了就主动找话题；实际频次还受每日上限与免打扰约束。
        </p>

        <p class="mt-2 text-[11px] leading-relaxed text-muted">
          密钥存在服务端时，即使你没开客户端也会按兴趣与角色卡主动发消息；密钥存在本机时，仅在客户端在线时触发。
          动态广场的活动仍然按全局额度来。
        </p>
      </template>
    </div>

    <div class="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2">
      <span class="text-[12px] text-text">显示在通讯录的「AI 角色」分组</span>
      <Switch
        size="sm"
        :model-value="form.inContacts ?? true"
        aria-label="显示在通讯录"
        @update:model-value="form.inContacts = $event"
      />
    </div>

    <div class="flex items-center justify-end gap-2 pt-1">
      <Button variant="ghost" size="sm" @click="emit('cancel')">取消</Button>
      <Button
        variant="primary"
        size="sm"
        :loading="saving"
        :disabled="saving || !form.name.trim()"
        @click="save"
      >
        {{ saving ? '保存中…' : editing ? '保存' : '创建' }}
      </Button>
    </div>
  </div>
</template>
