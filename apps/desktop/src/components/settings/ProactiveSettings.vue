<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  GROUP_AI_DEFAULTS,
  MOMENT_AI_DEFAULTS,
  PROACTIVE_DEFAULTS,
  SEGMENT_REPLY_DEFAULTS,
  type AiGlobalSettings,
} from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import Field from '@/components/ui/form/Field.vue'
import NumberInput from '@/components/ui/form/NumberInput.vue'
import Select from '@/components/ui/form/Select.vue'
import Switch from '@/components/ui/form/Switch.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Button from '@/components/ui/form/Button.vue'
import Alert from '@/components/ui/form/Alert.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
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
  groupRepliesPerMessage: GROUP_AI_DEFAULTS.repliesPerMessage,
  groupReplyProbability: null,
  groupReplyCooldownMinutes: null,
  groupAutonomyPerDay: GROUP_AI_DEFAULTS.autonomyPerDay,
  debugMode: false,
  segmentEnabled: SEGMENT_REPLY_DEFAULTS.enabled,
  segmentPattern: SEGMENT_REPLY_DEFAULTS.pattern,
  streamEnabled: false,
}

const form = reactive<Editable>({ ...DEFAULTS })
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const confirmFollowAll = ref(false)

const triggerOptions = [
  { value: 'idle', label: '空闲几小时后找', description: '你安静够久，角色先开口' },
  { value: 'chance', label: '定时随机找话题', description: '按固定间隔掷骰' },
]
const chanceUnitOptions = [
  { value: 'minute', label: '每分钟' },
  { value: 'hour', label: '每小时' },
]

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

function setNumber(
  key: keyof Editable,
  value: number | null,
  min: number,
  max: number,
  fallback: number,
): void {
  const raw = value ?? fallback
  const next = Math.min(max, Math.max(min, Math.round(raw)))
  form[key] = next as never
  void commit({ [key]: next } as Partial<Editable>)
}

function setNullable(
  key: 'groupReplyProbability' | 'groupReplyCooldownMinutes',
  value: number | null,
  max: number,
): void {
  const next = value === null ? null : Math.min(max, Math.max(0, Math.round(value)))
  form[key] = next
  void commit({ [key]: next })
}

/** 概率用百分比展示，内部存 0-1 */
function setChanceProbability(percent: number | null): void {
  const value = Math.min(100, Math.max(0, Math.round(percent ?? 10)))
  form.chanceProbability = value / 100
  void commit({ chanceProbability: form.chanceProbability })
}

function setTime(key: 'windowStart' | 'windowEnd', value: string): void {
  form[key] = value || null
  void commit({ [key]: value || null })
}

/** 勾上无上限后配额存 -1，取消则回到默认值 */
function setUnlimited(unlimited: boolean): void {
  form.maxPerDay = unlimited ? -1 : PROACTIVE_DEFAULTS.maxPerDay
  void commit({ maxPerDay: form.maxPerDay })
}

/** 群接话的无上限勾选 */
function setGroupUnlimited(unlimited: boolean): void {
  form.groupRepliesPerDay = unlimited ? -1 : GROUP_AI_DEFAULTS.repliesPerDay
  void commit({ groupRepliesPerDay: form.groupRepliesPerDay })
}

/** 一键把所有角色切回跟随全局，省得逐个进角色编辑器 */
async function followAll(): Promise<void> {
  const targets = ai.personas.filter((persona) => persona.proactiveMode !== 'global')
  if (targets.length === 0) return

  saving.value = true
  error.value = null
  try {
    for (const persona of targets) {
      await aiApi.updatePersona(persona.id, { proactiveMode: 'global' })
    }
    // 刚把所有角色的模式改掉，store 的 loaded 守卫会跳过缓存，必须 force 才能拉到新状态
    await ai.load(true)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '切换失败'
  } finally {
    saving.value = false
    confirmFollowAll.value = false
  }
}

// 「已保存」的闪现定时器随组件清掉，避免切走设置页后还回来改状态
onBeforeUnmount(() => {
  if (savedTimer) clearTimeout(savedTimer)
})
</script>

