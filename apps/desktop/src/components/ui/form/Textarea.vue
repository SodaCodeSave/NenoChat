<script setup lang="ts">
import { useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{
    rows?: number
    placeholder?: string
    disabled?: boolean
    invalid?: boolean
    mono?: boolean
    resize?: boolean
    id?: string
  }>(),
  {
    rows: 3,
    placeholder: '',
    disabled: false,
    invalid: false,
    mono: false,
    resize: true,
  },
)

const model = defineModel<string>({ default: '' })
const attrs = useAttrs()
</script>

<template>
  <textarea
    :id="id"
    v-model="model"
    v-bind="attrs"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    class="w-full rounded-lg border bg-surface-2 px-2.5 py-2 text-[13px] leading-relaxed text-text outline-none transition-[border-color,box-shadow] placeholder:text-muted/60 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-55"
    :class="[
      invalid
        ? 'border-danger/60 focus:border-danger focus:ring-danger/15'
        : 'border-line focus:border-accent focus:ring-accent/15',
      mono ? 'font-mono text-[12px]' : '',
      resize ? 'resize-y' : 'resize-none',
    ]"
  />
</template>
