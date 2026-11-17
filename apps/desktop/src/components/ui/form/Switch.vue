<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'

withDefaults(
  defineProps<{
    disabled?: boolean
    size?: 'sm' | 'md'
    id?: string
  }>(),
  { disabled: false, size: 'md' },
)

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <SwitchRoot
    :id="id"
    v-model="model"
    :disabled="disabled"
    class="group relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-surface-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-accent"
    :class="size === 'sm' ? 'h-[18px] w-8' : 'h-[22px] w-10'"
  >
    <SwitchThumb
      class="block rounded-full bg-white shadow-sm transition-transform will-change-transform data-[state=unchecked]:translate-x-0.5"
      :class="size === 'sm' ? 'h-3.5 w-3.5 data-[state=checked]:translate-x-[15px]' : 'h-[18px] w-[18px] data-[state=checked]:translate-x-[20px]'"
    />
  </SwitchRoot>
</template>
