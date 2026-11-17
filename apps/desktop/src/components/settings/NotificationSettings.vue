<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NotificationLevel, NotificationSettings } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { useSystemNotificationsStore } from '@/stores/system-notifications'

const auth = useAuthStore()
const notifications = useSystemNotificationsStore()

const form = ref<NotificationSettings | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)
const savedHint = ref(false)
const testHint = ref('')

const levels: Array<{ key: NotificationLevel; label: string }> = [
  { key: 'all', label: '全部消息' },
  { key: 'mentions', label: '仅 @ 提及' },
  { key: 'none', label: '不接收' },
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
  saving.value = true
  error.value = null
  try {
    const next = await auth.updateNotificationSettings(partial)
    form.value = { ...next }
    flashSaved()
  } catch (e) {
    form.value = previous
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
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
  <div>
    <h2 class="mb-1 text-[15px] font-semibold text-text-strong">通知</h2>
    <p class="mb-4 text-[12px] text-muted">设置会同步到所有登录的设备，免打扰离线也生效</p>

    <p v-if="error" class="mb-3 text-[12px] text-danger">{{ error }}</p>
    <p v-else-if="savedHint" class="mb-3 text-[12px] text-accent">已保存</p>

    <template v-if="form">
      <!-- 系统权限 -->
      <section class="mb-4 rounded-xl border border-line bg-surface p-4">
        <div class="flex items-start gap-2.5">
          <span class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
            <Icon :name="notifications.permission === 'granted' ? 'bell' : 'bellOff'" :size="15" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium text-text-strong">系统通知</p>
            <p class="mt-0.5 text-[11.5px] leading-relaxed text-muted">{{ permissionLabel }}</p>
          </div>
          <button
            v-if="notifications.permission !== 'granted' && notifications.permission !== 'unsupported'"
            type="button"
            class="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-text"
            @click="enableSystemNotification"
          >
            去授权
          </button>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="rounded-lg border border-line px-2.5 py-1 text-[12px] text-text hover:bg-surface-2"
            @click="sendTestNotification"
          >
            发送测试通知
          </button>
          <span v-if="testHint" class="text-[11px] text-muted">{{ testHint }}</span>
        </div>
      </section>

      <!-- 总开关 -->
      <section class="mb-4 overflow-hidden rounded-xl border border-line bg-surface">
        <label class="flex items-center justify-between border-b border-line px-4 py-3">
          <span>
            <span class="block text-[13px] text-text">桌面通知</span>
            <span class="mt-0.5 block text-[11px] text-muted">新消息、@ 提及与 AI 消息到达时提醒</span>
          </span>
          <input
            type="checkbox"
            class="h-4 w-4 accent-[var(--accent)]"
            :checked="form.desktopEnabled"
            @change="toggle('desktopEnabled', ($event.target as HTMLInputElement).checked)"
          />
        </label>

        <label class="flex items-center justify-between border-b border-line px-4 py-3">
          <span>
            <span class="block text-[13px] text-text">提示音</span>
            <span class="mt-0.5 block text-[11px] text-muted">浏览器降级提示时播放短提示音</span>
          </span>
          <input
            type="checkbox"
            class="h-4 w-4 accent-[var(--accent)]"
            :checked="form.soundEnabled"
            @change="toggle('soundEnabled', ($event.target as HTMLInputElement).checked)"
          />
        </label>

        <label class="flex items-center justify-between px-4 py-3">
          <span>
            <span class="block text-[13px] text-text">显示内容预览</span>
            <span class="mt-0.5 block text-[11px] text-muted">关闭后通知只显示「你收到一条新消息」</span>
          </span>
          <input
            type="checkbox"
            class="h-4 w-4 accent-[var(--accent)]"
            :checked="form.showPreview"
            @change="toggle('showPreview', ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </section>

      <!-- 默认级别 -->
      <section class="mb-4 rounded-xl border border-line bg-surface p-4">
        <p class="mb-1 text-[13px] font-medium text-text-strong">默认提醒级别</p>
        <p class="mb-3 text-[11.5px] text-muted">单个会话可以单独覆盖这里的设置</p>

        <p class="mb-1.5 text-[12px] text-muted">私聊与 AI</p>
        <div class="mb-3 flex gap-1.5">
          <button
            v-for="level in levels"
            :key="`dm-${level.key}`"
            type="button"
            class="flex-1 rounded-lg border px-2 py-1.5 text-[12px] transition-colors"
            :class="
              form.dmLevel === level.key
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-line bg-surface-2 text-muted hover:text-text'
            "
            @click="setLevel('dmLevel', level.key)"
          >
            {{ level.label }}
          </button>
        </div>

        <p class="mb-1.5 text-[12px] text-muted">群聊</p>
        <div class="flex gap-1.5">
          <button
            v-for="level in levels"
            :key="`group-${level.key}`"
            type="button"
            class="flex-1 rounded-lg border px-2 py-1.5 text-[12px] transition-colors"
            :class="
              form.groupLevel === level.key
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-line bg-surface-2 text-muted hover:text-text'
            "
            @click="setLevel('groupLevel', level.key)"
          >
            {{ level.label }}
          </button>
        </div>
      </section>

      <!-- 免打扰 -->
      <section class="rounded-xl border border-line bg-surface p-4">
        <label class="flex items-center justify-between">
          <span>
            <span class="block text-[13px] text-text">免打扰时段</span>
            <span class="mt-0.5 block text-[11px] text-muted">
              时段内不弹系统通知，消息仍会在主页正常显示
            </span>
          </span>
          <input
            type="checkbox"
            class="h-4 w-4 accent-[var(--accent)]"
            :checked="form.dndEnabled"
            @change="toggle('dndEnabled', ($event.target as HTMLInputElement).checked)"
          />
        </label>

        <div v-if="form.dndEnabled" class="mt-3 flex items-center gap-2">
          <input
            type="time"
            :value="form.dndStart"
            class="h-9 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] outline-none focus:border-accent"
            @change="patch({ dndStart: ($event.target as HTMLInputElement).value })"
          />
          <span class="text-[12px] text-muted">至</span>
          <input
            type="time"
            :value="form.dndEnd"
            class="h-9 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] outline-none focus:border-accent"
            @change="patch({ dndEnd: ($event.target as HTMLInputElement).value })"
          />
        </div>

        <p class="mt-2 text-[11px] text-muted">时区：{{ form.timezone }}</p>
      </section>

      <p v-if="saving" class="mt-3 text-[11.5px] text-muted">保存中…</p>
    </template>

    <div v-else class="rounded-xl border border-dashed border-line p-4 text-[12.5px] text-muted">
      正在读取通知设置…
    </div>
  </div>
</template>
