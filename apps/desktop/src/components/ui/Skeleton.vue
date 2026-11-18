<script setup lang="ts">
/** 首屏占位块：尺寸由调用方给，颜色与动画统一在 index.css 的 .skeleton 里 */
withDefaults(
  defineProps<{
    width?: string
    height?: string
    circle?: boolean
  }>(),
  { width: '100%', height: '0.7rem', circle: false },
)
</script>

<template>
  <span
    class="skeleton block shrink-0"
    :class="circle ? 'rounded-full' : 'rounded-md'"
    :style="{ width, height }"
    aria-hidden="true"
  />
</template>
