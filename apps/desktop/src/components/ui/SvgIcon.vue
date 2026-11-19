<script setup lang="ts">
withDefaults(
  defineProps<{
    /** SVG 源码字符串，须用 ?raw 导入 */
    source: string
    /** 无障碍标签，空字符串时图标不参与无障碍树 */
    label?: string
    /** 字标模式：宽度按 SVG 比例自适应，高度由外部类决定 */
    autoWidth?: boolean
  }>(),
  { label: '', autoWidth: false },
)
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center leading-none"
    :class="autoWidth && 'auto-width'"
    role="img"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
    v-html="source"
  />
</template>

<style scoped>
span > :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

span.auto-width > :deep(svg) {
  width: auto;
  max-width: inherit;
}
</style>
