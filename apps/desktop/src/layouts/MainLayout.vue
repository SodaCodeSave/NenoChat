<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import NavRail from '@/components/layout/NavRail.vue'
import ConversationList from '@/components/layout/ConversationList.vue'
import MobileTabBar from '@/components/layout/MobileTabBar.vue'
import SearchDialog from '@/components/layout/SearchDialog.vue'
import TitleBar from '@/components/layout/TitleBar.vue'

const ui = useUiStore()
const route = useRoute()

const isConversation = computed(() => route.name === 'conversation')
/** 手机端：首页 = 会话列表全屏；进入会话/子页面后只显示内容区 */
const isMobileHome = computed(() => ui.isMobile && route.name === 'home')
const showList = computed(() => (ui.isMobile ? isMobileHome.value : true))
const showMain = computed(() => (ui.isMobile ? !isMobileHome.value : true))
/** 只在四个一级 Tab 页显示底栏，会话设置等子页面保持沉浸 */
const tabVisible = computed(
  () =>
    ui.isMobile &&
    !isConversation.value &&
    route.name !== 'conversation-settings',
)

/** Ctrl/Cmd+K 是聊天软件的通用搜索入口 */
function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    ui.commandOpen = !ui.commandOpen
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="flex h-full w-full flex-col overflow-hidden bg-surface text-text">
    <TitleBar v-if="!ui.isMobile" :with-rail="true" />

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <NavRail v-if="!ui.isMobile" />

      <ConversationList v-if="showList" :mobile="ui.isMobile" />

      <main
        v-if="showMain"
        class="relative flex min-w-0 flex-1 flex-col overflow-hidden"
        :class="tabVisible ? 'pb-[calc(var(--mobile-tab-h)+var(--safe-bottom))]' : ''"
      >
        <slot />
      </main>

      <MobileTabBar v-if="tabVisible" />

      <SearchDialog />
    </div>
  </div>
</template>
