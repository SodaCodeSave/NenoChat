<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/ui/Icon.vue'
import Button from '@/components/ui/form/Button.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Alert from '@/components/ui/form/Alert.vue'

const auth = useAuthStore()
const router = useRouter()

const username = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const notAdminHint = ref(false)

async function submit(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  notAdminHint.value = false
  submitting.value = true
  try {
    await auth.login(username.value.trim(), password.value)
    if (!auth.isAdmin) {
      // 登录成功但不是管理员：提示后立即退出登录态
      notAdminHint.value = true
      auth.dropSession()
      return
    }
    router.replace({ name: 'dashboard' })
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '登录失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="grid h-full place-items-center bg-surface-2 px-4">
    <div class="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-soft)]">
      <div class="mb-6 flex flex-col items-center gap-2">
        <div class="grid h-11 w-11 place-items-center rounded-xl bg-accent text-accent-text">
          <Icon name="shield" :size="22" />
        </div>
        <h1 class="text-[16px] font-semibold text-text-strong">NenoChat 管理面板</h1>
        <p class="text-[12px] text-muted">请使用服务器管理员账号登录</p>
      </div>

      <form class="space-y-3" @submit.prevent="submit">
        <div>
          <label class="mb-1 block text-[12px] text-muted" for="admin-username">用户名</label>
          <TextInput
            id="admin-username"
            v-model="username"
            type="text"
            placeholder="管理员用户名"
            autocomplete="username"
            auto-focus
          />
        </div>
        <div>
          <label class="mb-1 block text-[12px] text-muted" for="admin-password">密码</label>
          <TextInput
            id="admin-password"
            v-model="password"
            type="password"
            placeholder="密码"
            autocomplete="current-password"
          />
        </div>

        <Alert v-if="errorMessage" tone="danger">{{ errorMessage }}</Alert>
        <Alert v-if="notAdminHint" tone="danger">
          该账号不是服务器管理员，无法进入管理面板。
        </Alert>

        <Button type="submit" variant="primary" block :loading="submitting">登 录</Button>
      </form>

      <p class="mt-4 text-center text-[11px] leading-relaxed text-muted">
        首个注册该服务器的账号自动拥有管理员权限
      </p>
    </div>
  </div>
</template>
