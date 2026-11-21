<script setup lang="ts">
defineProps<{ status: 'active' | 'disabled' | string }>()
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
    :class="status === 'active' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'"
  >
    <span class="h-1.5 w-1.5 rounded-full" :class="status === 'active' ? 'bg-success' : 'bg-danger'" />
    {{ status === 'active' ? '正常' : '已停用' }}
  </span>
</template>
