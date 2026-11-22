<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'

const props = withDefaults(
  defineProps<{
    min?: number
    max?: number
    step?: number
    placeholder?: string
    disabled?: boolean
    allowEmpty?: boolean
    integer?: boolean
    suffix?: string
    id?: string
    size?: 'sm' | 'md'
  }>(),
  {
    min: 0,
    max: undefined,
    step: 1,
    placeholder: '',
    disabled: false,
    allowEmpty: false,
    integer: true,
    suffix: '',
    size: 'md',
  },
)

const model = defineModel<number | null>({ default: null })
const draft = ref(format(model.value))

function format(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? '' : String(value)
}

function clamp(value: number): number {
  const next = props.integer ? Math.round(value) : value
  const lower = Math.min(props.min, props.max ?? props.min)
  const upper = props.max ?? Number.POSITIVE_INFINITY
  return Math.min(upper, Math.max(lower, next))
}

watch(
  () => model.value,
  (value) => {
    const next = format(value)
    if (next !== draft.value) draft.value = next
  },
)

function commit(raw: string): void {
  const trimmed = raw.trim()
  if (trimmed === '') {
    if (props.allowEmpty) {
      model.value = null
      return
    }
    draft.value = format(model.value ?? props.min)
    return
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    draft.value = format(model.value)
    return
  }
  const next = clamp(parsed)
  model.value = next
  draft.value = String(next)
}

function stepBy(delta: number): void {
  if (props.disabled) return
  const current = model.value ?? props.min
  const next = clamp(current + delta)
  model.value = next
  draft.value = String(next)
}

const inputClass = computed(() => [
  'h-full min-w-0 flex-1 bg-transparent px-2.5 text-text outline-none placeholder:text-muted/60 disabled:cursor-not-allowed tabular-nums',
  props.size === 'sm' ? 'text-[12px]' : 'text-[13px]',
])
</script>

<template>
  <div
    class="flex items-center rounded-lg border border-line bg-surface-2 transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15"
    :class="[disabled ? 'cursor-not-allowed opacity-55' : '', size === 'sm' ? 'h-8' : 'h-9']"
  >
    <input
      :id="id"
      v-model="draft"
      type="text"
      inputmode="decimal"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="inputClass"
      @change="commit(draft)"
      @blur="commit(draft)"
      @keydown.up.prevent="stepBy(step)"
      @keydown.down.prevent="stepBy(-step)"
    />
    <span v-if="suffix" class="shrink-0 pr-1 text-[11.5px] text-muted">{{ suffix }}</span>
    <div class="flex shrink-0 items-center gap-0.5 pr-1">
      <button
        type="button"
        tabindex="-1"
        class="grid h-5 w-5 place-items-center rounded text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40"
        :disabled="disabled"
        aria-label="减少"
        @click="stepBy(-step)"
      >
        <Icon name="minus" :size="11" :stroke-width="2" />
      </button>
      <button
        type="button"
        tabindex="-1"
        class="grid h-5 w-5 place-items-center rounded text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40"
        :disabled="disabled"
        aria-label="增加"
        @click="stepBy(step)"
      >
        <Icon name="plus" :size="11" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>
