<script setup lang="ts">
import Icon from './ui/Icon.vue'
import type { IconName } from './ui/icons'

defineProps<{
  label: string
  value: string | number
  icon?: IconName
  hint?: string
}>()
</script>

<template>
  <div class="rounded-xl border border-line bg-surface p-4">
    <div class="flex items-center gap-2 text-[12px] text-muted">
      <Icon v-if="icon" :name="icon" :size="14" />
      <span>{{ label }}</span>
    </div>
    <div class="mt-1.5 text-[22px] font-semibold leading-tight text-text-strong tabular-nums">
      {{ value }}
    </div>
    <div v-if="hint" class="mt-1 text-[11px] text-muted">{{ hint }}</div>
  </div>
</template>
