<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Avatar from '@/components/ui/Avatar.vue'
import Icon from '@/components/ui/Icon.vue'
import type { IconName } from '@/components/ui/icons'
import TextInput from '@/components/ui/form/TextInput.vue'
import AccountSettings from '@/components/settings/sections/AccountSettings.vue'
import AppearanceSettings from '@/components/settings/sections/AppearanceSettings.vue'
import ServerSettings from '@/components/settings/sections/ServerSettings.vue'
import MobilePairing from '@/components/settings/sections/MobilePairing.vue'
import AboutSettings from '@/components/settings/sections/AboutSettings.vue'
import AiSettings from '@/components/settings/AiSettings.vue'
import UsageStatsSettings from '@/components/settings/UsageStatsSettings.vue'
import PersonaSettings from '@/components/settings/PersonaSettings.vue'
import ConnectorSettings from '@/components/settings/ConnectorSettings.vue'
import McpSkillSettings from '@/components/settings/McpSkillSettings.vue'
import StickerSettings from '@/components/settings/StickerSettings.vue'
import NotificationSettings from '@/components/settings/NotificationSettings.vue'
import StorageSettings from '@/components/settings/StorageSettings.vue'
import { CLIENT_VERSION } from '@/version'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'
import { useUiStore } from '@/stores/ui'
import { smoothScrollBehavior } from '@/composables/motion'

type SectionKey =
  | 'account'
  | 'appearance'
  | 'notification'
  | 'server'
  | 'mobile'
  | 'ai'
  | 'usage-stats'
  | 'persona'
  | 'connectors'
  | 'mcpSkill'
  | 'stickers'
  | 'storage'
  | 'about'

interface SettingsAnchor {
  id: string
  label: string
  keywords?: string
}

interface SettingsSection {
  key: SectionKey
  label: string
  icon: IconName
  description: string
  anchors: SettingsAnchor[]
}

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const servers = useServersStore()
const ui = useUiStore()

