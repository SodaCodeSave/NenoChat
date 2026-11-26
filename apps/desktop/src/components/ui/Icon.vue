<script setup lang="ts">
import { iconPaths, type IconName } from './icons'

const props = withDefaults(
  defineProps<{ name: IconName; size?: number; strokeWidth?: number }>(),
  { size: 18, strokeWidth: 1.8 },
)
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke-width="props.strokeWidth"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="inline-icon shrink-0"
  >
    <path :d="iconPaths[props.name]" />
  </svg>
</template>
