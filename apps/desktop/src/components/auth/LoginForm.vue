<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import BrandLogo from '@/components/layout/BrandLogo.vue'
import { readLastUser, useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useServersStore } from '@/stores/servers'
import { useSyncStore } from '@/stores/sync'

const router = useRouter()
const auth = useAuthStore()
const servers = useServersStore()
const conversations = useConversationsStore()
const sync = useSyncStore()

const mode = ref<'login' | 'register' | 'pair'>('login')
const username = ref('')
const password = ref('')
const pairCode = ref('')
const displayName = ref('')
const inviteCode = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const retrying = ref(false)

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

/** 服务器切换后同步绑定地址、重置表单并预填之前使用的用户名 */
function syncServer(): void {
  auth.bindServer()
  username.value = readLastUser(servers.currentId)?.username ?? ''
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
    if (mode.value === 'pair') {
      // 电脑端生成的配对码，扫码打不开时手输也能接入
      await auth.pairWithCode(pairCode.value.trim().toUpperCase())
    } else if (mode.value === 'login') {
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

function switchMode(next: 'login' | 'register' | 'pair'): void {
  mode.value = next
  error.value = null
}

const submitLabel = computed(() =>
  busy.value ? '请稍候…' : mode.value === 'login' ? '登录' : mode.value === 'register' ? '注册并登录' : '接入',
)
</script>

<template>
  <div class="flex w-full flex-col items-center">
    <BrandLogo class="h-8 text-text-strong" />

    <p class="mt-2.5 text-[11.5px] text-muted">
      {{ servers.current ? `正在登录「${servers.current.name}」服务器` : '未选择服务器' }}
    </p>

    <div
      v-if="!hasServer"
      class="mt-8 w-full rounded-xl border border-dashed border-line bg-surface-2 px-3 py-10 text-center text-[12px] text-muted"
    >
      请先选择或添加一个服务器
    </div>

    <template v-else>
      <div v-if="restoreHint" class="mt-6 w-full text-center">
        <p class="text-[12px] text-muted">{{ restoreHint }}</p>
        <button
          v-if="canRetryRestore"
          type="button"
          class="mt-1.5 text-[12.5px] font-medium text-accent disabled:opacity-60"
          :disabled="retrying"
          @click="retryAutoLogin"
        >
          {{ retrying ? '正在重试…' : '重试自动登录' }}
        </button>
      </div>

      <div class="mt-6 flex w-full gap-1 rounded-xl bg-surface-2 p-0.5">
        <button
          type="button"
          class="flex-1 rounded-lg py-1 text-[12.5px] transition-colors"
          :class="mode === 'login' ? 'bg-surface font-medium shadow-sm' : 'text-muted'"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="flex-1 rounded-lg py-1 text-[12.5px] transition-colors"
          :class="mode === 'register' ? 'bg-surface font-medium shadow-sm' : 'text-muted'"
          :disabled="!registrationOpen"
          @click="switchMode('register')"
        >
          注册
        </button>
        <button
          type="button"
          class="flex-1 rounded-lg py-1 text-[12.5px] transition-colors"
          :class="mode === 'pair' ? 'bg-surface font-medium shadow-sm' : 'text-muted'"
          @click="switchMode('pair')"
        >
          配对码
        </button>
      </div>

      <form class="mt-5 w-full space-y-3" @submit.prevent="submit">
        <label v-if="mode !== 'pair'" class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">用户名</span>
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            placeholder="3-24 位字母、数字或下划线"
            class="field-shell h-10 w-full rounded-lg px-3 text-[13.5px] outline-none"
          />
        </label>

        <label v-if="mode === 'pair'" class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">配对码</span>
          <input
            v-model="pairCode"
            type="text"
            placeholder="电脑端「手机接入」里显示的 6 位配对码"
            maxlength="16"
            class="field-shell h-10 w-full rounded-lg px-3 font-mono text-[13.5px] tracking-[0.18em] uppercase outline-none"
          />
        </label>

        <label v-if="mode === 'register'" class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">昵称</span>
          <input
            v-model="displayName"
            type="text"
            placeholder="显示给好友的名字"
            class="field-shell h-10 w-full rounded-lg px-3 text-[13.5px] outline-none"
          />
        </label>

        <label v-if="mode !== 'pair'" class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">密码</span>
          <input
            v-model="password"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="至少 8 位"
            class="field-shell h-10 w-full rounded-lg px-3 text-[13.5px] outline-none"
          />
        </label>

        <label v-if="mode === 'register' && inviteRequired" class="block">
          <span class="mb-1 block text-[12px] font-medium text-muted">邀请码</span>
          <input
            v-model="inviteCode"
            type="text"
            placeholder="本服务器需要邀请码"
            class="field-shell h-10 w-full rounded-lg px-3 text-[13.5px] outline-none"
          />
        </label>

        <p v-if="error" class="rounded-lg bg-danger/10 px-3 py-2 text-center text-[12px] text-danger">{{ error }}</p>

        <button
          type="submit"
          class="h-10 w-full rounded-lg bg-accent text-[13.5px] font-medium text-accent-text disabled:opacity-60"
          :disabled="busy"
        >
          {{ submitLabel }}
        </button>
      </form>
    </template>

    <button
      type="button"
      class="mt-5 text-[11.5px] text-muted transition-colors hover:text-accent"
      @click="router.replace('/setup')"
    >
      更换服务器
    </button>
  </div>
</template>
