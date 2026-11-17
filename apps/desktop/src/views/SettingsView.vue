<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ThemeMode } from '@nenochat/shared'
import Icon from '@/components/ui/Icon.vue'
import Avatar from '@/components/ui/Avatar.vue'
import AiSettings from '@/components/settings/AiSettings.vue'
import StickerSettings from '@/components/settings/StickerSettings.vue'
import NotificationSettings from '@/components/settings/NotificationSettings.vue'
import AvatarUploader from '@/components/settings/AvatarUploader.vue'
import { normalizeServerUrl, useServersStore } from '@/stores/servers'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { userApi } from '@/api/endpoints'
import { resetWorkspace } from '@/app/bootstrap'

const route = useRoute()
const router = useRouter()
const servers = useServersStore()
const auth = useAuthStore()
const ui = useUiStore()

const activeSection = ref<string>('account')
const savingProfile = ref(false)
const profileError = ref<string | null>(null)
const newServerUrl = ref('')
const serverBusy = ref(false)
const serverError = ref<string | null>(null)

const displayName = ref(auth.user?.displayName ?? '')
const bio = ref(auth.user?.bio ?? '')
const avatarUrl = ref<string | null>(auth.user?.avatarUrl ?? null)

const sections = [
  { key: 'account', label: '账号', icon: 'user' as const },
  { key: 'appearance', label: '外观', icon: 'sun' as const },
  { key: 'notification', label: '通知', icon: 'bell' as const },
  { key: 'server', label: '服务器', icon: 'server' as const },
  { key: 'ai', label: 'AI 与模型', icon: 'sparkles' as const },
  { key: 'stickers', label: '表情包', icon: 'smile' as const },
  { key: 'storage', label: '存储与数据', icon: 'folder' as const },
  { key: 'about', label: '关于', icon: 'message' as const },
]

const accents = [
  { key: 'blue', label: '蓝', color: '#2f6bff' },
  { key: 'violet', label: '紫', color: '#7c5cff' },
  { key: 'green', label: '绿', color: '#16a34a' },
  { key: 'orange', label: '橙', color: '#ea7317' },
  { key: 'pink', label: '粉', color: '#db2f85' },
]

const currentSection = computed(() => activeSection.value)

watch(
  () => route.params.section,
  (value) => {
    if (typeof value === 'string' && sections.some((s) => s.key === value)) {
      activeSection.value = value
    }
  },
  { immediate: true },
)

watch(activeSection, (value) => {
  void router.replace(`/settings/${value}`)
})

onMounted(() => {
  void servers.refreshInfo()
})

async function saveProfile(): Promise<void> {
  savingProfile.value = true
  profileError.value = null
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
  } catch (e) {
    profileError.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    savingProfile.value = false
  }
}

async function logout(): Promise<void> {
  await auth.logout()
  resetWorkspace()
  await router.replace('/login')
}

async function addServer(): Promise<void> {
  if (!newServerUrl.value.trim()) return
  serverBusy.value = true
  serverError.value = null
  try {
    const instance = await servers.add(newServerUrl.value)
    newServerUrl.value = ''
    await servers.setCurrent(instance.id)
    resetWorkspace()
    await auth.clearSession()
    await router.replace('/login')
  } catch (e) {
    serverError.value = e instanceof Error ? e.message : '无法连接服务器'
  } finally {
    serverBusy.value = false
  }
}

async function switchServer(id: string): Promise<void> {
  if (id === servers.currentId) return
  await servers.setCurrent(id)
  resetWorkspace()
  await auth.clearSession()
  await router.replace('/login')
}

async function removeServer(id: string): Promise<void> {
  await servers.remove(id)
  if (servers.currentId === id || !servers.currentId) {
    resetWorkspace()
    await auth.clearSession()
    await router.replace('/setup')
  }
}
</script>

