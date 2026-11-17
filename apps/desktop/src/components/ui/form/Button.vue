<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../Icon.vue'
import type { IconName } from '../icons'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
    size?: 'sm' | 'md'
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    icon?: IconName
    block?: boolean
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    block: false,
  },
)

const variants: Record<NonNullable<typeof props.variant>, string> = {
  primary:
    'bg-accent text-accent-text shadow-sm hover:brightness-105 active:brightness-95 focus-visible:ring-accent/30',
  secondary:
    'border border-line bg-surface text-text hover:bg-surface-2 active:bg-surface-3 focus-visible:ring-accent/20',
  ghost:
    'text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3 focus-visible:ring-accent/20',
  danger:
    'bg-danger text-white shadow-sm hover:brightness-105 active:brightness-95 focus-visible:ring-danger/30',
  'danger-ghost':
    'border border-danger/35 text-danger hover:bg-danger/10 active:bg-danger/15 focus-visible:ring-danger/20',
}

const classes = computed(() => [
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium outline-none transition-[color,background-color,border-color,box-shadow,filter] focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
  props.size === 'sm' ? 'h-8 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13px]',
  variants[props.variant],
  props.block ? 'w-full' : '',
])
</script>

<template>
  <button :type="type" :disabled="disabled || loading" :class="classes">
    <Icon
      v-if="loading"
      name="refresh"
      :size="size === 'sm' ? 12 : 14"
      class="animate-spin"
    />
    <Icon v-else-if="icon" :name="icon" :size="size === 'sm' ? 13 : 15" />
    <slot />
  </button>
</template>
