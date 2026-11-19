<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import LoginForm from '@/components/auth/LoginForm.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useServersStore, normalizeServerUrl } from '@/stores/servers'
import { resetWorkspace } from '@/app/bootstrap'
import {
  LocalNetworkPermissionError,
  localNetworkState,
  nativeBridgeAvailable,
  nativeDiagnostics,
  openLocalNetworkSettings,
  requestLocalNetworkAccess,
  requiresLocalNetworkAccess,
  webviewChromiumVersion,
  type LocalNetworkState,
  type NativeDiagnostics,
} from '@/platform/local-network'
import { isTauri, platformName } from '@/platform/device'

type ProbeState = 'checking' | 'online' | 'offline' | 'blocked'

const auth = useAuthStore()
const servers = useServersStore()
const ui = useUiStore()

const url = ref('http://localhost:8787')
const label = ref('')
const adding = ref(false)
const probing = ref(false)
const switchingId = ref<string | null>(null)
const error = ref<string | null>(null)
const status = ref<Record<string, ProbeState>>({})
const versions = ref<Record<string, string | null>>({})
const localNetwork = ref<LocalNetworkState>('unsupported')

/** 手机端卡片当前朝向：servers=选服务器，login=登录表单 */
const face = ref<'servers' | 'login'>(
  ui.isMobile && servers.current !== null ? 'login' : 'servers',
)
const flipping = ref(false)
/** 翻转相位：out=转走，in=换面后待转回 */
const tilt = ref<'out' | 'in' | null>(null)

