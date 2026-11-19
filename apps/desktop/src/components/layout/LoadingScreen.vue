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
  overflow: hidden;
  background: var(--surface);
}

.boot-screen__logo {
  position: absolute;
  top: 62%;
  left: 50%;
  height: 30px;
  color: var(--text-strong);
  transform: translate(-50%, -50%);
}
</style>
