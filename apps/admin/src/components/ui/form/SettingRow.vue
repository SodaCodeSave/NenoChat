<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    description?: string
    forId?: string
    disabled?: boolean
    danger?: boolean
    /** 控件较宽时改为上下堆叠，默认左右排布 */
    stacked?: boolean
  }>(),
  {
    description: '',
    disabled: false,
    danger: false,
    stacked: false,
  },
)
</script>

<template>
  <div
    class="border-t border-line py-3.5 first:border-t-0 first:pt-0 last:pb-0"
    :class="[
      stacked ? 'block' : 'flex items-start justify-between gap-4',
      disabled ? 'opacity-60' : '',
    ]"
  >
    <div :class="stacked ? 'mb-2' : 'min-w-0 flex-1'">
      <label
        :for="forId"
        class="block text-[12.5px] font-medium"
        :class="danger ? 'text-danger' : 'text-text-strong'"
      >
        {{ label }}
      </label>
      <p v-if="description" class="mt-0.5 text-[11.5px] leading-relaxed text-muted">
        {{ description }}
      </p>
      <slot name="hint" />
    </div>
    <div :class="stacked ? '' : 'flex shrink-0 items-center gap-2'">
      <slot />
    </div>
  </div>
</template>
