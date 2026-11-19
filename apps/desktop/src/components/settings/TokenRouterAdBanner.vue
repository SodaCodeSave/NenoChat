<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import tokenrouterIcon from '@/assets/icons/tokenrouter.svg'
import {
  PROVIDER_AD_DESCRIPTION_PARTS,
  PROVIDER_AD_LINK,
  PROVIDER_AD_MODELS,
  PROVIDER_AD_ROTATION_MS,
  PROVIDER_AD_TITLE,
  nextProviderAdIndex,
} from '@/config/provider-ad'

const index = ref(0)
let rotationTimer: ReturnType<typeof setInterval> | null = null

const currentModel = computed(() => PROVIDER_AD_MODELS[index.value])

onMounted(() => {
  rotationTimer = setInterval(() => {
    index.value = nextProviderAdIndex(index.value)
  }, PROVIDER_AD_ROTATION_MS)
})

onBeforeUnmount(() => {
  if (rotationTimer !== null) clearInterval(rotationTimer)
})
</script>

<template>
  <a
    :href="PROVIDER_AD_LINK"
    target="_blank"
    rel="noreferrer"
    class="group mb-3 flex items-center gap-2.5 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2.5 transition-colors hover:border-accent/60 hover:bg-accent/10"
  >
    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface">
      <img :src="tokenrouterIcon" :alt="PROVIDER_AD_TITLE" class="h-5 w-5 object-contain" />
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1 text-[12px] font-semibold text-text-strong">
        <Icon name="megaphone" :size="11" class="shrink-0 text-accent" />
        {{ PROVIDER_AD_TITLE }}
      </span>
      <span class="flex items-center overflow-hidden whitespace-nowrap text-[11px] text-muted">
        <span>{{ PROVIDER_AD_DESCRIPTION_PARTS.prefix }}</span>
        <span class="roll-window roll-window--model">
          <Transition name="roll">
            <span :key="index">{{ currentModel.name }}</span>
          </Transition>
        </span>
        <span>{{ PROVIDER_AD_DESCRIPTION_PARTS.middle }}</span>
        <span class="roll-window roll-window--price">
          <Transition name="roll">
            <span :key="index">{{ currentModel.price }}</span>
          </Transition>
        </span>
      </span>
    </span>

    <span
      class="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-accent transition-transform group-hover:translate-x-0.5"
    >
      前往注册
      <Icon name="chevronRight" :size="12" />
    </span>
  </a>
</template>

<style scoped>
.roll-window {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 1.4em;
  overflow: hidden;
  vertical-align: middle;
}
.roll-window > span {
  display: inline-block;
  white-space: nowrap;
}
/* 用最长内容的宽度撑住窗口，切换时右侧文字不左右跳动 */
.roll-window--model {
  min-width: 9.5em;
}
.roll-window--price {
  min-width: 4.5em;
}

.roll-enter-active,
.roll-leave-active {
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
.roll-leave-active {
  position: absolute;
  left: 0;
  top: 0;
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
