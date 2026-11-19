<script setup lang="ts">
import { computed, ref } from 'vue'
import Select from '@/components/ui/form/Select.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import IconButton from '@/components/ui/IconButton.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    models?: string[]
    placeholder?: string
    id?: string
    size?: 'sm' | 'md'
    disabled?: boolean
  }>(),
  { models: () => [], placeholder: '选择或输入模型名', size: 'md', disabled: false },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const customMode = ref(false)

/** 当前值不在列表里时也放进选项，保证回显不会变成空白 */
const options = computed(() => {
  const list = [...props.models]
  if (props.modelValue && !list.includes(props.modelValue)) list.unshift(props.modelValue)
  return list.map((value) => ({ value, label: value }))
})

function onSelect(value: string | number | null): void {
  if (typeof value === 'string') emit('update:modelValue', value)
}

function toggleMode(): void {
  customMode.value = !customMode.value
  if (!customMode.value && !props.models.includes(props.modelValue) && props.models.length > 0) {
    emit('update:modelValue', props.models[0]!)
  }
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <Select
      v-if="!customMode"
      :id="id"
      :model-value="modelValue || null"
      :options="options"
      :placeholder="placeholder"
      :size="size"
      :disabled="disabled || models.length === 0"
      @update:model-value="onSelect"
    />
    <TextInput
      v-else
      :id="id"
      :model-value="modelValue"
      :placeholder="placeholder"
      :size="size"
      :disabled="disabled"
      spellcheck="false"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <IconButton
      :icon="customMode ? 'chevronDown' : 'edit'"
      :size="size === 'sm' ? 14 : 18"
      :label="customMode ? '从列表选择' : '手动输入模型名'"
      @click="toggleMode"
    />
  </div>
</template>
