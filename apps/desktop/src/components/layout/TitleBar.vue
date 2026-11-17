<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import BrandLogo from '@/components/layout/BrandLogo.vue'
import Icon from '@/components/ui/Icon.vue'

const props = defineProps<{
  /** 左侧品牌区与导航栏同色融合，用于带 NavRail 的主布局 */
  withRail?: boolean
}>()

// 只有在 Tauri WebView 内运行时才渲染顶栏，纯浏览器开发时不显示
const isTauri = '__TAURI_INTERNALS__' in window

const appWindow = isTauri ? getCurrentWindow() : null
const maximized = ref(false)
let unlistenResized: (() => void) | null = null

onMounted(async () => {
  if (!appWindow) return
  const syncState = async () => {
    maximized.value = await appWindow.isMaximized()
  }
  await syncState()
  unlistenResized = await appWindow.onResized(() => {
    void syncState()
  })
})

onBeforeUnmount(() => unlistenResized?.())

function toggleMaximize(): void {
  void appWindow?.toggleMaximize()
}
</script>

<template>
  <header
    v-if="isTauri"
    class="flex h-9 shrink-0 select-none"
    data-tauri-drag-region
  >
    <!-- 品牌区：与侧边栏同色且无分隔线，融为一体 -->
    <div
      v-if="props.withRail"
      class="flex w-16 shrink-0 items-center justify-center bg-rail"
      data-tauri-drag-region
    >
      <BrandLogo mark class="pointer-events-none h-4 text-text-strong" />
    </div>

    <!-- 无导航栏布局（登录页等）：直接放完整字标 -->
    <div
      v-else
      class="flex h-full items-center border-b border-line bg-surface pr-2 pl-3"
      data-tauri-drag-region
    >
      <BrandLogo class="pointer-events-none h-[17px] text-text-strong" />
    </div>

    <!-- 中部空白区全部可拖拽，双击切换最大化；下方保留与内容区的分隔线 -->
    <div
      class="min-w-0 flex-1 self-stretch border-b border-line bg-rail"
      data-tauri-drag-region
    />

    <!-- 窗口控制按钮 -->
    <button
      type="button"
      class="grid h-full w-11 place-items-center border-b border-line bg-rail text-muted transition-colors hover:bg-rail-active hover:text-text"
      title="最小化"
      @click="appWindow?.minimize()"
    >
      <Icon name="minus" :size="16" />
    </button>
    <button
      type="button"
      class="grid h-full w-11 place-items-center border-b border-line bg-rail text-muted transition-colors hover:bg-rail-active hover:text-text"
      :title="maximized ? '向下还原' : '最大化'"
      @click="toggleMaximize"
    >
      <Icon :name="maximized ? 'restore' : 'maximize'" :size="14" />
    </button>
    <button
      type="button"
      class="grid h-full w-11 place-items-center border-b border-line bg-rail text-muted transition-colors hover:bg-danger hover:text-white"
      title="关闭"
      @click="appWindow?.close()"
    >
      <Icon name="close" :size="16" />
    </button>
  </header>
</template>
