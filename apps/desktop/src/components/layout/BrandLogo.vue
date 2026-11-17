<script setup lang="ts">
import { computed } from 'vue'
// 完整字标与单独 N 标，填充色跟随主题文字颜色
import wordmark from '@/assets/nenochat-logo.svg?raw'
import mark from '@/assets/nenochat-mark.svg?raw'

const props = defineProps<{ mark?: boolean }>()

const svg = computed(() => (props.mark ? mark : wordmark))
</script>

<template>
  <span class="inline-flex select-none" v-html="svg" />
</template>

<style scoped>
span :deep(svg) {
  display: block;
  height: 100%;
  width: auto;
}
</style>
