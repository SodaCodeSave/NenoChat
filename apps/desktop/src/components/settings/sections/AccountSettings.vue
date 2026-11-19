<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import AvatarUploader from '../AvatarUploader.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import Field from '@/components/ui/form/Field.vue'
import TextInput from '@/components/ui/form/TextInput.vue'
import Textarea from '@/components/ui/form/Textarea.vue'
import Button from '@/components/ui/form/Button.vue'
import ConfirmDialog from '@/components/ui/form/ConfirmDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'
import { userApi } from '@/api/endpoints'
import { resetWorkspace } from '@/app/bootstrap'

const router = useRouter()
const auth = useAuthStore()
/** 一体版只有内置服务端上的本机账号，没有可退出的登录态 */
const integrated = useServersStore().integrated

const displayName = ref(auth.user?.displayName ?? '')
const bio = ref(auth.user?.bio ?? '')
const avatarUrl = ref<string | null>(auth.user?.avatarUrl ?? null)

const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)
const confirmLogout = ref(false)
const loggingOut = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

const dirty = computed(
  () =>
    displayName.value !== (auth.user?.displayName ?? '') ||
    bio.value !== (auth.user?.bio ?? '') ||
    avatarUrl.value !== (auth.user?.avatarUrl ?? null),
)

async function saveProfile(): Promise<void> {
  saving.value = true
  error.value = null
  try {
    const result = await userApi.updateProfile({
      displayName: displayName.value.trim() || undefined,
      bio: bio.value.trim() || null,
      avatarUrl: avatarUrl.value,
    })
    if (auth.user) {
      auth.user.displayName = result.user.displayName
      auth.user.bio = result.user.bio
      auth.user.avatarUrl = result.user.avatarUrl
    }
    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      saved.value = false
    }, 2200)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function logout(): Promise<void> {
  loggingOut.value = true
  try {
    await auth.logout()
    resetWorkspace()
    await router.replace('/login')
  } finally {
    loggingOut.value = false
    confirmLogout.value = false
  }
}

// 「已保存」的闪现定时器随组件清掉，避免切走设置页后还回来改状态
onBeforeUnmount(() => {
  if (savedTimer) clearTimeout(savedTimer)
})
</script>

<template>
  <div class="space-y-3">
    <SettingsCard
      id="profile"
      title="个人资料"
      description="昵称、头像与签名会同步到所有登录的设备"
      icon="user"
    >
      <div class="mb-4">
        <AvatarUploader
          :src="avatarUrl"
          :name="displayName || auth.user?.username"
          hint="点击头像更换，支持 PNG / JPG / WEBP，不超过 10MB"
          @uploaded="avatarUrl = $event"
        />
      </div>

      <div class="space-y-3">
        <Field label="昵称" for-id="account-display-name">
          <TextInput
            id="account-display-name"
            v-model="displayName"
            placeholder="展示给别人看的名字"
            maxlength="32"
          />
        </Field>

        <Field label="个性签名" for-id="account-bio" optional>
          <Textarea
            id="account-bio"
            v-model="bio"
            :rows="2"
            :resize="false"
            maxlength="120"
            placeholder="一句话介绍自己，会显示在资料卡上"
          />
        </Field>
      </div>

      <p v-if="error" class="mt-3 text-[11.5px] text-danger">{{ error }}</p>

      <div class="mt-4 flex items-center gap-2.5">
        <Button variant="primary" :loading="saving" :disabled="!dirty" @click="saveProfile">
          {{ saving ? '保存中…' : '保存资料' }}
        </Button>
        <span v-if="saved && !dirty" class="text-[11.5px] text-success">已保存</span>
        <span v-else-if="dirty" class="text-[11.5px] text-muted">有未保存的修改</span>
      </div>
    </SettingsCard>

    <SettingsCard id="account-info" title="账号信息" icon="at">
      <SettingRow label="用户名" description="登录用账号，暂不支持修改">
        <span class="text-[12.5px] text-text">@{{ auth.user?.username ?? '-' }}</span>
      </SettingRow>
      <SettingRow label="用户 ID" description="问题排查时提供给管理员">
        <span class="max-w-[220px] truncate font-mono text-[11.5px] text-muted">
          {{ auth.user?.id ?? '-' }}
        </span>
      </SettingRow>
    </SettingsCard>

    <SettingsCard v-if="!integrated" id="danger" title="危险操作" icon="logout" tone="danger">
      <div class="flex items-center justify-between gap-3">
        <p class="min-w-0 text-[12px] text-muted">退出后需要重新登录，本地数据不会被删除</p>
        <Button variant="danger-ghost" size="sm" icon="logout" @click="confirmLogout = true">
          退出登录
        </Button>
      </div>

      <ConfirmDialog
        v-model:open="confirmLogout"
        title="确认退出登录？"
        description="退出后这台设备需要重新登录，聊天记录仍保留在本机。"
        confirm-text="退出登录"
        :loading="loggingOut"
        @confirm="logout"
      />
    </SettingsCard>
  </div>
</template>
