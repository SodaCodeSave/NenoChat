<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import BareLayout from '@/layouts/BareLayout.vue'
import LoadingScreen from '@/components/layout/LoadingScreen.vue'
import { bootstrap } from '@/app/bootstrap'
import { useServersStore } from '@/stores/servers'

const route = useRoute()
const router = useRouter()

const ready = ref(false)

const layout = computed(() => (route.meta.layout === 'bare' ? BareLayout : MainLayout))

onMounted(async () => {
  const ok = await bootstrap()
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
  <Transition name="boot-fade" mode="out-in">
    <LoadingScreen v-if="!ready" key="loading" />
    <component :is="layout" v-else key="main">
      <RouterView />
    </component>
  </Transition>
</template>
