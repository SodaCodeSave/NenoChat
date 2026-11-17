<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AiPersona, AiProvider } from '@nenochat/shared'
import AvatarUploader from './AvatarUploader.vue'
import Icon from '@/components/ui/Icon.vue'
import { aiApi, type PersonaInput } from '@/api/ai'
import { uploadFile } from '@/api/files'
import { useAiStore } from '@/stores/ai'

const props = defineProps<{
  persona?: AiPersona | null
  providers: AiProvider[]
}>()

const emit = defineEmits<{
  (e: 'saved', persona: AiPersona): void
  (e: 'cancel'): void
}>()

const ai = useAiStore()

const MAX_INTERESTS = 20
const MAX_CARD_BYTES = 1024 * 1024

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
    proactive: { enabled: false, minIdleHours: 6, maxPerDay: 1 },
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
      minIdleHours: persona.proactive.minIdleHours,
      maxPerDay: persona.proactive.maxPerDay,
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
const proactive = computed(() => form.value.proactive ?? { enabled: false, minIdleHours: 6, maxPerDay: 1 })
const followsGlobal = computed(() => (form.value.proactiveMode ?? 'global') === 'global')

/** 跟随全局时把总设置摊开给用户看，免得「为什么它不发」 */
const globalSummary = computed(() => {
  const settings = ai.globalSettings
  if (!settings) return '还没读到全局设置'
  if (!settings.proactiveEnabled && !settings.momentsEnabled) return '全局关掉了自动互动，这个角色不会主动发消息或发动态'
  const parts = [
    settings.proactiveEnabled
      ? `空闲 ${settings.minIdleHours} 小时后主动找我，每天最多 ${settings.maxPerDay} 条`
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
  <div class="space-y-3 rounded-xl border border-line bg-surface p-3">
    <div class="flex items-center justify-between">
      <h4 class="text-[12.5px] font-medium text-text-strong">{{ title }}</h4>
      <button type="button" class="rounded-md p-1 text-muted hover:bg-surface-3" @click="emit('cancel')">
        <Icon name="close" :size="13" />
      </button>
    </div>

    <p v-if="error" class="rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11.5px] text-danger">{{ error }}</p>

    <AvatarUploader
      :src="form.avatarUrl ?? null"
      :name="form.name || '新角色'"
      :size="52"
      hint="角色头像，聊天与通讯录都会用它"
      @uploaded="form.avatarUrl = $event"
    />

    <label class="block">
      <span class="mb-1 block text-[11.5px] font-medium text-muted">名称</span>
      <input
        v-model="form.name"
        placeholder="角色名，如 小禾"
        class="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] outline-none focus:border-accent"
      />
    </label>

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
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11.5px] font-medium text-muted">角色卡</span>
        <div class="flex items-center gap-1">
          <span v-if="form.cardFilename" class="max-w-[140px] truncate text-[11px] text-muted">
            {{ form.cardFilename }}
          </span>
          <button
            type="button"
            class="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-text disabled:opacity-50"
            :disabled="cardBusy"
            @click="cardInput?.click()"
          >
            {{ cardBusy ? '导入中…' : '导入文件' }}
          </button>
          <button
            v-if="form.card"
            type="button"
            class="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-danger"
            @click="clearCard"
          >
            清空
          </button>
        </div>
      </div>
      <textarea
        v-model="form.card"
        rows="5"
        placeholder="世界观、经历、说话习惯、和你的关系……也可以直接导入 .md / .txt / .json"
        class="w-full resize-y rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[12.5px] leading-relaxed outline-none focus:border-accent"
      />
      <input ref="cardInput" type="file" accept=".md,.txt,.json" class="hidden" @change="importCard" />
    </div>

    <label class="block">
      <span class="mb-1 block text-[11.5px] font-medium text-muted">提示词（怎么说话）</span>
      <textarea
        v-model="form.systemPrompt"
        rows="4"
        placeholder="人设提示词"
        class="w-full resize-y rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[12.5px] outline-none focus:border-accent"
      />
    </label>

    <label class="block">
      <span class="mb-1 block text-[11.5px] font-medium text-muted">开场白（可选，只在首次建会话时发一次）</span>
      <textarea
        v-model="form.greeting"
        rows="2"
        placeholder="比如：你来啦，今天想聊点什么？"
        class="w-full resize-none rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[12.5px] outline-none focus:border-accent"
      />
    </label>

    <div class="grid grid-cols-2 gap-2">
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-muted">服务商</span>
        <select
          v-model="form.providerId"
          class="h-8 w-full rounded-lg border border-line bg-surface-2 px-2 text-[12px] outline-none"
        >
          <option :value="null">默认服务商</option>
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">
            {{ provider.name }}
          </option>
        </select>
      </label>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-muted">回复风格</span>
        <select
          v-model="form.replyStyle"
          class="h-8 w-full rounded-lg border border-line bg-surface-2 px-2 text-[12px] outline-none"
        >
          <option value="chatty">闲聊（分条较多）</option>
          <option value="concise">简洁（分条较少）</option>
          <option value="narrative">叙述（长段落）</option>
        </select>
      </label>
    </div>

    <label class="block">
      <span class="mb-1 block text-[11.5px] font-medium text-muted">模型覆盖（可选）</span>
      <input
        v-model="form.modelOverride"
        placeholder="留空则用服务商的模型"
        class="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] outline-none focus:border-accent"
      />
    </label>

    <div class="rounded-lg border border-line bg-surface-2 p-2.5">
      <div class="mb-2 flex items-center gap-1 rounded-lg bg-surface p-0.5">
        <button
          type="button"
          class="flex-1 rounded-md px-2 py-1 text-[11.5px] transition-colors"
          :class="followsGlobal ? 'bg-accent/12 font-medium text-accent' : 'text-muted hover:text-text'"
          @click="setMode('global')"
        >
          跟随全局
        </button>
        <button
          type="button"
          class="flex-1 rounded-md px-2 py-1 text-[11.5px] transition-colors"
          :class="!followsGlobal ? 'bg-accent/12 font-medium text-accent' : 'text-muted hover:text-text'"
          @click="setMode('custom')"
        >
          单独设置
        </button>
      </div>

      <template v-if="followsGlobal">
        <p class="text-[11.5px] leading-relaxed text-muted">{{ globalSummary }}</p>
        <p class="mt-1 text-[11px] leading-relaxed text-muted">
          想改这些就切到「单独设置」，或者在设置页调整全局默认值。
        </p>
      </template>

      <template v-else>
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="proactive.enabled"
            class="h-3.5 w-3.5 accent-[var(--color-accent)]"
            @change="
              form.proactive = {
                ...proactive,
                enabled: ($event.target as HTMLInputElement).checked,
              }
            "
          />
          <span class="text-[12px] font-medium text-text">允许主动找我</span>
        </label>

        <div v-if="proactive.enabled" class="mt-2 grid grid-cols-2 gap-2">
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">空闲多久后找（小时）</span>
            <input
              v-model.number="proactive.minIdleHours"
              type="number"
              min="0"
              max="720"
              class="h-7 w-full rounded-md border border-line bg-surface px-2 text-[12px] outline-none"
            />
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">每天最多几条</span>
            <input
              v-model.number="proactive.maxPerDay"
              type="number"
              min="0"
              max="20"
              class="h-7 w-full rounded-md border border-line bg-surface px-2 text-[12px] outline-none"
            />
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">免打扰开始（可跨零点）</span>
            <input
              v-model="proactive.windowStart"
              type="time"
              class="h-7 w-full rounded-md border border-line bg-surface px-2 text-[12px] outline-none"
            />
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">免打扰结束</span>
            <input
              v-model="proactive.windowEnd"
              type="time"
              class="h-7 w-full rounded-md border border-line bg-surface px-2 text-[12px] outline-none"
            />
          </label>
        </div>

        <p class="mt-2 text-[11px] leading-relaxed text-muted">
          密钥存在服务端时，即使你没开客户端也会按兴趣与角色卡主动发消息；密钥存在本机时，仅在客户端在线时触发。
          动态广场的活动仍然按全局额度来。
        </p>
      </template>
    </div>

    <label class="flex items-center gap-2">
      <input
        type="checkbox"
        :checked="form.inContacts"
        class="h-3.5 w-3.5 accent-[var(--color-accent)]"
        @change="form.inContacts = ($event.target as HTMLInputElement).checked"
      />
      <span class="text-[12px] text-text">显示在通讯录的「AI 角色」分组</span>
    </label>

    <div class="flex items-center justify-end gap-2 pt-1">
      <button
        type="button"
        class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:text-text"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        type="button"
        class="rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-accent-text disabled:opacity-60"
        :disabled="saving || !form.name.trim()"
        @click="save"
      >
        {{ saving ? '保存中…' : editing ? '保存' : '创建' }}
      </button>
    </div>
  </div>
</template>
