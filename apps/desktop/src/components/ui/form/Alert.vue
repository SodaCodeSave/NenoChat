<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../Icon.vue'
import type { IconName } from '../icons'

const props = withDefaults(
  defineProps<{
    tone?: 'info' | 'success' | 'danger'
    icon?: IconName
  }>(),
  { tone: 'info' },
)

const toneClass = computed(
  () =>
    ({
      info: 'border-accent/25 bg-accent-soft/50 text-accent',
      success: 'border-success/25 bg-success/10 text-success',
      danger: 'border-danger/25 bg-danger/10 text-danger',
    })[props.tone],
)

const fallbackIcon = computed<IconName>(
  () => ({ info: 'sparkles', success: 'check', danger: 'close' })[props.tone] as IconName,
)
</script>

<template>
  <div
    class="flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed"
    :class="toneClass"
    role="status"
  >
    <Icon :name="icon ?? fallbackIcon" :size="13" class="mt-0.5 shrink-0" />
    <div class="min-w-0 flex-1"><slot /></div>
  </div>
</template>
