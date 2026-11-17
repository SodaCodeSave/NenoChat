<script setup lang="ts">
import { computed } from 'vue'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'

const props = withDefaults(
  defineProps<{
    min?: number
    max?: number
    step?: number
    disabled?: boolean
    suffix?: string
    showValue?: boolean
  }>(),
  {
    min: 0,
    max: 100,
    step: 1,
    disabled: false,
    suffix: '',
    showValue: false,
  },
)

const model = defineModel<number>({ default: 0 })
const values = computed(() => [model.value])
const percent = computed(() => {
  const span = props.max - props.min
  if (span <= 0) return 0
  return Math.min(100, Math.max(0, ((model.value - props.min) / span) * 100))
})
</script>

<template>
  <div class="flex items-center gap-3">
    <SliderRoot
      :model-value="values"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      class="relative flex h-5 flex-1 touch-none select-none items-center data-[disabled]:opacity-45"
      @update:model-value="
        (next) => {
          const value = Array.isArray(next) ? next[0] : next
          if (typeof value === 'number') model = value
        }
      "
    >
      <SliderTrack class="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-3">
        <SliderRange class="absolute h-full rounded-full bg-accent" :style="{ width: `${percent}%` }" />
      </SliderTrack>
      <SliderThumb
        class="block h-4 w-4 rounded-full border-2 border-accent bg-surface shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent/25"
      />
    </SliderRoot>
    <span v-if="showValue" class="w-12 shrink-0 text-right text-[12px] tabular-nums text-muted">
      {{ model }}{{ suffix }}
    </span>
  </div>
</template>
