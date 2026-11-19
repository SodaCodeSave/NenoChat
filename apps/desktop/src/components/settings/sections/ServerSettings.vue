<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Button from '@/components/ui/form/Button.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import Icon from '@/components/ui/Icon.vue'
import { useServersStore } from '@/stores/servers'
import { useAuthStore } from '@/stores/auth'
import { resetWorkspace } from '@/app/bootstrap'
import { LocalNetworkPermissionError, openLocalNetworkSettings } from '@/platform/local-network'

const router = useRouter()
const servers = useServersStore()
const auth = useAuthStore()

const newServerUrl = ref('')
const adding = ref(false)
const error = ref<string | null>(null)
/** 报错是否由缺失本地网络权限引起：这种要引导去系统设置，而不是改地址 */
const permissionBlocked = ref(false)
const pendingSwitch = ref<string | null>(null)
const pendingRemove = ref<string | null>(null)
const switching = ref(false)
const removing = ref(false)

onMounted(() => {
  void servers.refreshInfo()
})

function serverById(id: string | null) {
  return servers.servers.find((server) => server.id === id) ?? null
}

async function addServer(): Promise<void> {
  if (!newServerUrl.value.trim() || adding.value) return
  adding.value = true
  error.value = null
  permissionBlocked.value = false
  try {
    const instance = await servers.add(newServerUrl.value)
    newServerUrl.value = ''
    await servers.setCurrent(instance.id)
    resetWorkspace()
    await auth.clearSession()
    await router.replace('/login')
  } catch (e) {
    permissionBlocked.value = e instanceof LocalNetworkPermissionError
    error.value = e instanceof Error ? e.message : '无法连接服务器'
  } finally {
    adding.value = false
  }
}

async function switchServer(): Promise<void> {
  const id = pendingSwitch.value
  if (!id || id === servers.currentId) return
  switching.value = true
  try {
    await servers.setCurrent(id)
    resetWorkspace()
    await auth.clearSession()
    await router.replace('/login')
  } finally {
    switching.value = false
    pendingSwitch.value = null
  }
}

async function removeServer(): Promise<void> {
  const id = pendingRemove.value
  if (!id) return
  removing.value = true
  try {
    await servers.remove(id)
    if (servers.currentId === id || !servers.currentId) {
      resetWorkspace()
      await auth.clearSession()
      await router.replace('/setup')
    }
  } finally {
    removing.value = false
    pendingRemove.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <SettingsCard
      id="current"
      title="已连接的服务器"
      description="切换服务器会重新登录，本地数据按服务器隔离存储"
      icon="server"
    >
      <p v-if="servers.servers.length === 0" class="py-2 text-[12px] text-muted">
        还没有保存的服务器。
      </p>

      <div v-else class="space-y-2">
        <div
          v-for="server in servers.servers"
          :key="server.id"
          class="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors"
          :class="
            server.id === servers.currentId
              ? 'border-accent/45 bg-accent-soft/40'
              : 'border-line bg-surface-2'
          "
        >
          <span
            class="grid h-7 w-7 shrink-0 place-items-center rounded-md"
            :class="server.id === servers.currentId ? 'bg-accent/12 text-accent' : 'bg-surface-3 text-muted'"
          >
            <Icon name="server" :size="14" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[12.5px] font-medium text-text-strong">
              {{ server.name }}
            </p>
            <p class="truncate text-[11px] text-muted">{{ server.baseUrl }}</p>
          </div>
          <span
            v-if="server.id === servers.currentId"
            class="shrink-0 rounded-full bg-accent/12 px-2 py-0.5 text-[10.5px] font-medium text-accent"
          >
            当前
          </span>
          <Button
            v-else
            variant="secondary"
            size="sm"
            @click="pendingSwitch = server.id"
          >
            切换
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            :title="server.id === servers.currentId ? '移除当前服务器' : '移除服务器'"
            aria-label="移除服务器"
            @click="pendingRemove = server.id"
          />
        </div>
      </div>

      <div v-if="servers.serverInfo" class="mt-3 rounded-lg bg-surface-2 px-3 py-2">
        <p class="text-[11.5px] text-muted">
          {{ servers.serverInfo.name }} · 服务端版本 {{ servers.serverInfo.version }} · 注册
          {{ servers.serverInfo.registration.open ? '开放' : '关闭' }}
        </p>
      </div>
    </SettingsCard>

    <SettingsCard
      id="add"
      title="添加服务器"
      description="填写自建服务端的地址，例如 http://192.168.1.10:8787"
      icon="plus"
    >
      <form class="flex items-start gap-2" @submit.prevent="addServer">
        <TextInput
          v-model="newServerUrl"
          class="flex-1"
          placeholder="http://192.168.1.10:8787"
          :invalid="Boolean(error)"
          autocomplete="off"
          spellcheck="false"
        />
        <Button
          type="submit"
          variant="primary"
          :loading="adding"
          :disabled="!newServerUrl.trim()"
        >
          添加并连接
        </Button>
      </form>
      <p v-if="error" class="mt-2 text-[11.5px] text-danger">{{ error }}</p>
      <button
        v-if="permissionBlocked"
        type="button"
        class="mt-1.5 text-[11.5px] text-accent underline underline-offset-2"
        @click="openLocalNetworkSettings"
      >
        去系统设置允许「附近的设备」
      </button>
      <p v-else-if="!error" class="mt-2 text-[11.5px] text-muted">
        添加后会切换到这台服务器并需要重新登录。
      </p>
    </SettingsCard>

    <ConfirmDialog
      :open="Boolean(pendingSwitch)"
      title="切换服务器？"
      :description="`将切换到「${serverById(pendingSwitch)?.name ?? ''}」，当前登录会失效，需要重新登录。`"
      confirm-text="切换"
      tone="primary"
      :loading="switching"
      @update:open="(value) => !value && (pendingSwitch = null)"
      @confirm="switchServer"
    />

    <ConfirmDialog
      :open="Boolean(pendingRemove)"
      title="移除服务器？"
      :description="`将删除「${serverById(pendingRemove)?.name ?? ''}」在本机的连接信息与本地镜像数据，服务端数据不受影响。`"
      confirm-text="移除"
      :loading="removing"
      @update:open="(value) => !value && (pendingRemove = null)"
      @confirm="removeServer"
    />
  </div>
</template>
