<script setup lang="ts">
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import Icon from '../Icon.vue'
import type { IconName } from '../icons'

export interface TabItem {
  value: string
  label: string
  icon?: IconName
  count?: number
}

withDefaults(
  defineProps<{
    tabs: TabItem[]
    ariaLabel?: string
    size?: 'sm' | 'md'
  }>(),
  { ariaLabel: '', size: 'md' },
)

const model = defineModel<string>({ default: '' })
</script>

<template>
  <TabsRoot v-model="model" class="min-w-0">
    <TabsList
      class="flex items-center gap-1 border-b border-line"
      :aria-label="ariaLabel || undefined"
    >
      <TabsTrigger
        v-for="tab in tabs"
        :key="tab.value"
        :value="tab.value"
        :class="[
          'relative -mb-px flex items-center gap-1.5 border-b-2 border-transparent font-medium text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent/20 data-[state=active]:border-accent data-[state=active]:text-text-strong',
          size === 'sm' ? 'px-2.5 pb-1.5 pt-1 text-[12px]' : 'px-3 pb-2 pt-1.5 text-[12.5px]',
        ]"
      >
        <Icon v-if="tab.icon" :name="tab.icon" :size="13" />
        {{ tab.label }}
        <span
          v-if="tab.count !== undefined"
          class="rounded-full bg-surface-2 px-1.5 text-[10.5px] tabular-nums text-muted"
        >
          {{ tab.count }}
        </span>
      </TabsTrigger>
    </TabsList>
    <slot />
  </TabsRoot>
</template>