const allSections: SettingsSection[] = [
  {
    key: 'account',
    label: '账号与通用',
    icon: 'user',
    description: '管理个人资料、账号信息与登录状态',
    anchors: [
      { id: 'profile', label: '个人资料', keywords: '昵称 头像 签名 资料' },
      { id: 'account-info', label: '账号信息', keywords: '用户名 id' },
      { id: 'danger', label: '危险操作', keywords: '退出登录 登出' },
    ],
  },
  {
    key: 'appearance',
    label: '外观',
    icon: 'sun',
    description: '主题、主题色与聊天输入偏好',
    anchors: [
      { id: 'theme', label: '主题', keywords: '深色 浅色 系统 主题色 颜色 claude' },
      { id: 'font', label: '字体', keywords: '衬线 宋体 楷体 无衬线 自定义 字族' },
      { id: 'sidebar', label: '侧边栏', keywords: '导航栏 菜单 文字 图标 收窄 隐藏' },
      { id: 'background', label: '聊天背景', keywords: '背景 壁纸 背景图 主题色 随背景' },
      { id: 'input', label: '聊天与输入', keywords: '发送 快捷键 enter' },
      { id: 'motion', label: '动效', keywords: '动画 减少动效' },
    ],
  },
  {
    key: 'notification',
    label: '通知',
    icon: 'bell',
    description: '系统通知、声音与免打扰',
    anchors: [],
  },
  {
    key: 'server',
    label: '服务器',
    icon: 'server',
    description: '连接、切换与移除自建服务端',
    anchors: [
      { id: 'current', label: '已连接的服务器', keywords: '切换 地址' },
      { id: 'add', label: '添加服务器', keywords: '新增 连接' },
    ],
  },
  {
    key: 'mobile',
    label: '手机接入',
    icon: 'smartphone',
    description: '开个二维码，让手机连上这台电脑的数据',
    anchors: [{ id: 'mobile-access', label: '手机接入', keywords: '二维码 扫码 局域网 手机 配对' }],
  },
  {
    key: 'ai',
    label: 'AI 模型',
    icon: 'sparkles',
    description: '服务商、模型与回复方式',
    anchors: [
      { id: 'providers', label: '服务商', keywords: '模型 api key 端点 余额 识图 上下文窗口' },
      { id: 'reply', label: '回复与调试', keywords: '流式 分段 调试 token' },
    ],
  },
  {
    key: 'usage-stats',
    label: '用量统计',
    icon: 'chart',
    description: 'AI token 消耗：按角色、按模型、按功能与时间趋势',
    anchors: [
      { id: 'overview', label: '用量总览', keywords: 'token 统计 用量 消耗 图表 趋势' },
      { id: 'by-ai', label: '按 AI 统计', keywords: '角色 模型 token 排行' },
      { id: 'by-kind', label: '按功能统计', keywords: '功能 场景 对话 记忆 识图' },
    ],
  },
  {
    key: 'persona',
    label: '角色与互动',
    icon: 'users',
    description: 'AI 角色与主动消息、动态广场、群聊等自动互动',
    anchors: [
      { id: 'personas', label: 'AI 角色', keywords: '人设 角色卡 新建 编辑' },
      { id: 'relationship', label: '关系系统', keywords: '关系 阶段 亲密度 恋人 好感' },
      { id: 'proactive', label: '自动互动', keywords: '主动消息 动态 群聊 概率 免打扰' },
    ],
  },
  {
    key: 'connectors',
    label: '连接器',
    icon: 'globe',
    description: '连接第三方数据源，让 AI 能搜索网页、总结视频',
    anchors: [
      { id: 'connectors', label: '连接器', keywords: '搜索 b站 bilibili deepseek 第三方 数据源 网页' },
    ],
  },
  {
    key: 'mcpSkill',
    label: 'MCP & Skill',
    icon: 'memory',
    description: '接入 MCP 工具服务器与技能提示词包，扩展 AI 的能力',
    anchors: [
      { id: 'mcp', label: 'MCP 服务器', keywords: 'mcp 工具 function calling 外部扩展' },
      { id: 'skills', label: '技能', keywords: 'skill 技能 提示词包 markdown' },
    ],
  },
  {
    key: 'stickers',
    label: '表情包',
    icon: 'smile',
    description: '表情分组、上传与 AI 使用权限',
    anchors: [{ id: 'packs', label: '表情包分组', keywords: '表情 上传 导入 ai' }],
  },
  {
    key: 'storage',
    label: '存储与数据',
    icon: 'folder',
    description: '本机占用、缓存策略与备份导入导出',
    anchors: [
      { id: 'usage', label: '占用总览', keywords: '空间 大小 统计' },
      { id: 'cache', label: '附件缓存', keywords: '缓存 上限 过期 清理' },
      { id: 'mirror', label: '本地消息镜像', keywords: '清空 镜像 消息' },
      { id: 'export', label: '导出备份', keywords: '备份 导出 json' },
      { id: 'import', label: '导入备份', keywords: '恢复 导入 json' },
    ],
  },
  {
    key: 'about',
    label: '关于',
    icon: 'message',
    description: '版本信息与数据存储方式',
    anchors: [
      { id: 'version', label: '版本信息', keywords: '版本 客户端 服务端' },
      { id: 'storage-mode', label: '数据模式', keywords: 'sqlite 本地 离线' },
    ],
  },
]

const groups: { label: string; keys: SectionKey[] }[] = [
  { label: '通用', keys: ['account', 'appearance', 'notification', 'server'] },
  { label: '智能', keys: ['ai', 'usage-stats', 'persona', 'connectors', 'mcpSkill', 'stickers'] },
  { label: '系统', keys: ['mobile', 'storage', 'about'] },
]

const sectionComponents = {
  account: AccountSettings,
  appearance: AppearanceSettings,
  notification: NotificationSettings,
  server: ServerSettings,
  mobile: MobilePairing,
  ai: AiSettings,
  'usage-stats': UsageStatsSettings,
  persona: PersonaSettings,
  connectors: ConnectorSettings,
  mcpSkill: McpSkillSettings,
  stickers: StickerSettings,
  storage: StorageSettings,
  about: AboutSettings,
}

