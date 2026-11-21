<script setup lang="ts">
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui'
import Icon from '../Icon.vue'

export interface SelectOption {
  value: string | number
  label: string
  description?: string
  disabled?: boolean
}

withDefaults(
  defineProps<{
    options: SelectOption[]
    placeholder?: string
    disabled?: boolean
    size?: 'sm' | 'md'
    id?: string
    align?: 'start' | 'center' | 'end'
  }>(),
  {
    placeholder: '请选择',
    disabled: false,
    size: 'md',
    align: 'start',
  },
)

const model = defineModel<string | number | null>({ default: null })
</script>

<template>
  <SelectRoot v-model="model" :disabled="disabled">
    <SelectTrigger
      :id="id"
      class="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 text-left text-text outline-none transition-[border-color,box-shadow] hover:border-line focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-55 data-[placeholder]:text-muted/60"
      :class="size === 'sm' ? 'h-8 text-[12px]' : 'h-9 text-[13px]'"
    >
      <SelectValue :placeholder="placeholder" class="min-w-0 flex-1 truncate" />
      <SelectIcon class="shrink-0 text-muted">
        <Icon name="chevronDown" :size="13" />
      </SelectIcon>
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        :align="align"
        class="z-50 max-h-72 min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow-soft)]"
      >
        <SelectViewport class="max-h-70 overflow-y-auto">
          <SelectItem
            v-for="option in options"
            :key="String(option.value)"
            :value="option.value"
            :disabled="option.disabled"
            class="relative flex cursor-default select-none items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-8 text-[12.5px] text-text outline-none transition-colors data-[highlighted]:bg-surface-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[state=checked]:font-medium data-[state=checked]:text-accent"
          >
            <span class="min-w-0 flex-1">
              <SelectItemText class="block truncate">{{ option.label }}</SelectItemText>
              <span v-if="option.description" class="block truncate text-[11px] text-muted">
                {{ option.description }}
              </span>
            </span>
            <SelectItemIndicator class="absolute right-2 text-accent">
              <Icon name="check" :size="13" :stroke-width="2.2" />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
