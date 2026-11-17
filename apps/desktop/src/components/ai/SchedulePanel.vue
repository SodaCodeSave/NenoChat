<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  dayKeyOf,
  hmToMinutes,
  minutesOfLocalDay,
  type AiScheduleItem,
} from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import { useAiStore } from '@/stores/ai'

const props = defineProps<{ conversationId: string; mobile?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const ai = useAiStore()

const persona = computed(() => ai.personaOf(props.conversationId))
const dayKey = ref(dayKeyOf())
/** 每 30 秒重算一次，让「已发生」列表和进行中状态跟着时间走 */
const nowMinutes = ref(minutesOfLocalDay())
const loading = ref(true)
const generating = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const editing = ref(false)
const draft = ref<AiScheduleItem[]>([])

const debugMode = computed(() => ai.globalSettings?.debugMode ?? false)
const schedule = computed(() =>
  persona.value ? ai.cachedSchedule(persona.value.id, dayKey.value) : null,
)
const allItems = computed(() => schedule.value?.items ?? [])

function startMinutes(item: AiScheduleItem): number {
  return hmToMinutes(item.start) ?? 0
}

function endMinutes(item: AiScheduleItem): number {
  return hmToMinutes(item.end) ?? 0
}

const currentItem = computed(
  () =>
    allItems.value.find(
      (item) => nowMinutes.value >= startMinutes(item) && nowMinutes.value < endMinutes(item),
    ) ?? null,
)

/** 默认只展示已经开始过的日程；调试模式放开全天 */
const visibleItems = computed(() =>
  debugMode.value
    ? allItems.value
    : allItems.value.filter((item) => startMinutes(item) <= nowMinutes.value),
)

const sourceLabel = computed(() => {
  if (!schedule.value) return ''
  return schedule.value.source === 'manual' ? '手动调整' : 'AI 生成'
})

async function load(options: { force?: boolean } = {}): Promise<void> {
  if (generating.value) return
  const target = persona.value
  if (!target) {
    loading.value = false
    return
  }
  if (options.force) generating.value = true
  else loading.value = true
  error.value = null
  try {
    await ai.ensureSchedule(target.id, { force: options.force })
  } catch (e) {
    error.value = e instanceof Error ? e.message : '日程加载失败'
  } finally {
    loading.value = false
    generating.value = false
  }
}

function startEdit(): void {
  draft.value =
    allItems.value.length > 0
      ? allItems.value.map((item) => ({ ...item }))
      : [{ start: '08:00', end: '09:00', activity: '' }]
  error.value = null
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  draft.value = []
  error.value = null
}

function addRow(): void {
  const last = draft.value[draft.value.length - 1]
  const start = last?.end ?? '08:00'
  const startMinute = hmToMinutes(start) ?? 8 * 60
  const endMinute = Math.min(startMinute + 60, 23 * 60 + 59)
  const pad = (value: number): string => String(value).padStart(2, '0')
  draft.value.push({
    start,
    end: `${pad(Math.floor(endMinute / 60))}:${pad(endMinute % 60)}`,
    activity: '',
  })
}

function removeRow(index: number): void {
  draft.value.splice(index, 1)
}

async function saveEdit(): Promise<void> {
  const target = persona.value
  if (!target) return

  const items = draft.value
    .map((item) => ({
      start: item.start.trim(),
      end: item.end.trim(),
      activity: item.activity.replace(/\s+/g, ' ').trim(),
    }))
    .filter((item) => item.start && item.end && item.activity)

  if (items.length === 0) {
    error.value = '至少保留一条有内容的日程'
    return
  }
  const invalid = items.find((item) => {
    const from = hmToMinutes(item.start)
    const to = hmToMinutes(item.end)
    return from === null || to === null || to <= from
  })
  if (invalid) {
    error.value = '每段结束时间都要晚于开始时间'
    return
  }

  items.sort((a, b) => (hmToMinutes(a.start) ?? 0) - (hmToMinutes(b.start) ?? 0))
  saving.value = true
  error.value = null
  try {
    await ai.saveScheduleItems(target.id, dayKey.value, items)
    editing.value = false
    draft.value = []
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存日程失败'
  } finally {
    saving.value = false
  }
}

// 面板可能比角色列表先挂载；角色就绪后再补一次加载
watch(
  () => persona.value?.id,
  (id, previous) => {
    if (id && id !== previous) void load()
  },
)

let timer = 0
onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    nowMinutes.value = minutesOfLocalDay()
    const today = dayKeyOf()
    if (today !== dayKey.value) {
      dayKey.value = today
      void load()
    }
  }, 30_000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <aside
    class="flex flex-col bg-surface-2"
    :class="props.mobile ? 'w-full' : 'w-[280px] shrink-0 border-l border-line'"
  >
    <header
      class="flex items-center gap-1.5 border-b border-line px-3 py-3"
      :class="props.mobile ? 'pt-[calc(0.75rem+var(--safe-top))]' : ''"
    >
      <Icon name="calendar" :size="15" class="text-accent" />
      <div class="min-w-0 flex-1">
        <h2 class="text-[12.5px] font-medium text-text">今日日程</h2>
        <p class="text-[10.5px] text-muted">
          {{ dayKey }}
          <span v-if="sourceLabel"> · {{ sourceLabel }}</span>
        </p>
      </div>
      <IconButton
        icon="sparkles"
        label="重新生成"
        :size="14"
        @click="load({ force: true })"
      />
      <IconButton
        :icon="editing ? 'close' : 'edit'"
        :label="editing ? '取消编辑' : '手动调整'"
        :size="14"
        @click="editing ? cancelEdit() : startEdit()"
      />
      <IconButton icon="close" label="关闭" :size="14" @click="emit('close')" />
    </header>

    <div class="scroll-area flex-1 px-3 py-3 pb-[calc(0.75rem+var(--safe-bottom))]">
      <p v-if="loading" class="text-[12px] text-muted">读取日程中…</p>
      <p v-else-if="error" class="rounded-lg bg-danger/10 px-2 py-1.5 text-[12px] text-danger">
        {{ error }}
      </p>
      <p v-else-if="generating" class="text-[12px] text-accent">正在重新生成今天的日程…</p>

      <template v-else-if="editing">
        <div class="space-y-2">
          <div
            v-for="(item, index) in draft"
            :key="index"
            class="rounded-lg bg-surface p-2"
          >
            <div class="mb-1.5 flex items-center gap-1">
              <input
                v-model="item.start"
                type="time"
                class="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-1.5 text-[12px] text-text outline-none focus:border-accent"
              />
              <span class="text-[11px] text-muted">至</span>
              <input
                v-model="item.end"
                type="time"
                class="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-1.5 text-[12px] text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                class="shrink-0 rounded-md p-1 text-muted hover:text-danger"
                title="删除这段"
                @click="removeRow(index)"
              >
                <Icon name="trash" :size="13" />
              </button>
            </div>
            <input
              v-model="item.activity"
              type="text"
              maxlength="60"
              placeholder="这段时间在做什么"
              class="h-8 w-full rounded-md border border-line bg-surface-2 px-2 text-[12px] text-text outline-none placeholder:text-muted focus:border-accent"
            />
          </div>
        </div>

        <div class="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11.5px] text-muted hover:text-text"
            @click="addRow"
          >
            <Icon name="plus" :size="12" />
            添加时段
          </button>
          <span class="flex-1" />
          <button
            type="button"
            class="rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-muted hover:text-text"
            :disabled="saving"
            @click="cancelEdit"
          >
            取消
          </button>
          <button
            type="button"
            class="rounded-lg bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-60"
            :disabled="saving"
            @click="saveEdit"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </template>

      <template v-else>
        <p v-if="debugMode" class="mb-2 rounded-md bg-mention-soft px-2 py-1 text-[10.5px] text-mention">
          调试模式：显示全天日程
        </p>

        <p v-if="allItems.length === 0" class="text-[12px] text-muted">
          今天还没有日程，点右上角的 ✦ 生成一份。
        </p>
        <p v-else-if="visibleItems.length === 0" class="text-[12px] text-muted">
          今天还没有已经发生的安排。
        </p>

        <div
          v-for="item in visibleItems"
          :key="`${item.start}-${item.activity}`"
          class="mb-1.5 flex gap-2 rounded-lg px-2 py-1.5"
          :class="
            currentItem && item === currentItem
              ? 'border border-accent/50 bg-accent/10'
              : 'bg-surface'
          "
        >
          <div class="w-[76px] shrink-0 text-[11px] leading-[1.5] text-muted">
            <p class="text-text">{{ item.start }}–{{ item.end }}</p>
            <p v-if="currentItem && item === currentItem" class="text-accent">进行中</p>
          </div>
          <p class="min-w-0 flex-1 text-[12px] leading-[1.55] text-text">
            {{ item.activity }}
          </p>
        </div>

        <p v-if="visibleItems.length > 0 && !debugMode" class="mt-2 text-[10.5px] text-muted">
          只显示已经发生的安排。
        </p>
      </template>
    </div>
  </aside>
</template>
