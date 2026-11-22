<script setup lang="ts">
import Icon from './Icon.vue'
import type { IconName } from './icons'

withDefaults(
  defineProps<{
    icon: IconName
    label: string
    active?: boolean
    size?: number
    tone?: 'default' | 'danger' | 'accent'
  }>(),
  { active: false, size: 18, tone: 'default' },
)
</script>

<template>
  <button
    type="button"
    :aria-label="label"
    :title="label"
    class="grid h-8 w-8 place-items-center rounded-lg transition-colors"
    :class="[
      tone === 'danger'
        ? 'text-danger hover:bg-danger/10'
        : tone === 'accent'
          ? 'text-accent hover:bg-accent-soft'
          : 'text-muted hover:bg-surface-3 hover:text-text',
      active ? 'bg-surface-3 text-text' : '',
    ]"
  >
    <Icon :name="icon" :size="size" />
  </button>
</template>