<template>
  <SettingsCard
    id="proactive"
    title="自动互动（全局）"
    description="主动私聊与动态广场共用这份配置，角色默认跟随；想单独调的角色可在角色编辑器里覆盖"
    icon="sparkles"
  >
    <template #actions>
      <span class="text-[11px] text-muted">
        <span v-if="saving">保存中…</span>
        <span v-else-if="saved" class="text-success">已保存</span>
        <span v-else>{{ followers }} 个角色跟随</span>
      </span>
    </template>

    <Alert v-if="error" tone="danger" class="mb-3">{{ error }}</Alert>

    <SettingRow
      label="允许角色主动找我"
      description="空闲够久后由角色先开口，或按固定间隔随机找话题；密钥托管在服务端时，你没开客户端也会发。"
    >
      <Switch
        :model-value="form.proactiveEnabled"
        aria-label="允许角色主动找我"
        @update:model-value="
          (value) => {
            form.proactiveEnabled = value
            commit({ proactiveEnabled: value })
          }
        "
      />
    </SettingRow>

    <div v-if="form.proactiveEnabled" class="grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-2">
      <Field label="触发方式">
        <Select
          :model-value="form.triggerMode ?? 'idle'"
          :options="triggerOptions"
          @update:model-value="
            (value) => {
              form.triggerMode = value as 'idle' | 'chance'
              commit({ triggerMode: form.triggerMode })
            }
          "
        />
      </Field>

      <Field label="每个角色每天最多几条">
        <div class="flex items-center gap-2.5">
          <NumberInput
            class="min-w-0 flex-1"
            :model-value="form.maxPerDay"
            :min="0"
            :max="998"
            :disabled="form.maxPerDay < 0"
            @update:model-value="setNumber('maxPerDay', $event, 0, 998, PROACTIVE_DEFAULTS.maxPerDay)"
          />
          <label class="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted">
            <Switch
              size="sm"
              :model-value="form.maxPerDay < 0"
              aria-label="主动消息无上限"
              @update:model-value="setUnlimited"
            />
            无上限
          </label>
        </div>
      </Field>

      <template v-if="(form.triggerMode ?? 'idle') === 'idle'">
        <Field label="空闲多久后找" hint="按小时计，0 表示只要闲下来就可能触发">
          <NumberInput
            :model-value="form.minIdleHours"
            :min="0"
            :max="720"
            suffix="小时"
            @update:model-value="setNumber('minIdleHours', $event, 0, 720, PROACTIVE_DEFAULTS.minIdleHours)"
          />
        </Field>
      </template>
      <template v-else>
        <Field label="掷骰间隔">
          <Select
            :model-value="form.chanceUnit ?? 'hour'"
            :options="chanceUnitOptions"
            @update:model-value="
              (value) => {
                form.chanceUnit = value as 'minute' | 'hour'
                commit({ chanceUnit: form.chanceUnit })
              }
            "
          />
        </Field>
        <Field label="每次触发概率" hint="每次掷骰命中后才会真正发消息">
          <NumberInput
            :model-value="Math.round((form.chanceProbability ?? 0.1) * 100)"
            :min="0"
            :max="100"
            suffix="%"
            @update:model-value="setChanceProbability"
          />
        </Field>
        <Field label="两条之间最少间隔">
          <NumberInput
            :model-value="form.chanceCooldownMinutes"
            :min="0"
            :max="1440"
            suffix="分钟"
            @update:model-value="
              setNumber('chanceCooldownMinutes', $event, 0, 1440, PROACTIVE_DEFAULTS.chanceCooldownMinutes)
            "
          />
        </Field>
      </template>

      <Field label="免打扰开始" hint="可跨零点，留空表示不限制">
        <TextInput
          type="time"
          :model-value="form.windowStart ?? ''"
          @change="setTime('windowStart', ($event.target as HTMLInputElement).value)"
        />
      </Field>
      <Field label="免打扰结束" hint="这段时间内不会主动发消息">
        <TextInput
          type="time"
          :model-value="form.windowEnd ?? ''"
          @change="setTime('windowEnd', ($event.target as HTMLInputElement).value)"
        />
      </Field>
    </div>

    <SettingRow
      class="mt-1 border-t border-line pt-3"
      label="允许角色在动态广场活动"
      description="角色会自己刷动态、随机点赞、给别人的动态留言，也会发自己的动态；额度按角色每天计。"
    >
      <Switch
        :model-value="form.momentsEnabled"
        aria-label="允许角色在动态广场活动"
        @update:model-value="
          (value) => {
            form.momentsEnabled = value
            commit({ momentsEnabled: value })
          }
        "
      />
    </SettingRow>

    <div
      v-if="form.momentsEnabled"
      class="grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-3"
    >
      <Field label="每天发动态">
        <NumberInput
          :model-value="form.momentsPostsPerDay"
          :min="0"
          :max="10"
          @update:model-value="setNumber('momentsPostsPerDay', $event, 0, 10, MOMENT_AI_DEFAULTS.postsPerDay)"
        />
      </Field>
      <Field label="每天评论">
        <NumberInput
          :model-value="form.momentsCommentsPerDay"
          :min="0"
          :max="20"
          @update:model-value="
            setNumber('momentsCommentsPerDay', $event, 0, 20, MOMENT_AI_DEFAULTS.commentsPerDay)
          "
        />
      </Field>
      <Field label="每天点赞">
        <NumberInput
          :model-value="form.momentsLikesPerDay"
          :min="0"
          :max="20"
          @update:model-value="setNumber('momentsLikesPerDay', $event, 0, 20, MOMENT_AI_DEFAULTS.likesPerDay)"
        />
      </Field>
    </div>

    <SettingRow
      class="mt-1 border-t border-line pt-3"
      label="允许角色在群里接话"
      description="被点名一定回；其他时候先按冷却与额度筛选再掷概率，最后由角色自己决定要不要插话。安静够久时也可能主动开个话题。"
    >
      <Switch
        :model-value="form.groupEnabled"
        aria-label="允许角色在群里接话"
        @update:model-value="
          (value) => {
            form.groupEnabled = value
            commit({ groupEnabled: value })
          }
        "
      />
    </SettingRow>

    <div
      v-if="form.groupEnabled"
      class="grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-2"
    >
      <Field label="每群每天最多插话">
        <div class="flex items-center gap-2.5">
          <NumberInput
            class="min-w-0 flex-1"
            :model-value="form.groupRepliesPerDay"
            :min="0"
            :max="50"
            :disabled="form.groupRepliesPerDay < 0"
            @update:model-value="
              setNumber('groupRepliesPerDay', $event, 0, 50, GROUP_AI_DEFAULTS.repliesPerDay)
            "
          />
          <label class="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted">
            <Switch
              size="sm"
              :model-value="form.groupRepliesPerDay < 0"
              aria-label="群接话无上限"
              @update:model-value="setGroupUnlimited"
            />
            无上限
          </label>
        </div>
      </Field>
      <Field label="每群每天主动开口">
        <NumberInput
          :model-value="form.groupAutonomyPerDay"
          :min="0"
          :max="10"
          @update:model-value="
            setNumber('groupAutonomyPerDay', $event, 0, 10, GROUP_AI_DEFAULTS.autonomyPerDay)
          "
        />
      </Field>
      <Field label="每条消息最多接话角色" hint="角色排队接话，后面的角色能看到前面角色说的话">
        <NumberInput
          :model-value="form.groupRepliesPerMessage"
          :min="1"
          :max="5"
          @update:model-value="
            setNumber('groupRepliesPerMessage', $event, 1, 5, GROUP_AI_DEFAULTS.repliesPerMessage)
          "
        />
      </Field>
      <Field label="接话概率" hint="留空表示交给模型自己判断">
        <NumberInput
          :model-value="form.groupReplyProbability"
          :min="0"
          :max="100"
          allow-empty
          placeholder="智能"
          suffix="%"
          @update:model-value="setNullable('groupReplyProbability', $event, 100)"
        />
      </Field>
      <Field label="两次接话最少间隔" hint="留空使用默认冷却">
        <NumberInput
          :model-value="form.groupReplyCooldownMinutes"
          :min="0"
          :max="1440"
          allow-empty
          placeholder="默认 45 秒"
          suffix="分钟"
          @update:model-value="setNullable('groupReplyCooldownMinutes', $event, 1440)"
        />
      </Field>
    </div>

    <p class="mt-3 flex items-start gap-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
      <Icon name="sparkles" :size="12" class="mt-0.5 shrink-0 text-mention" />
      这些是默认值，角色可以在自己的设置里覆盖。改成 0 就是不启用对应的动作。
    </p>

    <Button
      v-if="followers < ai.personas.length"
      class="mt-2"
      size="sm"
      block
      :disabled="saving"
      @click="confirmFollowAll = true"
    >
      让全部角色跟随全局
    </Button>

    <ConfirmDialog
      v-model:open="confirmFollowAll"
      title="让全部角色跟随全局？"
      :description="`${ai.personas.length - followers} 个角色当前的单独配置会被忽略，改为使用这份全局设置。`"
      confirm-text="全部跟随"
      tone="primary"
      :loading="saving"
      @confirm="followAll"
    />
  </SettingsCard>
</template>
