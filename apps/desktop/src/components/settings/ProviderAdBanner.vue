<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import {
  PROVIDER_AD_ROTATION_MS,
  hasRollSegment,
  parseAdTemplate,
  rollPartOf,
  type ProviderAdData,
} from '@/config/provider-ad'

const props = defineProps<{ ad: ProviderAdData }>()

/** 文案模板拆段：静态文字与滚动段交错，滚动段全部共用同一个下标同步轮换 */
const segments = computed(() => parseAdTemplate(props.ad.text))
const rolling = computed(() => hasRollSegment(segments.value))

const index = ref(0)
let rotationTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  if (!rolling.value) return
  rotationTimer = setInterval(() => {
    index.value += 1
  }, PROVIDER_AD_ROTATION_MS)
})

onBeforeUnmount(() => {
  if (rotationTimer !== null) clearInterval(rotationTimer)
  rotationTimer = null
})
</script>

<template>
  <!-- 有链接渲染成可点横幅，没链接渲染成不可点的展示条 -->
  <component
    :is="ad.link ? 'a' : 'div'"
    :href="ad.link || undefined"
    :target="ad.link ? '_blank' : undefined"
    :rel="ad.link ? 'noreferrer' : undefined"
    class="group mb-3 flex items-center gap-2.5 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2.5 transition-colors hover:border-accent/60 hover:bg-accent/10"
  >
    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface">
      <img v-if="ad.iconUrl" :src="ad.iconUrl" :alt="ad.title || '推广'" class="h-5 w-5 object-contain" />
      <Icon v-else name="megaphone" :size="16" class="text-accent" />
    </span>

    <span class="min-w-0 flex-1">
      <span v-if="ad.title" class="flex items-center gap-1 text-[12px] font-semibold text-text-strong">
        <Icon name="megaphone" :size="11" class="shrink-0 text-accent" />
        {{ ad.title }}
      </span>
      <span class="flex items-center overflow-hidden whitespace-nowrap text-[11px] text-muted">
        <template v-for="(segment, i) in segments" :key="i">
          <span v-if="segment.kind === 'text'">{{ segment.text }}</span>
          <span v-else class="roll-window">
            <!-- 全部候选项隐形堆在同一格撑住宽度，轮换时右侧文字不左右跳动 -->
            <span v-for="(part, j) in segment.parts" :key="j" class="roll-ghost" aria-hidden="true">
              {{ part }}
            </span>
            <Transition name="roll">
              <span :key="index" class="roll-current">{{ rollPartOf(segment, index) }}</span>
            </Transition>
          </span>
        </template>
      </span>
    </span>

    <span
      v-if="ad.link"
      class="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-accent transition-transform group-hover:translate-x-0.5"
    >
      查看详情
      <Icon name="chevronRight" :size="12" />
    </span>
  </component>
</template>

<style scoped>
/* inline-grid 把所有候选与当前项堆进同一格，格宽自动取最宽候选项 */
.roll-window {
  position: relative;
  display: inline-grid;
  grid-template-areas: 'stack';
  align-items: center;
  height: 1.4em;
  overflow: hidden;
  vertical-align: middle;
}
.roll-window > span {
  grid-area: stack;
  white-space: nowrap;
}
.roll-ghost {
  visibility: hidden;
}

.roll-enter-active,
.roll-leave-active {
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
.roll-enter-from {
  transform: translateY(100%);
}
.roll-leave-to {
  transform: translateY(-100%);
}

@media (prefers-reduced-motion: reduce) {
  .roll-enter-active,
  .roll-leave-active {
    transition: none;
  }
}
</style>
