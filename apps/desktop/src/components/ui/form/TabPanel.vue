<script setup lang="ts">
import { TabsContent } from 'reka-ui'

defineProps<{ value: string; class?: string }>()
</script>

<template>
  <TabsContent :value="value" class="outline-none focus-visible:ring-2 focus-visible:ring-accent/20">
    <slot />
  </TabsContent>
</template>
