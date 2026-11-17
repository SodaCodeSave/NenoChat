<script setup lang="ts">
import Icon from '../Icon.vue'
import type { IconName } from '../icons'

withDefaults(
  defineProps<{
    title?: string
    description?: string
    icon?: IconName
    id?: string
    /** 危险操作卡片：整卡改用警示色边框 */
    tone?: 'default' | 'danger'
    bodyClass?: string
  }>(),
  { title: '', description: '', tone: 'default', bodyClass: 'p-4' },
)
</script>

<template>
  <section
    :id="id"
    class="scroll-mt-4 overflow-hidden rounded-xl border bg-surface"
    :class="tone === 'danger' ? 'border-danger/35' : 'border-line'"
  >
    <header
      v-if="title || $slots.actions"
      class="flex items-start gap-2 px-4 pt-3.5"
      :class="description ? 'pb-0' : 'pb-3'"
    >
      <span
        v-if="icon"
        class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md"
        :class="tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent'"
      >
        <Icon :name="icon" :size="13" />
      </span>
      <div class="min-w-0 flex-1">
        <h3
          class="text-[13px] font-semibold"
          :class="tone === 'danger' ? 'text-danger' : 'text-text-strong'"
        >
          {{ title }}
          <slot name="badge" />
        </h3>
        <p v-if="description" class="mt-0.5 text-[11.5px] leading-relaxed text-muted">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <slot name="actions" />
      </div>
    </header>

    <div v-if="$slots.default" :class="bodyClass">
      <slot />
    </div>
    <slot name="footer" />
  </section>
</template>
