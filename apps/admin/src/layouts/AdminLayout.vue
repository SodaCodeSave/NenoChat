<script setup lang="ts">
import { ref } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/ui/Icon.vue'
import type { IconName } from '@/components/ui/icons'

const auth = useAuthStore()
const router = useRouter()

interface NavItem {
  name: string
  label: string
  icon: IconName
}

const nav: Array<{ group: string; items: NavItem[] }> = [
  {
    group: '总览',
    items: [{ name: 'dashboard', label: '概览', icon: 'chart' }],
  },
  {
    group: '人员',
    items: [
      { name: 'users', label: '用户', icon: 'users' },
      { name: 'invites', label: '邀请码', icon: 'shield' },
    ],
  },
  {
    group: '内容',
    items: [
      { name: 'conversations', label: '会话与消息', icon: 'message' },
      { name: 'posts', label: '动态', icon: 'megaphone' },
      { name: 'files', label: '文件存储', icon: 'folder' },
    ],
  },
  {
    group: '系统',
    items: [
      { name: 'settings', label: '服务器设置', icon: 'settings' },
      { name: 'ai-config', label: 'AI 配置', icon: 'cpu' },
      { name: 'ai-usage', label: 'AI 用量', icon: 'sparkles' },
      { name: 'audit', label: '审计日志', icon: 'clock' },
    ],
  },
]

const isDark = ref(document.documentElement.classList.contains('dark'))

function toggleTheme(): void {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
  try {
    localStorage.setItem('nenochat.admin.theme', isDark.value ? 'dark' : 'light')
  } catch {
    /* 忽略存储失败 */
  }
}

async function logout(): Promise<void> {
  await auth.logout()
  router.replace({ name: 'login' })
}
</script>

<template>
  <div class="flex h-full">
    <!-- 侧栏 -->
    <aside class="flex w-52 shrink-0 flex-col border-r border-line bg-surface-2">
      <div class="flex items-center gap-2 px-4 py-4">
        <div class="grid h-7 w-7 place-items-center rounded-lg bg-accent text-accent-text">
          <Icon name="shield" :size="15" />
        </div>
        <div class="min-w-0">
          <div class="text-[13px] font-semibold text-text-strong">NenoChat 管理面板</div>
          <div class="truncate text-[11px] text-muted">{{ auth.displayName }}</div>
        </div>
      </div>

      <nav class="min-h-0 flex-1 overflow-y-auto scroll-area px-2 pb-3">
        <div v-for="group in nav" :key="group.group" class="mb-3">
          <div class="px-2 py-1 text-[10.5px] font-medium uppercase tracking-wide text-muted/70">
            {{ group.group }}
          </div>
          <RouterLink
            v-for="item in group.items"
            :key="item.name"
            :to="{ name: item.name }"
            class="mt-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-surface-3 hover:text-text"
            active-class="bg-surface-3 text-text-strong font-medium"
          >
            <Icon :name="item.icon" :size="15" />
            {{ item.label }}
          </RouterLink>
        </div>
      </nav>

      <div class="border-t border-line p-2">
        <button
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-surface-3 hover:text-text"
          @click="logout"
        >
          <Icon name="logout" :size="15" />
          退出登录
        </button>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-12 shrink-0 items-center justify-between border-b border-line bg-surface px-5">
        <div class="text-[12px] text-muted">管理操作会写入审计日志，请谨慎执行删除类操作</div>
        <button
          class="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
          :aria-label="isDark ? '切换到浅色' : '切换到深色'"
          @click="toggleTheme"
        >
          <Icon :name="isDark ? 'sun' : 'moon'" :size="15" />
        </button>
      </header>
      <main class="min-h-0 flex-1 overflow-y-auto scroll-area">
        <div class="mx-auto max-w-5xl px-5 py-5">
          <RouterView />
        </div>
      </main>
    </div>
  </div>
</template>