<template>
  <div class="flex h-full" :class="ui.isMobile ? 'flex-col' : ''">
    <aside v-if="!ui.isMobile" class="flex w-[220px] shrink-0 flex-col border-r border-line bg-surface-2 py-3">
      <div class="mb-2 flex items-center gap-2 px-4">
        <Avatar
          :name="auth.user?.displayName ?? '我'"
          :src="auth.user?.avatarUrl ?? null"
          :seed="auth.user?.id"
          :size="36"
        />
        <div class="min-w-0">
          <p class="truncate text-[13px] font-medium text-text-strong">
            {{ auth.user?.displayName ?? '未登录' }}
          </p>
          <p class="truncate text-[11px] text-muted">@{{ auth.user?.username ?? '-' }}</p>
        </div>
      </div>

      <nav class="px-2">
        <button
          v-for="section in sections"
          :key="section.key"
          type="button"
          class="mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors"
          :class="
            currentSection === section.key
              ? 'bg-surface font-medium text-text-strong shadow-sm'
              : 'text-muted hover:bg-surface-3 hover:text-text'
          "
          @click="activeSection = section.key"
        >
          <Icon :name="section.icon" :size="15" />
          {{ section.label }}
        </button>
      </nav>
    </aside>

    <!-- 手机端：顶部资料卡 + 横向分组导航，内容单栏铺满 -->
    <header
      v-else
      class="shrink-0 border-b border-line bg-surface px-4 pb-2 pt-[calc(0.5rem+var(--safe-top))]"
    >
      <h1 class="mb-2 text-[19px] font-semibold text-text-strong">我的</h1>
      <div class="flex items-center gap-2.5">
        <Avatar
          :name="auth.user?.displayName ?? '我'"
          :src="auth.user?.avatarUrl ?? null"
          :seed="auth.user?.id"
          :size="42"
        />
        <div class="min-w-0">
          <p class="truncate text-[14.5px] font-medium text-text-strong">
            {{ auth.user?.displayName ?? '未登录' }}
          </p>
          <p class="truncate text-[11.5px] text-muted">@{{ auth.user?.username ?? '-' }}</p>
        </div>
      </div>
      <nav class="mt-2 flex gap-1.5 overflow-x-auto pb-1">
        <button
          v-for="section in sections"
          :key="section.key"
          type="button"
          class="flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-[12.5px] transition-colors"
          :class="
            currentSection === section.key
              ? 'border-accent bg-accent-soft font-medium text-accent'
              : 'border-line bg-surface-2 text-muted active:bg-surface-3'
          "
          @click="activeSection = section.key"
        >
          <Icon :name="section.icon" :size="13" />
          {{ section.label }}
        </button>
      </nav>
    </header>

    <div class="scroll-area flex-1 px-4 py-4 md:px-6 md:py-6">
      <div class="mx-auto max-w-xl">
        <!-- 账号 -->
        <section v-if="currentSection === 'account'">
          <h2 class="mb-1 text-[15px] font-semibold text-text-strong">账号</h2>
          <p class="mb-4 text-[12px] text-muted">资料会同步到所有登录的设备</p>

          <div class="mb-4">
            <AvatarUploader
              :src="avatarUrl"
              :name="displayName || auth.user?.username"
              hint="点击更换头像，PNG / JPG / WEBP，≤10MB"
              @uploaded="avatarUrl = $event"
            />
          </div>

          <label class="mb-3 block">
            <span class="mb-1 block text-[12px] font-medium text-muted">昵称</span>
            <input
              v-model="displayName"
              type="text"
              class="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-[13px] outline-none focus:border-accent"
            />
          </label>

          <label class="mb-3 block">
            <span class="mb-1 block text-[12px] font-medium text-muted">个性签名</span>
            <textarea
              v-model="bio"
              rows="2"
              class="w-full resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-accent"
            />
          </label>

          <p v-if="profileError" class="mb-2 text-[12px] text-danger">{{ profileError }}</p>

          <button
            type="button"
            class="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-text disabled:opacity-60"
            :disabled="savingProfile"
            @click="saveProfile"
          >
            {{ savingProfile ? '保存中…' : '保存资料' }}
          </button>

          <div class="mt-6 rounded-xl border border-line bg-surface p-4">
            <p class="text-[12.5px] text-text-strong">当前服务器</p>
            <p class="mt-0.5 text-[11.5px] text-muted">
              {{ servers.current?.name ?? '未连接' }} · {{ servers.current?.baseUrl ?? '-' }}
            </p>
            <p class="mt-0.5 text-[11.5px] text-muted">
              {{ servers.serverInfo ? `服务端版本 ${servers.serverInfo.version}` : '未获取到服务器信息' }}
            </p>
          </div>

          <button
            type="button"
            class="mt-6 flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 text-[13px] text-danger hover:bg-danger/10"
            @click="logout"
          >
            <Icon name="logout" :size="14" />
            退出登录
          </button>
        </section>

        <!-- 外观 -->
        <section v-else-if="currentSection === 'appearance'">
          <h2 class="mb-1 text-[15px] font-semibold text-text-strong">外观</h2>
          <p class="mb-4 text-[12px] text-muted">即时生效，无需保存</p>

          <p class="mb-1.5 text-[12px] font-medium text-muted">主题</p>
          <div class="mb-4 flex gap-2">
            <button
              v-for="option in [
                { key: ThemeMode.Light, label: '浅色' },
                { key: ThemeMode.Dark, label: '深色' },
                { key: ThemeMode.System, label: '跟随系统' },
              ]"
              :key="option.key"
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-[12.5px] transition-colors"
              :class="
                ui.theme === option.key
                  ? 'border-accent bg-accent-soft font-medium text-accent'
                  : 'border-line bg-surface-2 text-muted hover:text-text'
              "
              @click="ui.setTheme(option.key)"
            >
              {{ option.label }}
            </button>
          </div>

          <p class="mb-1.5 text-[12px] font-medium text-muted">主题色</p>
          <div class="mb-4 flex gap-2">
            <button
              v-for="accent in accents"
              :key="accent.key"
              type="button"
              class="h-8 w-8 rounded-full border-2 transition-transform"
              :class="ui.accent === accent.key ? 'scale-110 border-text-strong' : 'border-transparent'"
              :style="{ background: accent.color }"
              :title="accent.label"
              @click="ui.setAccent(accent.key)"
            />
          </div>

          <p class="mb-1.5 text-[12px] font-medium text-muted">发送方式</p>
          <div class="mb-4 flex gap-2">
            <button
              v-for="option in [
                { key: 'enter', label: 'Enter 发送' },
                { key: 'ctrl+enter', label: 'Ctrl+Enter 发送' },
              ]"
              :key="option.key"
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-[12.5px]"
              :class="
                ui.sendKey === option.key
                  ? 'border-accent bg-accent-soft font-medium text-accent'
                  : 'border-line bg-surface-2 text-muted hover:text-text'
              "
              @click="ui.sendKey = option.key as 'enter' | 'ctrl+enter'"
            >
              {{ option.label }}
            </button>
          </div>

          <label class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
            <span class="text-[12.5px] text-text">减少动效</span>
            <input
              type="checkbox"
              :checked="ui.reduceMotion"
              class="h-4 w-4 accent-[var(--accent)]"
              @change="
                ui.reduceMotion = ($event.target as HTMLInputElement).checked;
                ui.applyTheme()
              "
            />
          </label>
        </section>

        <!-- 通知 -->
        <section v-else-if="currentSection === 'notification'">
          <NotificationSettings />
        </section>

        <!-- 服务器 -->
        <section v-else-if="currentSection === 'server'">
          <h2 class="mb-1 text-[15px] font-semibold text-text-strong">服务器</h2>
          <p class="mb-4 text-[12px] text-muted">
            切换服务器会重新登录，本地数据按服务器隔离存储
          </p>

          <div class="space-y-1.5">
            <div
              v-for="server in servers.servers"
              :key="server.id"
              class="flex items-center gap-2 rounded-xl border px-3 py-2"
              :class="server.id === servers.currentId ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface'"
            >
              <Icon name="server" :size="15" class="text-muted" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] font-medium text-text-strong">{{ server.name }}</p>
                <p class="truncate text-[11px] text-muted">{{ server.baseUrl }}</p>
              </div>
              <span v-if="server.id === servers.currentId" class="text-[11px] text-accent">当前</span>
              <button
                v-else
                type="button"
                class="rounded-md px-2 py-1 text-[11.5px] text-muted hover:bg-surface-2 hover:text-text"
                @click="switchServer(server.id)"
              >
                切换
              </button>
              <button
                type="button"
                class="rounded-md p-1 text-muted hover:bg-danger/10 hover:text-danger"
                title="移除并清理本地数据"
                @click="removeServer(server.id)"
              >
                <Icon name="trash" :size="13" />
              </button>
            </div>
          </div>

          <div class="mt-4 rounded-xl border border-line bg-surface p-3">
            <p class="mb-2 text-[12px] font-medium text-muted">添加服务器</p>
            <div class="flex gap-2">
              <input
                v-model="newServerUrl"
                type="text"
                placeholder="http://192.168.1.10:8787"
                class="h-9 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-[13px] outline-none focus:border-accent"
              />
              <button
                type="button"
                class="rounded-lg bg-accent px-3 text-[12.5px] font-medium text-accent-text disabled:opacity-60"
                :disabled="serverBusy"
                @click="addServer"
              >
                添加
              </button>
            </div>
            <p v-if="serverError" class="mt-1.5 text-[11.5px] text-danger">{{ serverError }}</p>
            <p v-if="servers.serverInfo" class="mt-1.5 text-[11px] text-muted">
              当前可连接：{{ servers.serverInfo.name }} · 注册
              {{ servers.serverInfo.registration.open ? '开放' : '关闭' }}
            </p>
          </div>
        </section>

        <!-- AI -->
        <section v-else-if="currentSection === 'ai'">
          <AiSettings />
        </section>

        <!-- 存储 -->
        <section v-else-if="currentSection === 'stickers'">
          <StickerSettings />
        </section>

        <section v-else-if="currentSection === 'storage'">
          <h2 class="mb-1 text-[15px] font-semibold text-text-strong">存储与数据</h2>
          <p class="mb-4 text-[12px] text-muted">
            消息与图片镜像在本机，删服务器会连带清理该服务器的本地数据
          </p>
          <div class="rounded-xl border border-dashed border-line p-4 text-[12.5px] text-muted">
            本地库大小统计、按服务器清理与聊天记录导出会在 P2 阶段补齐。
          </div>
        </section>

        <!-- 关于 -->
        <section v-else>
          <h2 class="mb-1 text-[15px] font-semibold text-text-strong">关于</h2>
          <div class="space-y-1.5 rounded-xl border border-line bg-surface p-4 text-[12.5px]">
            <p class="flex justify-between"><span class="text-muted">客户端版本</span><span>0.1.0</span></p>
            <p class="flex justify-between">
              <span class="text-muted">服务端版本</span>
              <span>{{ servers.serverInfo?.version ?? '-' }}</span>
            </p>
            <p class="flex justify-between">
              <span class="text-muted">协议前缀</span><span>{{ normalizeServerUrl(servers.current?.baseUrl ?? 'http://localhost').baseUrl }}</span>
            </p>
            <p class="flex justify-between">
              <span class="text-muted">本地镜像</span>
              <span>SQLite（离线优先）</span>
            </p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
