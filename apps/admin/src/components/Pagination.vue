<script setup lang="ts">
import { computed } from 'vue'
import Button from './ui/form/Button.vue'
import Icon from './ui/Icon.vue'

const props = defineProps<{ page: number; total: number; pageSize: number }>()
const emit = defineEmits<{ (e: 'update:page', page: number): void }>()

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const rangeLabel = computed(() => {
  if (props.total === 0) return '0 条'
  const start = (props.page - 1) * props.pageSize + 1
  const end = Math.min(props.page * props.pageSize, props.total)
  return `${start}-${end} 条 / 共 ${props.total} 条`
})
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <span class="text-[11.5px] text-muted">{{ rangeLabel }}</span>
    <div class="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        :disabled="page <= 1"
        aria-label="上一页"
        @click="emit('update:page', page - 1)"
      >
        <Icon name="chevronLeft" :size="13" />
      </Button>
      <span class="min-w-14 text-center text-[12px] text-muted tabular-nums">
        {{ page }} / {{ totalPages }}
      </span>
      <Button
        size="sm"
        variant="ghost"
        :disabled="page >= totalPages"
        aria-label="下一页"
        @click="emit('update:page', page + 1)"
      >
        <Icon name="chevronRight" :size="13" />
      </Button>
    </div>
  </div>
</template>
