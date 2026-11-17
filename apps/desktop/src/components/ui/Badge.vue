<script setup lang="ts">
withDefaults(
  defineProps<{
    count?: number
    tone?: 'accent' | 'mention' | 'muted'
    dot?: boolean
  }>(),
  { count: 0, tone: 'accent', dot: false },
)
</script>

<template>
  <span
    v-if="dot"
    class="inline-block h-2 w-2 rounded-full"
    :class="tone === 'mention' ? 'bg-mention' : tone === 'muted' ? 'bg-muted' : 'bg-accent'"
  />
  <span
    v-else-if="count > 0"
    class="inline-grid min-w-[18px] place-items-center rounded-full px-1.5 text-[11px] leading-[18px] font-medium text-white"
    :class="tone === 'mention' ? 'bg-mention' : tone === 'muted' ? 'bg-muted' : 'bg-accent'"
  >
    {{ count > 99 ? '99+' : count }}
  </span>
</template>
