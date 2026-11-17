<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getBaseUrl } from '@/api/http'

const props = withDefaults(
  defineProps<{
    name?: string | null
    src?: string | null
    seed?: string | null
    size?: number
    square?: boolean
    online?: boolean
    ring?: boolean
  }>(),
  { size: 36, square: false, online: undefined, ring: false },
)

const failed = ref(false)
watch(
  () => props.src,
  () => {
    failed.value = false
  },
)

/**
 * 库里存的是相对路径（/files/...），这里统一拼上当前服务器地址。
 * 所有头像展示都经过这一个组件，所以跨设备访问只需要改这一处。
 */
const resolvedSrc = computed(() => {
  const src = props.src
  if (!src) return null
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  const base = getBaseUrl().replace(/\/$/, '')
  return `${base}${src.startsWith('/') ? '' : '/'}${src}`
})

const showImage = computed(() => Boolean(resolvedSrc.value) && !failed.value)

const initial = computed(() => {
  const text = (props.name ?? '').trim()
  return text.length > 0 ? text.slice(0, 1).toUpperCase() : '?'
})

/** 用 id/名称派生稳定色相，同一用户头像底色永远一致 */
const hue = computed(() => {
  const source = props.seed ?? props.name ?? ''
  let hash = 0
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) % 360
  }
  return hash
})

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  borderRadius: props.square ? `${Math.round(props.size * 0.28)}px` : '999px',
  fontSize: `${Math.max(11, Math.round(props.size * 0.4))}px`,
  background: showImage.value ? 'transparent' : `hsl(${hue.value} 58% 52%)`,
}))
</script>

<template>
  <div class="relative shrink-0" :style="{ width: `${props.size}px`, height: `${props.size}px` }">
    <img
      v-if="showImage"
      :src="resolvedSrc!"
      :alt="props.name ?? ''"
      class="h-full w-full object-cover"
      :class="[props.square ? 'rounded-[28%]' : 'rounded-full', props.ring ? 'ring-2 ring-surface' : '']"
      :style="style"
      @error="failed = true"
    />
    <div
      v-else
      class="grid h-full w-full place-items-center font-medium text-white select-none"
      :class="props.ring ? 'ring-2 ring-surface' : ''"
      :style="style"
    >
      {{ initial }}
    </div>

    <span
      v-if="props.online !== undefined"
      class="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface"
      :class="props.online ? 'bg-success' : 'bg-muted'"
    />
  </div>
</template>