const flipClass = computed(() => {
  if (tilt.value === 'out') return 'setup-flip-out'
  if (tilt.value === 'in') return 'setup-flip-in'
  return ''
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 两面之间平滑翻转：缩小转走 → 换面 → 放大转回 */
async function flipTo(next: 'servers' | 'login'): Promise<void> {
  if (next === face.value || flipping.value) return
  if (!ui.isMobile || ui.reduceMotion) {
    face.value = next
    return
  }
  flipping.value = true
  tilt.value = 'out'
  await wait(170)
  face.value = next
  tilt.value = 'in'
  await nextTick()
  // 强制回流，让换面后的起始姿态先落定再过渡回去
  void document.body.offsetHeight
  tilt.value = null
  await wait(200)
  flipping.value = false
}

// 窗口尺寸跨过移动端断点时，把朝向对齐到当前状态
watch(
  () => ui.isMobile,
  (mobile) => {
    tilt.value = null
    flipping.value = false
    if (mobile) face.value = servers.current !== null ? 'login' : 'servers'
    else face.value = 'servers'
  },
)

const normalized = computed(() => {
  try {
    return normalizeServerUrl(url.value).baseUrl
  } catch {
    return ''
  }
})

/** 当前操作是否涉及局域网地址：只有这类地址才需要本地网络权限 */
const touchesLocalNetwork = computed(
  () =>
    requiresLocalNetworkAccess(url.value) ||
    servers.servers.some((server) => requiresLocalNetworkAccess(server.baseUrl)),
)

const permissionBlocked = computed(
  () =>
    touchesLocalNetwork.value &&
    (localNetwork.value === 'prompt' || localNetwork.value === 'denied'),
)

/** 安装包缺少原生桥时无法申请权限，只能提示更新客户端 */
const bridgeMissing = computed(
  () =>
    touchesLocalNetwork.value &&
    isTauri() &&
    platformName() === 'android' &&
    !nativeBridgeAvailable(),
)

const diagnostics = ref<NativeDiagnostics | null>(null)

/** 连不上时把环境摊开，省得用户只能报「连不上」 */
const diagnosticLine = computed(() => {
  const parts: string[] = []
  if (diagnostics.value) parts.push(`API ${diagnostics.value.sdk}`)
  const chromium = webviewChromiumVersion()
  if (diagnostics.value?.webviewVersion) parts.push(`WebView ${diagnostics.value.webviewVersion}`)
  else if (chromium) parts.push(`Chromium ${chromium}`)
  parts.push(`权限 ${localNetwork.value}`)
  return parts.join(' · ')
})

async function refreshLocalNetwork(): Promise<void> {
  diagnostics.value = nativeDiagnostics()
  localNetwork.value = await localNetworkState()
}

/** 对所有已保存服务器并发发起 /server/info 探测，结果按服务器 id 记录 */
async function testServers(): Promise<void> {
  if (probing.value) return
  probing.value = true
  const snapshot = [...servers.servers]
  status.value = {}
  versions.value = {}
  for (const server of snapshot) {
    status.value[server.id] = 'checking'
    versions.value[server.id] = null
  }
  await Promise.all(
    snapshot.map(async (server) => {
      try {
        const info = await servers.probe(server.baseUrl)
        status.value[server.id] = 'online'
        versions.value[server.id] = info.version
      } catch (e) {
        status.value[server.id] = e instanceof LocalNetworkPermissionError ? 'blocked' : 'offline'
        if (e instanceof LocalNetworkPermissionError) localNetwork.value = e.state
      }
    }),
  )
  probing.value = false
}

function dotClass(state: ProbeState | undefined): string {
  if (state === 'online') return 'bg-success'
  if (state === 'offline') return 'bg-danger'
  if (state === 'blocked') return 'bg-accent'
  return 'bg-muted/50'
}

function dotLabel(state: ProbeState | undefined): string {
  if (state === 'online') return '测试通过'
  if (state === 'offline') return '测试失败'
  if (state === 'blocked') return '需要本地网络权限'
  return '测试中'
}

async function grantPermission(): Promise<void> {
  localNetwork.value = await requestLocalNetworkAccess()
  if (localNetwork.value === 'granted') await testServers()
}

function goToSettings(): void {
  openLocalNetworkSettings()
}

/** 从系统设置返回时权限可能变了，重查一次并顺带重测 */
async function onWindowFocus(): Promise<void> {
  const before = localNetwork.value
  await refreshLocalNetwork()
  if (before !== 'granted' && localNetwork.value === 'granted') await testServers()
}

onMounted(() => {
  // 先拿到权限状态再探测：缺权限时把服务器标成待授权，而不是笼统的不可用
  void (async () => {
    await refreshLocalNetwork()
    await testServers()
  })()
  window.addEventListener('focus', onWindowFocus)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus)
})

async function selectServer(id: string): Promise<void> {
  if (switchingId.value) return
  // 已选中的服务器再点一次，手机端直接翻到登录面
  if (id === servers.currentId) {
    void flipTo('login')
    return
  }
  switchingId.value = id
  try {
    await servers.setCurrent(id)
    resetWorkspace()
    await auth.clearSession()
    void flipTo('login')
  } finally {
    switchingId.value = null
  }
}

async function connect(): Promise<void> {
  if (!url.value.trim() || adding.value) return
  adding.value = true
  error.value = null
  try {
    const instance = await servers.add(url.value, label.value || undefined)
    await servers.setCurrent(instance.id)
    status.value[instance.id] = 'online'
    versions.value[instance.id] = servers.serverInfo?.version ?? null
    resetWorkspace()
    await auth.clearSession()
    url.value = ''
    label.value = ''
    void flipTo('login')
  } catch (e) {
    if (e instanceof LocalNetworkPermissionError) localNetwork.value = e.state
    error.value = e instanceof Error ? e.message : '连接失败，请检查地址'
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div class="grid gap-5 lg:grid-cols-2 lg:items-stretch">
    <section
      v-show="!ui.isMobile || face === 'servers'"
      class="setup-flip h-full rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-soft)]"
      :class="flipClass"
    >
      <div class="mb-5 flex items-start justify-between">
        <div class="flex items-center gap-2">
          <span class="grid h-9 w-9 place-items-center rounded-xl bg-accent text-accent-text">
            <Icon name="server" :size="18" />
          </span>
          <div>
            <h1 class="text-[16px] font-semibold text-text-strong">选择服务器</h1>
            <p class="text-[12px] text-muted">绿点可用 · 红点不可用</p>
          </div>
        </div>
        <button
          type="button"
          class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] text-muted hover:bg-surface-2 hover:text-accent disabled:opacity-50"
          :disabled="probing"
          :title="probing ? '正在测试' : '重新测试所有服务器'"
          @click="testServers"
        >
          <Icon name="refresh" :size="14" />
          {{ probing ? '测试中' : '刷新' }}
        </button>
      </div>

      <div
        v-if="bridgeMissing"
        class="mb-4 rounded-xl border border-danger/40 bg-danger/10 p-3"
      >
        <div class="flex items-start gap-2">
          <Icon name="wifiOff" :size="15" class="mt-0.5 text-danger" />
          <div class="min-w-0">
            <p class="text-[12.5px] font-medium text-text-strong">当前安装包缺少本地网络支持</p>
            <p class="mt-1 text-[11.5px] leading-relaxed text-muted">
              这个安装包没有带原生权限声明，系统会静默拦截对局域网服务器的访问。请更新或重新安装客户端。
            </p>
            <p class="mt-2 font-mono text-[10.5px] text-muted">{{ diagnosticLine }}</p>
          </div>
        </div>
      </div>

      <div
        v-else-if="permissionBlocked"
        class="mb-4 rounded-xl border border-accent/35 bg-accent-soft/50 p-3"
      >
        <div class="flex items-start gap-2">
          <Icon name="wifiOff" :size="15" class="mt-0.5 text-accent" />
          <div class="min-w-0">
            <p class="text-[12.5px] font-medium text-text-strong">需要「附近的设备」权限</p>
            <p class="mt-1 text-[11.5px] leading-relaxed text-muted">
              Android 17 起系统会拦截应用对局域网服务器的访问，允许本地网络权限后才能连接。
            </p>
            <p class="mt-2 font-mono text-[10.5px] text-muted">{{ diagnosticLine }}</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                class="rounded-lg bg-accent px-3 py-1.5 text-[11.5px] font-medium text-accent-text"
                @click="grantPermission"
              >
                {{ localNetwork === 'denied' ? '重新请求权限' : '允许访问' }}
              </button>
              <button
                type="button"
                class="rounded-lg border border-line px-3 py-1.5 text-[11.5px] text-muted hover:text-accent"
                @click="goToSettings"
              >
                去系统设置
              </button>
            </div>
          </div>
        </div>
      </div>

      <p v-if="servers.servers.length === 0" class="py-6 text-center text-[12px] text-muted">
        还没有保存的服务器，先在下方添加一个。
      </p>

      <div v-else class="space-y-1.5">
        <button
          v-for="server in servers.servers"
          :key="server.id"
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60"
          :class="
            server.id === servers.currentId
              ? 'border-accent/45 bg-accent-soft/40'
              : 'border-line bg-surface-2 hover:bg-surface-3'
          "
          :disabled="switchingId !== null"
          @click="selectServer(server.id)"
        >
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :class="dotClass(status[server.id])"
            :title="dotLabel(status[server.id])"
          />
          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-1.5">
              <span class="truncate text-[13px] font-medium text-text-strong">{{ server.name }}</span>
              <span
                v-if="versions[server.id]"
                class="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] text-muted"
              >{{ versions[server.id] }}</span>
            </span>
            <span class="block truncate text-[11px] text-muted">{{ server.baseUrl }}</span>
          </span>
          <Icon
            v-if="server.id === servers.currentId"
            name="check"
            :size="14"
            class="text-accent"
          />
          <Icon v-else name="chevronRight" :size="13" class="text-muted" />
        </button>
      </div>

      <div class="mt-5 border-t border-line pt-4">
        <p class="mb-2 text-[11px] font-medium tracking-wide text-muted">添加服务器</p>
        <div class="space-y-2">
          <label class="block">
            <input
              v-model="url"
              type="text"
              placeholder="http://192.168.1.10:8787"
              class="h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
              @keydown.enter="connect"
            />
            <span v-if="normalized" class="mt-1 block text-[11px] text-muted">
              将连接 {{ normalized }}
            </span>
          </label>
          <input
            v-model="label"
            type="text"
            placeholder="服务器备注（可选）"
            class="h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
          />
          <p v-if="error" class="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{{ error }}</p>
          <button
            type="button"
            class="h-10 w-full rounded-lg bg-accent text-[13.5px] font-medium text-accent-text disabled:opacity-60"
            :disabled="adding || !url.trim()"
            @click="connect"
          >
            {{ adding ? '正在测试并添加…' : '测试并添加' }}
          </button>
        </div>
      </div>
    </section>

    <LoginForm
      v-show="!ui.isMobile || face === 'login'"
      :show-server-switch="ui.isMobile"
      class="setup-flip"
      :class="flipClass"
      @change-server="flipTo('servers')"
    />
  </div>
</template>

<style scoped>
/* 手机端选服务器 ↔ 登录的卡片翻转，姿态由 JS 相位类驱动 */
.setup-flip {
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

.setup-flip-out {
  transform: perspective(1200px) rotateY(90deg) scale(0.86);
  transition-duration: 170ms;
  transition-timing-function: ease-in;
}

.setup-flip-in {
  transform: perspective(1200px) rotateY(-90deg) scale(0.86);
  transition: none;
}
</style>
