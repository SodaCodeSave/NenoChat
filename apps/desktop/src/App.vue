<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import BareLayout from '@/layouts/BareLayout.vue'
import LoadingScreen from '@/components/layout/LoadingScreen.vue'
import BrandLogo from '@/components/layout/BrandLogo.vue'
import { bootstrap } from '@/app/bootstrap'
import { applyPairLink, listenPairLink, takeStartupPairLink } from '@/app/pairing'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const servers = useServersStore()

const ready = ref(false)
/** 一体版内置服务端起不来时没有登录页可退，只能就地报错并允许重试 */
const fatal = ref<string | null>(null)
/** 报错页的出口：重试启动，或去手动登录（扫码配对失败时用） */
const fatalAction = ref<'retry' | 'login'>('retry')

const layout = computed(() => (route.meta.layout === 'bare' ? BareLayout : MainLayout))

/** 启动引导；重试按钮会重跑一遍，先清掉上一次的失败状态 */
async function start(): Promise<void> {
  fatal.value = null
  fatalAction.value = 'retry'
  ready.value = false

  let pairFailure: string | null = null
  const link = await takeStartupPairLink()
  if (link && !servers.integrated) {
    try {
      // 扫码接入先把服务器和会话落好，接下来的 bootstrap 就能直接恢复
      await applyPairLink(link)
    } catch (e) {
      pairFailure = e instanceof Error ? e.message : '扫码接入失败'
    }
  }

  const ok = await bootstrap()
  ready.value = true
  if (ok) {
    // 自动登录成功：地址栏若还停在登录/设置页，回到首页
    if (route.meta.layout === 'bare') await router.replace('/')
    return
  }

  if (pairFailure) {
    fatal.value = pairFailure
    fatalAction.value = 'login'
    return
  }

  if (servers.integrated) {
    fatal.value = auth.restoreError ?? '内置服务端启动失败'
    return
  }

  await router.replace('/setup')
}

onMounted(async () => {
  await start()
  // 应用在前台时再扫码：接完直接重载，省去逐个 store 手动刷新
  await listenPairLink(async (target) => {
    try {
      await applyPairLink(target)
      window.location.reload()
    } catch (e) {
      fatal.value = e instanceof Error ? e.message : '扫码接入失败'
      fatalAction.value = 'login'
    }
  })
})
</script>

<template>
  <Transition name="boot-fade" mode="out-in">
    <LoadingScreen v-if="!ready" key="loading" />
    <div v-else-if="fatal" key="fatal" class="boot-error">
      <BrandLogo class="boot-error__logo" />
      <p class="boot-error__title">
        {{ fatalAction === 'login' ? '扫码接入没有成功' : '内置服务端没有启动起来' }}
      </p>
      <p class="boot-error__detail">{{ fatal }}</p>
      <p class="boot-error__hint">
        {{
          fatalAction === 'login'
            ? '确认电脑端已开启「允许手机接入」并保持在同一网络，然后重新扫码。'
            : '启动日志在应用日志目录的 integrated-server.log。'
        }}
      </p>
      <button
        v-if="fatalAction === 'login'"
        type="button"
        class="boot-error__retry"
        @click="router.replace('/setup')"
      >
        手动登录
      </button>
      <button v-else type="button" class="boot-error__retry" @click="start">重试</button>
    </div>
    <component :is="layout" v-else key="main">
      <RouterView />
    </component>
  </Transition>
</template>

<style scoped>
.boot-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  text-align: center;
  background: var(--surface);
}

.boot-error__logo {
  height: 26px;
  margin-bottom: 12px;
  color: var(--text-strong);
}

.boot-error__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
}

.boot-error__detail {
  max-width: 520px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}

.boot-error__hint {
  font-size: 12px;
  color: var(--text-muted);
}

.boot-error__retry {
  margin-top: 10px;
  padding: 7px 18px;
  font-size: 13px;
  font-weight: 500;
  color: #fff;
  background: var(--accent);
  border-radius: 8px;
  transition: opacity 0.15s ease;
}

.boot-error__retry:hover {
  opacity: 0.88;
}
</style>
