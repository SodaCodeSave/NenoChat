<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import NavRail from '@/components/layout/NavRail.vue'
import ConversationList from '@/components/layout/ConversationList.vue'
import MobileTabBar from '@/components/layout/MobileTabBar.vue'
import SearchDialog from '@/components/layout/SearchDialog.vue'

const ui = useUiStore()
const route = useRoute()

const isConversation = computed(() => route.name === 'conversation')
/** 手机端进入会话后隐藏列表与底部 Tab，形成单栏体验 */
const showList = computed(() => (ui.isMobile ? !isConversation.value : true))

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
  <div class="flex h-full w-full overflow-hidden bg-surface text-text">
    <NavRail v-if="!ui.isMobile" />

    <ConversationList v-if="showList" />

    <main class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <slot />
    </main>

    <MobileTabBar v-if="ui.isMobile && !isConversation" />

    <SearchDialog />
  </div>
</template>
