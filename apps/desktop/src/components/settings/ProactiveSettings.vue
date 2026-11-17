<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  GROUP_AI_DEFAULTS,
  MOMENT_AI_DEFAULTS,
  PROACTIVE_DEFAULTS,
  SEGMENT_REPLY_DEFAULTS,
  type AiGlobalSettings,
} from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import { aiApi } from '@/api/ai'
import { useAiStore } from '@/stores/ai'

/**
 * AI 自动互动总闸。
 * 主动私聊与动态广场共用这一份配置，角色默认跟随它；
 * 想单独调的角色在角色编辑器里切成「单独设置」。
 */
const ai = useAiStore()

type Editable = Omit<AiGlobalSettings, 'updatedAt'>

const DEFAULTS: Editable = {
  proactiveEnabled: false,
  minIdleHours: PROACTIVE_DEFAULTS.minIdleHours,
  maxPerDay: PROACTIVE_DEFAULTS.maxPerDay,
  triggerMode: PROACTIVE_DEFAULTS.triggerMode,
  chanceUnit: PROACTIVE_DEFAULTS.chanceUnit,
  chanceProbability: PROACTIVE_DEFAULTS.chanceProbability,
  chanceCooldownMinutes: PROACTIVE_DEFAULTS.chanceCooldownMinutes,
  windowStart: null,
  windowEnd: null,
  momentsEnabled: false,
  momentsPostsPerDay: MOMENT_AI_DEFAULTS.postsPerDay,
  momentsCommentsPerDay: MOMENT_AI_DEFAULTS.commentsPerDay,
  momentsLikesPerDay: MOMENT_AI_DEFAULTS.likesPerDay,
  groupEnabled: true,
  groupRepliesPerDay: GROUP_AI_DEFAULTS.repliesPerDay,
  groupAutonomyPerDay: GROUP_AI_DEFAULTS.autonomyPerDay,
  segmentEnabled: SEGMENT_REPLY_DEFAULTS.enabled,
  segmentPattern: SEGMENT_REPLY_DEFAULTS.pattern,
  streamEnabled: false,
}

const form = reactive<Editable>({ ...DEFAULTS })
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

const followers = computed(() => ai.personas.filter((persona) => persona.proactiveMode === 'global').length)

watch(
  () => ai.globalSettings,
  (value) => {
    if (value) {
      const { updatedAt: _ignored, ...rest } = value
      Object.assign(form, rest)
    }
  },
  { immediate: true },
)

let savedTimer: ReturnType<typeof setTimeout> | null = null

async function commit(patch: Partial<Editable>): Promise<void> {
  saving.value = true
  error.value = null
  try {
    await ai.saveSettings(patch)
    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      saved.value = false
    }, 1600)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

function onNumber(key: keyof Editable, event: Event, min: number, max: number): void {
  const raw = Number((event.target as HTMLInputElement).value)
  const value = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : min
  form[key] = value as never
  void commit({ [key]: value })
}

function onTime(key: 'windowStart' | 'windowEnd', event: Event): void {
  const value = (event.target as HTMLInputElement).value
  form[key] = value || null
  void commit({ [key]: value || null })
}

function onSelect(key: 'triggerMode' | 'chanceUnit', event: Event): void {
  const value = (event.target as HTMLSelectElement).value as 'idle' | 'chance' | 'minute' | 'hour'
  form[key] = value as never
  void commit({ [key]: value })
}

/** 概率用百分比展示，内部存 0-1 */
function onChanceProbability(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : PROACTIVE_DEFAULTS.chanceProbability * 100
  form.chanceProbability = Math.round(percent) / 100
  void commit({ chanceProbability: form.chanceProbability })
}

/** 勾上无上限后配额存 -1，取消则回到默认值 */
function toggleUnlimited(event: Event): void {
  const unlimited = (event.target as HTMLInputElement).checked
  form.maxPerDay = unlimited ? -1 : PROACTIVE_DEFAULTS.maxPerDay
  void commit({ maxPerDay: form.maxPerDay })
}

