<script setup lang="ts">
/**
 * 表单项外壳：统一标签、说明与错误信息的字号/间距。
 * 控件本身由默认插槽传入，避免和具体输入类型耦合。
 */
withDefaults(
  defineProps<{
    label?: string
    hint?: string
    error?: string | null
    forId?: string
    optional?: boolean
  }>(),
  { label: '', hint: '', error: null, optional: false },
)
</script>

<template>
  <div class="block">
    <div v-if="label" class="mb-1.5 flex items-baseline justify-between gap-2">
      <label :for="forId" class="text-[12px] font-medium text-muted">
        {{ label }}
        <span v-if="optional" class="font-normal text-muted/60">· 可选</span>
      </label>
      <slot name="action" />
    </div>
    <slot />
    <p v-if="error" class="mt-1.5 text-[11.5px] leading-relaxed text-danger">{{ error }}</p>
    <p v-else-if="hint" class="mt-1.5 text-[11.5px] leading-relaxed text-muted">{{ hint }}</p>
  </div>
</template>
