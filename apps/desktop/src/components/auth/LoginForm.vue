<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/ui/Icon.vue'
import Avatar from '@/components/ui/Avatar.vue'
import { readLastUser, useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useServersStore } from '@/stores/servers'
import { useSyncStore } from '@/stores/sync'

const props = withDefaults(defineProps<{ showServerSwitch?: boolean }>(), {
  showServerSwitch: false,
})
const emit = defineEmits<{ changeServer: [] }>()

const router = useRouter()
const auth = useAuthStore()
const servers = useServersStore()
const conversations = useConversationsStore()
const sync = useSyncStore()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const displayName = ref('')
const inviteCode = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const retrying = ref(false)
const lastUser = ref(readLastUser(servers.currentId))

const hasServer = computed(() => servers.current !== null)

const restoreHint = computed(() => {
  if (auth.isAuthenticated) return null
  if (auth.restoreFailure === 'auth') return '登录状态已失效，请重新登录'
  return auth.restoreError
})

const canRetryRestore = computed(
  () => auth.hasStoredCredential && !auth.isAuthenticated && auth.restoreFailure !== 'auth',
)

const inviteRequired = computed(() => servers.serverInfo?.registration.inviteRequired ?? false)
const registrationOpen = computed(() => servers.serverInfo?.registration.open ?? true)

/** 服务器切换后同步绑定地址、重置表单与上次登录用户 */
function syncServer(): void {
  auth.bindServer()
  lastUser.value = readLastUser(servers.currentId)
  username.value = lastUser.value?.username ?? ''
  password.value = ''
  mode.value = 'login'
  error.value = null
  void servers.refreshInfo()
}

onMounted(() => {
  if (hasServer.value) syncServer()
})

watch(() => servers.currentId, () => {
  if (hasServer.value) syncServer()
})

/** 断网导致自动登录失败时，凭证仍保留，可直接重试而不必重新输入密码 */
async function retryAutoLogin(): Promise<void> {
  if (retrying.value) return
  retrying.value = true
  try {
    if (await auth.bootstrap()) {
      await conversations.refresh().catch(() => undefined)
      void sync.connect()
      await router.replace('/')
    }
  } finally {
    retrying.value = false
  }
}

async function submit(): Promise<void> {
  if (busy.value || !hasServer.value) return
  busy.value = true
  error.value = null
  try {
    if (mode.value === 'login') {
      await auth.login(username.value.trim(), password.value)
    } else {
      await auth.register({
        username: username.value.trim(),
        password: password.value,
        displayName: displayName.value.trim() || username.value.trim(),
        inviteCode: inviteCode.value.trim() || undefined,
      })
    }

    await conversations.refresh()
    void sync.connect()
    await router.replace('/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败'
  } finally {
    busy.value = false
  }
}

function switchMode(next: 'login' | 'register'): void {
  mode.value = next
  error.value = null
}
</script>

<template>
  <div class="h-full rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-soft)]">
    <div class="mb-5 flex items-start justify-between">
      <div>
        <h1 class="text-[17px] font-semibold text-text-strong">
          {{ mode === 'login' ? '登录 NenoChat' : '创建账号' }}
        </h1>
        <button
          v-if="props.showServerSwitch"
          type="button"
          class="mt-0.5 flex items-center gap-1 text-[11.5px] text-muted hover:text-accent"
          @click="emit('changeServer')"
        >
          <Icon name="server" :size="11" />
          {{ servers.current?.name ?? '未选择服务器' }} · 切换
        </button>
        <p v-else class="mt-0.5 text-[11.5px] text-muted">
          {{ servers.current?.name ?? '未选择服务器' }}
        </p>
      </div>
      <span class="grid h-9 w-9 place-items-center rounded-xl bg-accent text-accent-text">
        <Icon name="message" :size="18" />
      </span>
    </div>

    <div
      v-if="!hasServer"
      class="rounded-xl border border-dashed border-line bg-surface-2 px-3 py-10 text-center text-[12px] text-muted"
    >
      请先选择或添加一个服务器
    </div>

    <template v-else>
      <div
        v-if="restoreHint"
        class="mb-3 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted"
      >
        <p class="text-text-strong">{{ restoreHint }}</p>
        <button
          v-if="canRetryRestore"
          type="button"
          class="mt-1 font-medium text-accent disabled:opacity-60"
          :disabled="retrying"
          @click="retryAutoLogin"
        >
          {{ retrying ? '正在重试…' : '重试自动登录' }}
        </button>
      </div>

      <div v-if="lastUser" class="mb-3 flex items-center gap-2.5 rounded-xl bg-surface-2 px-3 py-2">
        <Avatar :name="lastUser.displayName" :src="lastUser.avatarUrl" :seed="lastUser.id" :size="30" />
        <div class="min-w-0">
          <p class="truncate text-[12.5px] font-medium text-text-strong">{{ lastUser.displayName }}</p>
          <p class="truncate text-[11px] text-muted">上次登录 · @{{ lastUser.username }}</p>
        </div>
      </div>

      <div class="mb-4 flex gap-1 rounded-xl bg-surface-2 p-1">
        <button
          type="button"
          class="flex-1 rounded-lg py-1.5 text-[13px] transition-colors"
          :class="mode === 'login' ? 'bg-surface font-medium shadow-sm' : 'text-muted'"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="flex-1 rounded-lg py-1.5 text-[13px] transition-colors"
          :class="mode === 'register' ? 'bg-surface font-medium shadow-sm' : 'text-muted'"
          :disabled="!registrationOpen"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>

      <form class="space-y-3" @submit.prevent="submit">
        <label class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">用户名</span>
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            placeholder="3-24 位字母、数字或下划线"
            class="h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
          />
        </label>

        <label v-if="mode === 'register'" class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">昵称</span>
          <input
            v-model="displayName"
            type="text"
            placeholder="显示给好友的名字"
            class="h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
          />
        </label>

        <label class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">密码</span>
          <input
            v-model="password"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="至少 8 位"
            class="h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
          />
        </label>

        <label v-if="mode === 'register' && inviteRequired" class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">邀请码</span>
          <input
            v-model="inviteCode"
            type="text"
            placeholder="本服务器需要邀请码"
            class="h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent"
          />
        </label>

        <p v-if="error" class="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{{ error }}</p>

        <button
          type="submit"
          class="h-10 w-full rounded-lg bg-accent text-[13.5px] font-medium text-accent-text disabled:opacity-60"
          :disabled="busy"
        >
          {{ busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录' }}
        </button>
      </form>
    </template>

    <p class="mt-4 text-center text-[11px] text-muted">
      凭据保存在本机钥匙串，不经过任何第三方
    </p>
  </div>
</template>
