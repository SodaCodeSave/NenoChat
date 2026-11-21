<script setup lang="ts">
defineProps<{ text: string }>()
</script>

<template>
  <div class="py-10 text-center text-[12.5px] text-muted">{{ text }}</div>
</template>
