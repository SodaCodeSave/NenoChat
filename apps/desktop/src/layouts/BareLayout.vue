<script setup lang="ts">
/** 无外壳布局：登录、注册、服务器设置等全屏页面共用 */
import TitleBar from '@/components/layout/TitleBar.vue'
</script>

<template>
  <div class="flex h-full w-full flex-col overflow-hidden text-text">
    <TitleBar />

    <div
      class="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-surface-2 px-6 py-10"
    >
      <!-- 背景装饰：两团柔和光晕，深浅色下都成立 -->
      <div
        class="pointer-events-none absolute -top-24 -left-24 h-72 w-72 rounded-full opacity-40 blur-3xl"
        style="background: radial-gradient(circle, var(--accent) 0%, transparent 70%)"
      />
      <div
        class="pointer-events-none absolute -right-24 -bottom-24 h-80 w-80 rounded-full opacity-30 blur-3xl"
        style="background: radial-gradient(circle, var(--mention) 0%, transparent 70%)"
      />

      <div class="relative z-10 w-full max-w-md">
        <slot />
      </div>
    </div>
  </div>
</template>
