<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import LoginForm from '@/components/auth/LoginForm.vue'
import { useAuthStore } from '@/stores/auth'
import { useServersStore, normalizeServerUrl } from '@/stores/servers'
import { resetWorkspace } from '@/app/bootstrap'

type ProbeState = 'checking' | 'online' | 'offline'

const auth = useAuthStore()
const servers = useServersStore()

const url = ref('http://localhost:8787')
const label = ref('')
const adding = ref(false)
const probing = ref(false)
const switchingId = ref<string | null>(null)
const error = ref<string | null>(null)
const status = ref<Record<string, ProbeState>>({})

const normalized = computed(() => {
  try {
    return normalizeServerUrl(url.value).baseUrl
  } catch {
    return ''
  }
})

/** 对所有已保存服务器并发发起 /server/info 探测，结果按服务器 id 记录 */
async function testServers(): Promise<void> {
  if (probing.value) return
  probing.value = true
  const snapshot = [...servers.servers]
  status.value = {}
  for (const server of snapshot) status.value[server.id] = 'checking'
  await Promise.all(
    snapshot.map(async (server) => {
      try {
        await servers.probe(server.baseUrl)
        status.value[server.id] = 'online'
      } catch {
        status.value[server.id] = 'offline'
      }
    }),
  )
  probing.value = false
}

function dotClass(state: ProbeState | undefined): string {
  if (state === 'online') return 'bg-success'
  if (state === 'offline') return 'bg-danger'
  return 'bg-muted/50'
}

function dotLabel(state: ProbeState | undefined): string {
  if (state === 'online') return '测试通过'
  if (state === 'offline') return '测试失败'
  return '测试中'
}

onMounted(() => {
  void testServers()
})

async function selectServer(id: string): Promise<void> {
  if (id === servers.currentId || switchingId.value) return
  switchingId.value = id
  try {
    await servers.setCurrent(id)
    resetWorkspace()
    await auth.clearSession()
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
    status.value[instance.id] = 'online'
    await servers.setCurrent(instance.id)
    resetWorkspace()
    await auth.clearSession()
    url.value = ''
    label.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '连接失败，请检查地址'
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div class="grid gap-5 lg:grid-cols-2 lg:items-stretch">
    <section class="h-full rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-soft)]">
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
            <span class="block truncate text-[13px] font-medium text-text-strong">{{ server.name }}</span>
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

    <LoginForm />
  </div>
</template>
