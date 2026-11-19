<script setup lang="ts">
import BrandLogo from '@/components/layout/BrandLogo.vue'
</script>

<template>
  <div class="boot-screen" role="status" aria-label="应用加载中">
    <BrandLogo class="boot-screen__logo" />
  </div>
</template>

<style scoped>
.boot-screen {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--surface);
}

.boot-screen__logo {
  height: 30px;
  color: var(--text-strong);
}

@media (max-width: 767px) {
  .boot-screen__logo {
    position: absolute;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 48px);
    left: 50%;
    transform: translateX(-50%);
  }
}
</style>
