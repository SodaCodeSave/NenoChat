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
    :data-invalid="invalid ? 'true' : undefined"
    class="field-shell w-full rounded-lg px-2.5 py-2 text-[13px] leading-relaxed text-text outline-none placeholder:text-muted/60 disabled:cursor-not-allowed disabled:opacity-55"
    :class="[mono ? 'font-mono text-[12px]' : '', resize ? 'resize-y' : 'resize-none']"
  />
</template>
