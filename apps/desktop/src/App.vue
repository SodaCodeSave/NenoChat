<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import BareLayout from '@/layouts/BareLayout.vue'
import { bootstrap, type BootstrapStage } from '@/app/bootstrap'
import { useServersStore } from '@/stores/servers'

const route = useRoute()
const router = useRouter()

const ready = ref(false)
const stage = ref<BootstrapStage>('starting')

const layout = computed(() => (route.meta.layout === 'bare' ? BareLayout : MainLayout))

const stageLabel = computed(() => {
  const map: Record<BootstrapStage, string> = {
    starting: '正在启动…',
    server: '读取服务器配置…',
    auth: '恢复登录状态…',
    cache: '加载本地数据…',
    realtime: '连接实时通道…',
    ready: '准备就绪',
    error: '启动遇到问题',
  }
  return map[stage.value]
})

onMounted(async () => {
  const ok = await bootstrap((next) => {
    stage.value = next
  })
  ready.value = true
  if (ok) {
    // 自动登录成功：地址栏若还停在登录/设置页，回到首页
    if (route.meta.layout === 'bare') await router.replace('/')
    return
  }

  const servers = useServersStore()
  await router.replace(servers.current ? '/login' : '/setup')
})
</script>

<template>
  <BareLayout v-if="!ready">
    <div class="flex flex-col items-center gap-4">
      <div class="flex items-center gap-2 text-lg font-semibold text-text-strong">
        <span class="inline-block h-2.5 w-2.5 rounded-full bg-accent" />
        NenoChat
      </div>
      <p class="text-sm text-muted">{{ stageLabel }}</p>
    </div>
  </BareLayout>

  <component :is="layout" v-else>
    <RouterView />
  </component>
</template>