/** 一键把所有角色切回跟随全局，省得逐个进角色编辑器 */
async function followAll(): Promise<void> {
  const targets = ai.personas.filter((persona) => persona.proactiveMode !== 'global')
  if (targets.length === 0) return
  if (!window.confirm(`让 ${targets.length} 个角色跟随这份全局设置？它们各自的配置会被忽略。`)) return

  saving.value = true
  error.value = null
  try {
    for (const persona of targets) {
      await aiApi.updatePersona(persona.id, { proactiveMode: 'global' })
    }
    await ai.load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '切换失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="mb-6">
    <div class="mb-2 flex items-center justify-between">
      <h3 class="text-[12.5px] font-medium text-text">自动互动（全局）</h3>
      <span class="text-[11px] text-muted">
        <span v-if="saving">保存中…</span>
        <span v-else-if="saved" class="text-success">已保存</span>
        <span v-else>{{ followers }} 个角色跟随</span>
      </span>    </div>

    <p v-if="error" class="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
      {{ error }}
    </p>

    <div class="space-y-2 rounded-xl border border-line bg-surface p-3">
      <label class="flex items-start gap-2">
        <input
          type="checkbox"
          :checked="form.proactiveEnabled"
          class="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
          @change="
            form.proactiveEnabled = ($event.target as HTMLInputElement).checked;
            commit({ proactiveEnabled: form.proactiveEnabled })
          "
        />
        <span class="min-w-0">
          <span class="block text-[12.5px] font-medium text-text-strong">允许角色主动找我</span>
          <span class="block text-[11px] leading-relaxed text-muted">
            空闲够久后由角色先开口，或按固定间隔随机找话题；密钥托管在服务端时，你没开客户端也会发。
          </span>
        </span>
      </label>

      <div v-if="form.proactiveEnabled" class="grid grid-cols-2 gap-2 pl-[22px]">
        <label class="block">
          <span class="mb-0.5 block text-[11px] text-muted">触发方式</span>
          <select
            :value="form.triggerMode ?? 'idle'"
            class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
            @change="onSelect('triggerMode', $event)"
          >
            <option value="idle">空闲几小时后找</option>
            <option value="chance">定时随机找话题</option>
          </select>
        </label>
        <label class="block">
          <span class="mb-0.5 block text-[11px] text-muted">每个角色每天最多几条</span>
          <div class="flex items-center gap-1.5">
            <input
              :value="form.maxPerDay"
              type="number"
              min="0"
              max="998"
              :disabled="form.maxPerDay < 0"
              class="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent disabled:opacity-40"
              @change="onNumber('maxPerDay', $event, 0, 998)"
            />
            <label class="flex shrink-0 items-center gap-1 text-[11px] text-muted">
              <input
                type="checkbox"
                :checked="form.maxPerDay < 0"
                class="h-3 w-3 accent-[var(--color-accent)]"
                @change="toggleUnlimited"
              />
              无上限
            </label>
          </div>
        </label>

        <template v-if="(form.triggerMode ?? 'idle') === 'idle'">
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">空闲多久后找（小时）</span>
            <input
              :value="form.minIdleHours"
              type="number"
              min="0"
              max="720"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onNumber('minIdleHours', $event, 0, 720)"
            />
          </label>
        </template>
        <template v-else>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">掷骰间隔</span>
            <select
              :value="form.chanceUnit ?? 'hour'"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onSelect('chanceUnit', $event)"
            >
              <option value="minute">每分钟</option>
              <option value="hour">每小时</option>
            </select>
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">每次触发概率（%）</span>
            <input
              :value="Math.round((form.chanceProbability ?? 0.1) * 100)"
              type="number"
              min="0"
              max="100"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onChanceProbability"
            />
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">两条之间最少隔（分钟）</span>
            <input
              :value="form.chanceCooldownMinutes"
              type="number"
              min="0"
              max="1440"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onNumber('chanceCooldownMinutes', $event, 0, 1440)"
            />
          </label>
        </template>

        <label class="block">
          <span class="mb-0.5 block text-[11px] text-muted">免打扰开始（可跨零点）</span>
          <input
            :value="form.windowStart ?? ''"
            type="time"
            class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
            @change="onTime('windowStart', $event)"
          />
        </label>
        <label class="block">
          <span class="mb-0.5 block text-[11px] text-muted">免打扰结束</span>
          <input
            :value="form.windowEnd ?? ''"
            type="time"
            class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
            @change="onTime('windowEnd', $event)"
          />
        </label>
      </div>

      <div class="border-t border-line pt-2">
        <label class="flex items-start gap-2">
          <input
            type="checkbox"
            :checked="form.momentsEnabled"
            class="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
            @change="
              form.momentsEnabled = ($event.target as HTMLInputElement).checked;
              commit({ momentsEnabled: form.momentsEnabled })
            "
          />
          <span class="min-w-0">
            <span class="block text-[12.5px] font-medium text-text-strong">允许角色在动态广场活动</span>
            <span class="block text-[11px] leading-relaxed text-muted">
              角色会自己刷动态、随机点赞、给别人的动态留言，也会发自己的动态；额度按角色每天计。
            </span>
          </span>
        </label>

        <div v-if="form.momentsEnabled" class="mt-2 grid grid-cols-3 gap-2 pl-[22px]">
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">每天发动态</span>
            <input
              :value="form.momentsPostsPerDay"
              type="number"
              min="0"
              max="10"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onNumber('momentsPostsPerDay', $event, 0, 10)"
            />
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">每天评论</span>
            <input
              :value="form.momentsCommentsPerDay"
              type="number"
              min="0"
              max="20"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onNumber('momentsCommentsPerDay', $event, 0, 20)"
            />
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">每天点赞</span>
            <input
              :value="form.momentsLikesPerDay"
              type="number"
              min="0"
              max="20"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onNumber('momentsLikesPerDay', $event, 0, 20)"
            />
          </label>
        </div>
      </div>

      <div class="border-t border-line pt-2">
        <label class="flex items-start gap-2">
          <input
            type="checkbox"
            :checked="form.groupEnabled"
            class="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
            @change="
              form.groupEnabled = ($event.target as HTMLInputElement).checked;
              commit({ groupEnabled: form.groupEnabled })
            "
          />
          <span class="min-w-0">
            <span class="block text-[12.5px] font-medium text-text-strong">允许角色在群里接话</span>
            <span class="block text-[11px] leading-relaxed text-muted">
              被点名一定回；其他时候先按冷却、额度、体力筛选，再由角色自己决定要不要插话。安静够久时也可能主动开个话题。
            </span>
          </span>
        </label>

        <div v-if="form.groupEnabled" class="mt-2 grid grid-cols-2 gap-2 pl-[22px]">
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">每群每天最多插话</span>
            <input
              :value="form.groupRepliesPerDay"
              type="number"
              min="0"
              max="50"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onNumber('groupRepliesPerDay', $event, 0, 50)"
            />
          </label>
          <label class="block">
            <span class="mb-0.5 block text-[11px] text-muted">每群每天主动开口</span>
            <input
              :value="form.groupAutonomyPerDay"
              type="number"
              min="0"
              max="10"
              class="h-7 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
              @change="onNumber('groupAutonomyPerDay', $event, 0, 10)"
            />
          </label>
        </div>
      </div>

      <p class="flex items-start gap-1 text-[11px] leading-relaxed text-muted">
        <Icon name="sparkles" :size="12" class="mt-0.5 shrink-0 text-mention" />
        这些是默认值，角色可以在自己的设置里覆盖。改成 0 就是不启用对应的动作。
      </p>

      <button
        v-if="followers < ai.personas.length"
        type="button"
        class="w-full rounded-lg border border-line px-2 py-1 text-[11.5px] text-muted hover:text-text disabled:opacity-50"
        :disabled="saving"
        @click="followAll"
      >
        让全部角色跟随全局
      </button>
    </div>
  </section>
</template>
