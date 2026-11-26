<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NotificationLevel, NotificationSettings } from '@nenochat/shared'
import Alert from '@/components/ui/form/Alert.vue'
import Button from '@/components/ui/form/Button.vue'
import Segmented from '@/components/ui/form/Segmented.vue'
import SettingRow from '@/components/ui/form/SettingRow.vue'
import SettingsCard from '@/components/ui/form/SettingsCard.vue'
import Switch from '@/components/ui/form/Switch.vue'
import { useAuthStore } from '@/stores/auth'
import { useSystemNotificationsStore } from '@/stores/system-notifications'

const auth = useAuthStore()
const notifications = useSystemNotificationsStore()

const form = ref<NotificationSettings | null>(null)
const error = ref<string | null>(null)
const savedHint = ref(false)
const testHint = ref('')

const canRequestPermission = computed(
  () => notifications.permission !== 'granted' && notifications.permission !== 'unsupported',
)

const levelOptions = [
  { value: 'all', label: '全部消息' },
  { value: 'mentions', label: '仅 @ 提及' },
  { value: 'none', label: '不接收' },
]

const permissionLabel = computed(() => {
  switch (notifications.permission) {
    case 'granted':
      return '已获得系统通知权限'
    case 'denied':
      return '系统通知权限被拒绝，请在系统设置中允许'
    case 'unsupported':
      return '当前环境不支持系统通知，请使用桌面客户端'
    default:
      return '尚未授权系统通知'
  }
})

watch(
  () => auth.notificationSettings,
  (value) => {
    if (value) form.value = { ...value }
  },
  { immediate: true, deep: true },
)

onMounted(async () => {
  if (!auth.notificationSettings) {
    try {
      await auth.loadProfile()
    } catch {
      /* 离线时保持空态 */
    }
  }
  await notifications.refreshPermission()
})

let savedTimer = 0
let testTimer = 0

function flashSaved(): void {
  savedHint.value = true
  window.clearTimeout(savedTimer)
  savedTimer = window.setTimeout(() => {
    savedHint.value = false
  }, 2000)
}

async function patch(partial: Partial<NotificationSettings>): Promise<void> {
  if (!form.value) return
  const previous = { ...form.value }
  form.value = { ...form.value, ...partial }
  error.value = null
  try {
    const next = await auth.updateNotificationSettings(partial)
    form.value = { ...next }
    flashSaved()
  } catch (e) {
    form.value = previous
    error.value = e instanceof Error ? e.message : '保存失败'
  }
}

async function enableSystemNotification(): Promise<void> {
  const result = await notifications.requestPermission()
  if (result === 'granted') await patch({ desktopEnabled: true })
}

async function sendTestNotification(): Promise<void> {
  const delivered = await notifications.sendTest()
  testHint.value = delivered ? '已发送，请查看系统通知' : '发送失败，请检查系统通知权限'
  window.clearTimeout(testTimer)
  testTimer = window.setTimeout(() => {
    testHint.value = ''
  }, 3000)
}

function toggle(key: 'desktopEnabled' | 'soundEnabled' | 'showPreview' | 'dndEnabled', value: boolean): void {
  void patch({ [key]: value } as Partial<NotificationSettings>)
}

function setLevel(key: 'dmLevel' | 'groupLevel', value: NotificationLevel): void {
  void patch({ [key]: value } as Partial<NotificationSettings>)
}

// 提示语定时器随组件清掉，避免切走设置页后还回来改状态
onBeforeUnmount(() => {
  window.clearTimeout(savedTimer)
  window.clearTimeout(testTimer)
})
</script>

<template>
  <div class="space-y-3">
    <Alert v-if="error" tone="danger">{{ error }}</Alert>
    <Alert v-else-if="savedHint" tone="success">已保存</Alert>

    <template v-if="form">
      <!-- 系统权限 -->
      <SettingsCard id="system" title="系统通知" :description="permissionLabel" icon="bell">
        <template #actions>
          <Button v-if="canRequestPermission" size="sm" @click="enableSystemNotification">
            去授权
          </Button>
        </template>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" @click="sendTestNotification">发送测试通知</Button>
          <span v-if="testHint" class="text-[11.5px] text-muted">{{ testHint }}</span>
        </div>
      </SettingsCard>

      <!-- 总开关 -->
      <SettingsCard
        id="alerts"
        title="提醒方式"
        description="设置会同步到所有登录的设备，免打扰离线也生效"
        icon="volume"
      >
        <SettingRow label="桌面通知" description="新消息、@ 提及与 AI 消息到达时提醒" for-id="notify-desktop">
          <Switch
            id="notify-desktop"
            :model-value="form.desktopEnabled"
            aria-label="桌面通知"
            @update:model-value="toggle('desktopEnabled', $event)"
          />
        </SettingRow>

        <SettingRow label="提示音" description="浏览器降级提示时播放短提示音" for-id="notify-sound">
          <Switch
            id="notify-sound"
            :model-value="form.soundEnabled"
            aria-label="提示音"
            @update:model-value="toggle('soundEnabled', $event)"
          />
        </SettingRow>

        <SettingRow
          label="显示内容预览"
          description="关闭后通知只显示「你收到一条新消息」"
          for-id="notify-preview"
        >
          <Switch
            id="notify-preview"
            :model-value="form.showPreview"
            aria-label="显示内容预览"
            @update:model-value="toggle('showPreview', $event)"
          />
        </SettingRow>
      </SettingsCard>

      <!-- 默认级别 -->
      <SettingsCard id="levels" title="默认提醒级别" description="单个会话可以在会话设置里单独覆盖" icon="at">
        <SettingRow label="私聊与 AI" stacked>
          <Segmented
            :model-value="form.dmLevel"
            full
            :options="levelOptions"
            aria-label="私聊与 AI 提醒级别"
            @update:model-value="setLevel('dmLevel', $event as NotificationLevel)"
          />
        </SettingRow>

        <SettingRow label="群聊" stacked>
          <Segmented
            :model-value="form.groupLevel"
            full
            :options="levelOptions"
            aria-label="群聊提醒级别"
            @update:model-value="setLevel('groupLevel', $event as NotificationLevel)"
          />
        </SettingRow>
      </SettingsCard>

      <!-- 免打扰 -->
      <SettingsCard id="dnd" title="免打扰" icon="moon">
        <SettingRow
          label="免打扰时段"
          description="时段内不弹系统通知，消息仍会在主页正常显示"
          for-id="notify-dnd"
        >
          <Switch
            id="notify-dnd"
            :model-value="form.dndEnabled"
            aria-label="免打扰时段"
            @update:model-value="toggle('dndEnabled', $event)"
          />
        </SettingRow>

        <div v-if="form.dndEnabled" class="flex items-center gap-2 pb-3.5">
          <input
            type="time"
            :value="form.dndStart"
            class="field-shell h-9 flex-1 rounded-lg px-2.5 text-[13px] outline-none"
            @change="patch({ dndStart: ($event.target as HTMLInputElement).value })"
          />
          <span class="text-[12px] text-muted">至</span>
          <input
            type="time"
            :value="form.dndEnd"
            class="field-shell h-9 flex-1 rounded-lg px-2.5 text-[13px] outline-none"
            @change="patch({ dndEnd: ($event.target as HTMLInputElement).value })"
          />
        </div>

        <p class="pb-3.5 text-[11px] text-muted">时区：{{ form.timezone }}</p>
      </SettingsCard>
    </template>

    <p v-else class="py-2 text-[12px] text-muted">正在读取通知设置…</p>
  </div>
</template>