/** 一体版内置了服务端，没有可切换的服务器；联网版反过来没有手机接入入口 */
const sections = computed(() =>
  allSections.filter((section) =>
    section.key === 'mobile' ? servers.integrated : section.key === 'server' ? !servers.integrated : true,
  ),
)

const visibleGroups = computed(() =>
  groups
    .map((group) => ({
      label: group.label,
      keys: group.keys.filter((key) => sections.value.some((section) => section.key === key)),
    }))
    .filter((group) => group.keys.length > 0),
)

const activeSection = ref<SectionKey>('account')
const activeAnchor = ref('')
const query = ref('')
const mobileMenuOpen = ref(false)
const mobileSearchOpen = ref(false)
const scrollEl = ref<HTMLElement | null>(null)

const currentMeta = computed(
  () => sections.value.find((section) => section.key === activeSection.value) ?? sections.value[0]!,
)
const currentComponent = computed(() => sectionComponents[activeSection.value])
const anchors = computed(() => currentMeta.value.anchors)
const hasQuery = computed(() => query.value.trim().length > 0)

const searchResults = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return []
  const results: { section: SettingsSection; anchor: SettingsAnchor | null }[] = []
  for (const section of sections.value) {
    const sectionHit = `${section.label} ${section.description}`
      .toLowerCase()
      .includes(keyword)
    if (sectionHit) results.push({ section, anchor: null })
    for (const anchor of section.anchors) {
      const text = `${anchor.label} ${anchor.keywords ?? ''} ${section.label}`.toLowerCase()
      if (text.includes(keyword)) results.push({ section, anchor })
    }
  }
  return results.slice(0, 12)
})

watch(
  () => route.params.section,
  (value) => {
    if (typeof value === 'string' && sections.value.some((section) => section.key === value)) {
      activeSection.value = value as SectionKey
    }
  },
  { immediate: true },
)

watch(activeSection, (value) => {
  activeAnchor.value = ''
  mobileMenuOpen.value = false
  void router.replace(`/settings/${value}`)
  void nextTick(() => scrollEl.value?.scrollTo({ top: 0 }))
})

/** 长页面用滚动位置点亮右侧子导航 */
function onScroll(): void {
  if (anchors.value.length === 0) return
  const containerTop = scrollEl.value?.getBoundingClientRect().top ?? 0
  let current = anchors.value[0]?.id ?? ''
  for (const anchor of anchors.value) {
    const element = document.getElementById(anchor.id)
    if (!element) continue
    if (element.getBoundingClientRect().top - containerTop <= 80) current = anchor.id
  }
  activeAnchor.value = current
}

async function goToSection(key: SectionKey, anchorId = ''): Promise<void> {
  activeSection.value = key
  query.value = ''
  mobileMenuOpen.value = false
  mobileSearchOpen.value = false
  await nextTick()
  if (!anchorId) return
  const element = document.getElementById(anchorId)
  element?.scrollIntoView({ block: 'start', behavior: smoothScrollBehavior() })
  activeAnchor.value = anchorId
}

function submitSearch(): void {
  const first = searchResults.value[0]
  if (first) void goToSection(first.section.key, first.anchor?.id ?? '')
}

onMounted(() => {
  scrollEl.value?.addEventListener('scroll', onScroll, { passive: true })
})

