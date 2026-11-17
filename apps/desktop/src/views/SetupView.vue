<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/ui/Icon.vue'
import { useServersStore, normalizeServerUrl } from '@/stores/servers'

const router = useRouter()
const servers = useServersStore()

const url = ref('http://localhost:8787')
const label = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const probed = ref<{ name: string; version: string; mode: string } | null>(null)

const normalized = computed(() => {
  try {
    return normalizeServerUrl(url.value).baseUrl
  } catch {
    return ''
  }
})

async function connect(): Promise<void> {
  if (!url.value.trim()) return
  busy.value = true
  error.value = null
  probed.value = null
  try {
    const info = await servers.probe(url.value)
    probed.value = {
      name: info.name,
      version: info.version,
      mode: info.registration.inviteRequired ? '需要邀请码' : '开放注册',
    }
    const instance = await servers.add(url.value, label.value || info.name)
    await servers.setCurrent(instance.id)
    await router.replace('/login')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '连接失败，请检查地址'
  } finally {
    busy.value = false
  }
}

function useExisting(id: string): void {
  void servers.setCurrent(id).then(() => router.replace('/login'))
}
</script>

<template>
  <div class="rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-soft)]">
    <div class="mb-5 flex items-center gap-2">
      <span class="grid h-9 w-9 place-items-center rounded-xl bg-accent text-accent-text">
        <Icon name="server" :size="18" />
      </span>
      <div>
        <h1 class="text-[16px] font-semibold text-text-strong">连接消息服务器</h1>
        <p class="text-[12px] text-muted">填入自建服务器的地址，客户端会先探测可用性</p>
      </div>
    </div>

    <div class="space-y-3">
      <label class="block">
        <span class="mb-1 block text-[12px] font-medium text-muted">服务器地址</span>
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

      <label class="block">
        <span class="mb-1 block text-[12px] font-medium text-muted">服务器备注（可选）</span>
        <input
          v-model="label"
          type="text"
          placeholder="家里的服务器"
          class="h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
        />
      </label>

      <div v-if="probed" class="rounded-lg bg-surface-2 px-3 py-2 text-[12px]">
        <p class="text-text-strong">{{ probed.name }}</p>
        <p class="text-muted">版本 {{ probed.version }} · {{ probed.mode }}</p>
      </div>

      <p v-if="error" class="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{{ error }}</p>

      <button
        type="button"
        class="h-10 w-full rounded-lg bg-accent text-[13.5px] font-medium text-accent-text disabled:opacity-60"
        :disabled="busy"
        @click="connect"
      >
        {{ busy ? '正在连接…' : '连接并继续' }}
      </button>
    </div>

    <div v-if="servers.servers.length > 0" class="mt-5 border-t border-line pt-4">
      <p class="mb-2 text-[11px] font-medium tracking-wide text-muted">已保存的服务器</p>
      <button
        v-for="server in servers.servers"
        :key="server.id"
        type="button"
        class="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
        @click="useExisting(server.id)"
      >
        <Icon name="server" :size="14" class="text-muted" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[13px] text-text">{{ server.name }}</span>
          <span class="block truncate text-[11px] text-muted">{{ server.baseUrl }}</span>
        </span>
        <Icon name="chevronRight" :size="13" class="text-muted" />
      </button>
    </div>
  </div>
</template>
