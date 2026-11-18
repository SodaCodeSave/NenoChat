<script setup lang="ts">
import { computed } from 'vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  VisuallyHidden,
} from 'reka-ui'
import Icon from '../Icon.vue'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    width?: 'sm' | 'md' | 'lg'
    dismissible?: boolean
  }>(),
  { description: '', width: 'md', dismissible: true },
)

const open = defineModel<boolean>('open', { default: false })

const widthClass = computed(
  () =>
    ({
      sm: 'max-w-sm',
      md: 'max-w-md',
      lg: 'max-w-2xl',
    })[props.width],
)

/** 不可关闭时，遮罩点击与 Esc 一律拦截，危险操作必须显式选择 */
function guardDismiss(event: Event): void {
  if (!props.dismissible) event.preventDefault()
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] transition-opacity duration-150 data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
      />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-soft)] outline-none data-[state=open]:animate-rise-in data-[state=closed]:animate-fade-out"
        :class="widthClass"
        @escape-key-down="guardDismiss"
        @pointer-down-outside="guardDismiss"
      >
        <div class="mb-3 flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-[14.5px] font-semibold text-text-strong">
              {{ title }}
            </DialogTitle>
            <DialogDescription v-if="description" class="mt-1 text-[12px] leading-relaxed text-muted">
              {{ description }}
            </DialogDescription>
            <VisuallyHidden v-else>
              <DialogDescription>{{ title }}</DialogDescription>
            </VisuallyHidden>
          </div>
          <DialogClose
            v-if="dismissible"
            class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
            aria-label="关闭"
          >
            <Icon name="close" :size="14" />
          </DialogClose>
        </div>

        <slot />

        <div v-if="$slots.footer" class="mt-5 flex items-center justify-end gap-2">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