onBeforeUnmount(() => {
  scrollEl.value?.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <div class="flex h-full min-h-0" :class="ui.isMobile ? 'flex-col' : ''">
    <!-- 桌面端：分类导航 -->
    <aside
      v-if="!ui.isMobile"
      class="flex w-[236px] shrink-0 flex-col border-r border-line bg-surface-2"
    >
      <div class="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Avatar
          :name="auth.user?.displayName ?? '我'"
          :src="auth.user?.avatarUrl ?? null"
          :seed="auth.user?.id"
          :size="34"
        />
        <div class="min-w-0">
          <p class="truncate text-[13px] font-semibold text-text-strong">
            {{ auth.user?.displayName ?? '未登录' }}
          </p>
          <p class="truncate text-[11px] text-muted">@{{ auth.user?.username ?? '-' }}</p>
        </div>
      </div>

      <div class="px-3 pb-2">
        <TextInput
          v-model="query"
          size="sm"
          icon="search"
          placeholder="搜索设置项"
          autocomplete="off"
          spellcheck="false"
          @keydown.enter="submitSearch"
        >
          <template #suffix>
            <button
              v-if="hasQuery"
              type="button"
              class="mr-1 grid h-5 w-5 place-items-center rounded text-muted hover:bg-surface-3 hover:text-text"
              aria-label="清空搜索"
              @click="query = ''"
            >
              <Icon name="close" :size="11" />
            </button>
          </template>
        </TextInput>
      </div>

      <nav class="scroll-area min-h-0 flex-1 px-2 pb-3">
        <template v-if="hasQuery">
          <p class="px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-muted">
            搜索结果
          </p>
          <p v-if="searchResults.length === 0" class="px-2 py-4 text-[12px] text-muted">
            没有找到匹配的设置项
          </p>
          <button
            v-for="(result, index) in searchResults"
            :key="`${result.section.key}-${result.anchor?.id ?? 'root'}-${index}`"
            type="button"
            class="mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-3"
            @click="goToSection(result.section.key, result.anchor?.id ?? '')"
          >
            <Icon :name="result.section.icon" :size="14" class="shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">
              {{ result.anchor?.label ?? result.section.label }}
            </span>
            <span class="shrink-0 text-[10.5px] text-muted">{{ result.section.label }}</span>
          </button>
        </template>

        <template v-else>
          <div v-for="group in visibleGroups" :key="group.label" class="mb-3 last:mb-0">
            <p class="px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-muted">
              {{ group.label }}
            </p>
            <button
              v-for="key in group.keys"
              :key="key"
              type="button"
              class="mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors"
              :class="
                activeSection === key
                  ? 'bg-surface font-medium text-text-strong shadow-sm'
                  : 'text-muted hover:bg-surface-3 hover:text-text'
              "
              @click="goToSection(key)"
            >
              <Icon
                :name="sections.find((section) => section.key === key)!.icon"
                :size="15"
                :class="activeSection === key ? 'text-accent' : ''"
              />
              {{ sections.find((section) => section.key === key)!.label }}
            </button>
          </div>
        </template>
      </nav>

      <p class="border-t border-line px-4 py-2.5 text-[10.5px] text-muted">
        NenoChat {{ CLIENT_VERSION }} · 设置即时保存
      </p>
    </aside>

    <!-- 移动端：顶部标题 + 分类下拉 + 锚点条 -->
    <header
      v-else
      class="relative z-30 shrink-0 border-b border-line bg-surface px-4 pb-2 pt-[calc(0.5rem+var(--safe-top))]"
    >
      <div class="flex items-center justify-between">
        <h1 class="text-[19px] font-semibold text-text-strong">设置</h1>
        <button
          type="button"
          class="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors active:bg-surface-2"
          :aria-label="mobileSearchOpen ? '关闭搜索' : '搜索设置项'"
          @click="mobileSearchOpen = !mobileSearchOpen"
        >
          <Icon :name="mobileSearchOpen ? 'close' : 'search'" :size="17" />
        </button>
      </div>

      <div v-if="mobileSearchOpen" class="mt-2">
        <TextInput
          v-model="query"
          size="sm"
          icon="search"
          placeholder="搜索设置项，如 主题、通知、备份"
          autocomplete="off"
          @keydown.enter="submitSearch"
        />
        <div v-if="hasQuery" class="mt-1.5 overflow-hidden rounded-lg border border-line bg-surface">
          <p v-if="searchResults.length === 0" class="px-3 py-3 text-[12px] text-muted">
            没有找到匹配的设置项
          </p>
          <button
            v-for="(result, index) in searchResults"
            :key="`m-${result.section.key}-${result.anchor?.id ?? 'root'}-${index}`"
            type="button"
            class="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left first:border-t-0 active:bg-surface-2"
            @click="goToSection(result.section.key, result.anchor?.id ?? '')"
          >
            <Icon :name="result.section.icon" :size="14" class="shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">
              {{ result.anchor?.label ?? result.section.label }}
            </span>
            <span class="shrink-0 text-[10.5px] text-muted">{{ result.section.label }}</span>
          </button>
        </div>
      </div>

      <div v-else class="relative mt-2">
        <button
          type="button"
          class="flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-left"
          @click="mobileMenuOpen = !mobileMenuOpen"
        >
          <Icon :name="currentMeta.icon" :size="15" class="text-accent" />
          <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-strong">
            {{ currentMeta.label }}
          </span>
          <Icon
            name="chevronDown"
            :size="14"
            class="text-muted transition-transform"
            :class="mobileMenuOpen ? 'rotate-180' : ''"
          />
        </button>

        <div
          v-if="mobileMenuOpen"
          class="fixed inset-0 z-20"
          aria-hidden="true"
          @click="mobileMenuOpen = false"
        />
        <div
          v-if="mobileMenuOpen"
          class="absolute left-0 right-0 top-full z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow-soft)]"
        >
          <button
            v-for="section in sections"
            :key="section.key"
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors active:bg-surface-2"
            :class="
              activeSection === section.key ? 'bg-surface-2 font-medium text-text-strong' : 'text-text'
            "
            @click="goToSection(section.key)"
          >
            <Icon
              :name="section.icon"
              :size="15"
              :class="activeSection === section.key ? 'text-accent' : 'text-muted'"
            />
            <span class="min-w-0 flex-1 truncate text-[13px]">{{ section.label }}</span>
            <Icon
              v-if="activeSection === section.key"
              name="check"
              :size="13"
              class="text-accent"
            />
          </button>
        </div>
      </div>

      <nav v-if="anchors.length > 1" class="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
        <button
          v-for="anchor in anchors"
          :key="anchor.id"
          type="button"
          class="shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors"
          :class="
            activeAnchor === anchor.id
              ? 'border-accent/40 bg-accent-soft font-medium text-accent'
              : 'border-line bg-surface-2 text-muted'
          "
          @click="goToSection(activeSection, anchor.id)"
        >
          {{ anchor.label }}
        </button>
      </nav>
    </header>

    <div class="flex min-h-0 min-w-0 flex-1">
      <div ref="scrollEl" class="scroll-area min-w-0 flex-1">
        <div
          class="mx-auto w-full max-w-[880px] px-4 pb-10 md:px-8"
          :class="ui.isMobile ? 'pt-4' : 'pt-6'"
        >
          <div class="mb-4">
            <h2 class="text-[19px] font-semibold tracking-tight text-text-strong">
              {{ currentMeta.label }}
            </h2>
          </div>

          <component :is="currentComponent" :key="activeSection" />
        </div>
      </div>

      <!-- 桌面宽屏：本页目录 -->
      <aside
        v-if="!ui.isMobile && anchors.length > 2"
        class="hidden w-[176px] shrink-0 py-6 pr-5 xl:block"
      >
        <div class="sticky top-0">
          <p class="mb-2 px-2 text-[10.5px] font-medium uppercase tracking-wide text-muted">
            本页目录
          </p>
          <button
            v-for="anchor in anchors"
            :key="anchor.id"
            type="button"
            class="mb-0.5 block w-full truncate rounded-md border-l-2 px-2 py-1 text-left text-[12px] transition-colors"
            :class="
              activeAnchor === anchor.id
                ? 'border-accent bg-accent-soft/50 font-medium text-accent'
                : 'border-transparent text-muted hover:bg-surface-2 hover:text-text'
            "
            @click="goToSection(activeSection, anchor.id)"
          >
            {{ anchor.label }}
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>
