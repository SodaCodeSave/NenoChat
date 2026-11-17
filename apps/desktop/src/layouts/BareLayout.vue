<script setup lang="ts">
/** 无外壳布局：登录、注册、服务器设置等全屏页面共用 */
</script>

<template>
  <div
    class="relative grid h-full w-full place-items-center overflow-hidden bg-surface-2 px-6 py-10"
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
</template>
