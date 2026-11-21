<script setup lang="ts">
import Dialog from './Dialog.vue'
import Button from './Button.vue'

withDefaults(
  defineProps<{
    title: string
    description?: string
    confirmText?: string
    cancelText?: string
    tone?: 'danger' | 'primary'
    loading?: boolean
  }>(),
  {
    description: '',
    confirmText: '确认',
    cancelText: '取消',
    tone: 'danger',
    loading: false,
  },
)

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{ (e: 'confirm'): void }>()
</script>

<template>
  <Dialog v-model:open="open" :title="title" :description="description" width="sm" :dismissible="!loading">
    <slot />
    <template #footer>
      <Button variant="ghost" :disabled="loading" @click="open = false">{{ cancelText }}</Button>
      <Button :variant="tone" :loading="loading" @click="emit('confirm')">{{ confirmText }}</Button>
    </template>
  </Dialog>
</template>
