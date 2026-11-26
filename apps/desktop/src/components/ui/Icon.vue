<script setup lang="ts">
import { computed } from 'vue'
import { iconFilledPaths, iconPaths, type IconName } from './icons'

const props = withDefaults(
  defineProps<{
    name: IconName
    size?: number
    strokeWidth?: number
    /** 请求实心态；没有实心路径的图标自动回退到线性描边 */
    filled?: boolean
  }>(),
  { size: 18, strokeWidth: 1.8, filled: false },
)

const filledPath = computed(() => (props.filled ? iconFilledPaths[props.name] : undefined))
const path = computed(() => filledPath.value ?? iconPaths[props.name])
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    :fill="filledPath ? 'currentColor' : 'none'"
    :fill-rule="filledPath ? 'evenodd' : undefined"
    :stroke="filledPath ? 'none' : 'currentColor'"
    :stroke-width="props.strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="inline-icon shrink-0"
  >
    <path :d="path" />
  </svg>
</template>
