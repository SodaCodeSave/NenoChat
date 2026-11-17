<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue'
import Icon from '../Icon.vue'
import type { IconName } from '../icons'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    type?: 'text' | 'password' | 'url' | 'email' | 'search' | 'tel' | 'time'
    size?: 'sm' | 'md'
    placeholder?: string
    disabled?: boolean
    invalid?: boolean
    mono?: boolean
    icon?: IconName
    id?: string
  }>(),
  {
    type: 'text',
    size: 'md',
    placeholder: '',
    disabled: false,
    invalid: false,
    mono: false,
  },
)

const model = defineModel<string>({ default: '' })
const attrs = useAttrs()
const revealed = ref(false)
const resolvedType = computed(() =>
  props.type === 'password' && revealed.value ? 'text' : props.type,
)
</script>

<template>
  <div
    class="group relative flex items-center rounded-lg border bg-surface-2 transition-[border-color,box-shadow,background-color] focus-within:ring-2"
    :class="[
      invalid
        ? 'border-danger/60 focus-within:border-danger focus-within:ring-danger/15'
        : 'border-line hover:border-line focus-within:border-accent focus-within:ring-accent/15',
      disabled ? 'cursor-not-allowed opacity-55' : '',
      size === 'sm' ? 'h-8' : 'h-9',
    ]"
  >
    <span v-if="icon" class="pl-2.5 text-muted">
      <Icon :name="icon" :size="size === 'sm' ? 13 : 14" />
    </span>
    <input
      :id="id"
      v-model="model"
      v-bind="attrs"
      :type="resolvedType"
      :placeholder="placeholder"
      :disabled="disabled"
      class="h-full min-w-0 flex-1 bg-transparent px-2.5 text-text outline-none placeholder:text-muted/60 disabled:cursor-not-allowed"
      :class="[
        size === 'sm' ? 'text-[12px]' : 'text-[13px]',
        mono ? 'font-mono' : '',
        icon ? 'pl-1.5' : '',
      ]"
    />
    <button
      v-if="type === 'password'"
      type="button"
      class="mr-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-3 hover:text-text"
      :disabled="disabled"
      @click="revealed = !revealed"
    >
      {{ revealed ? '隐藏' : '显示' }}
    </button>
    <slot name="suffix" />
  </div>
</template>
