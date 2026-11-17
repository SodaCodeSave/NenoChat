<script setup lang="ts">
import { ToggleGroupItem, ToggleGroupRoot } from 'reka-ui'
import Icon from '../Icon.vue'
import type { IconName } from '../icons'

export interface SegmentedOption {
  value: string | number
  label: string
  icon?: IconName
  disabled?: boolean
}

withDefaults(
  defineProps<{
    options: SegmentedOption[]
    full?: boolean
    size?: 'sm' | 'md'
    ariaLabel?: string
  }>(),
  { full: false, size: 'md', ariaLabel: '' },
)

const model = defineModel<string | number>({ default: '' })
</script>

<template>
  <ToggleGroupRoot
    type="single"
    :model-value="model"
    :aria-label="ariaLabel || undefined"
    :class="[
      'inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5',
      full ? 'flex w-full' : '',
    ]"
    @update:model-value="
      (value) => {
        if (value !== undefined && value !== null && value !== '') model = value as string | number
      }
    "
  >
    <ToggleGroupItem
      v-for="option in options"
      :key="String(option.value)"
      :value="option.value"
      :disabled="option.disabled"
      :class="[
        'inline-flex flex-1 items-center justify-center gap-1.5 rounded-[6px] font-medium text-muted outline-none transition-[color,background-color,box-shadow] hover:text-text focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-40 data-[state=on]:bg-surface data-[state=on]:text-text-strong data-[state=on]:shadow-sm',
        size === 'sm' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-2.5 text-[12.5px]',
      ]"
    >
      <Icon v-if="option.icon" :name="option.icon" :size="size === 'sm' ? 12 : 13" />
      {{ option.label }}
    </ToggleGroupItem>
  </ToggleGroupRoot>
</template>
