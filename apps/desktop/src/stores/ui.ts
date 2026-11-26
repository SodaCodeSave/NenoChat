import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { ThemeMode, type UserSettings } from '@nenochat/shared'
import { useMediaQuery } from '@vueuse/core'
import { accentVariants, normalizeHex } from '@/platform/bg-accent'

const THEME_KEY = 'nenochat.theme'
const ACCENT_KEY = 'nenochat.accent'
const MESSAGE_STYLE_KEY = 'nenochat.messageStyle'
const LINK_DISPLAY_KEY = 'nenochat.linkDisplay'
const SEND_KEY_KEY = 'nenochat.sendKey'
const REDUCE_MOTION_KEY = 'nenochat.reduceMotion'
const CONVERSATION_LIST_KEY = 'nenochat.conversationListCollapsed'
const NAV_LABELS_KEY = 'nenochat.showNavLabels'
const CONNECTOR_HINTS_KEY = 'nenochat.showConnectorHints'
const AI_BADGE_KEY = 'nenochat.showAiBadge'
const CHAT_BG_URL_KEY = 'nenochat.chatBgUrl'
const CHAT_BG_ACCENT_KEY = 'nenochat.chatBgAccent'
const ACCENT_FOLLOW_BG_KEY = 'nenochat.accentFollowBg'

/** data-accent='custom' 时派生变量写进 <html> 内联 style，CSS 里按深浅模式取用 */
const CUSTOM_ACCENT_VARS = [
  '--accent-custom',
  '--accent-soft-custom',
  '--accent-custom-dark',
  '--accent-soft-custom-dark',
] as const

export type NavSection = 'messages' | 'contacts' | 'moments' | 'settings'
export type MobileTab = 'messages' | 'contacts' | 'moments' | 'me'
export type RightPanel = 'none' | 'members' | 'memory' | 'detail'
/** 消息排版风格：discord 扁平流式，qq 气泡式（自己靠右） */
export type MessageStyle = 'discord' | 'qq'
/** 链接展示样式：card 正文后追加信息卡片，logo 正文链接替换为 LOGO + 标题 */
export type LinkDisplay = 'card' | 'logo'

/**
 * 纯界面状态：主题、密度、导航位置、抽屉开关。
 * 与服务器无关的设置同时写 localStorage，保证首屏不闪。
 */
export const useUiStore = defineStore('ui', () => {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')

  const theme = ref<ThemeMode>((localStorage.getItem(THEME_KEY) as ThemeMode) || ThemeMode.System)
  const accent = ref<string>(localStorage.getItem(ACCENT_KEY) || 'blue')
  const density = ref<'cozy' | 'compact'>('cozy')
  const fontScale = ref(1)
  const reduceMotion = ref(localStorage.getItem(REDUCE_MOTION_KEY) === 'true')
  const sendKey = ref<'enter' | 'ctrl+enter'>(
    localStorage.getItem(SEND_KEY_KEY) === 'ctrl+enter' ? 'ctrl+enter' : 'enter',
  )
  /** 消息排版风格，纯本地偏好不进服务器设置 */
  const messageStyle = ref<MessageStyle>(
    localStorage.getItem(MESSAGE_STYLE_KEY) === 'qq' ? 'qq' : 'discord',
  )
  /** 链接展示样式，纯本地偏好不进服务器设置 */
  const linkDisplay = ref<LinkDisplay>(
    localStorage.getItem(LINK_DISPLAY_KEY) === 'logo' ? 'logo' : 'card',
  )
  /** 桌面端会话列表的手动收起状态，跨会话记住 */
  const conversationListCollapsed = ref(
    localStorage.getItem(CONVERSATION_LIST_KEY) === 'true',
  )
  /** 导航栏是否显示菜单文字，关闭后只留图标并把栏宽收窄 */
  const showNavLabels = ref(localStorage.getItem(NAV_LABELS_KEY) !== 'false')
  /** 是否在消息里显示连接器动作提示（"已联网搜索"等小字），纯本地偏好 */
  const showConnectorHints = ref(localStorage.getItem(CONNECTOR_HINTS_KEY) !== 'false')
  /** 是否显示 AI 角标（会话列表、聊天标题、朋友圈、成员列表等处的 AI 标），纯本地偏好 */
  const showAiBadge = ref(localStorage.getItem(AI_BADGE_KEY) !== 'false')

  /**
   * 聊天背景图（服务端 /files/... 相对 URL）与随图提取的主色。
   * 真值在服务端 user_settings，localStorage 只做镜像保证重开首屏不闪；
   * 登录后由 applyServerBackground 以服务端值为准覆盖。
   */
  const chatBgUrl = ref<string | null>(localStorage.getItem(CHAT_BG_URL_KEY) || null)
  const chatBgAccent = ref<string | null>(normalizeHex(localStorage.getItem(CHAT_BG_ACCENT_KEY) ?? ''))
  /** 主题色是否跟随背景图；关闭后回退到手动选择的主题色 */
  const accentFollowBg = ref(localStorage.getItem(ACCENT_FOLLOW_BG_KEY) !== 'false')

  const navSection = ref<NavSection>('messages')
  const mobileTab = ref<MobileTab>('messages')
  const rightPanel = ref<RightPanel>('members')
  const drawerOpen = ref(false)
  const commandOpen = ref(false)

  const isMobile = useMediaQuery('(max-width: 767px)')
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1023px)')
  const isDesktop = useMediaQuery('(min-width: 1024px)')

  const resolvedTheme = computed<'light' | 'dark'>(() =>
    theme.value === ThemeMode.System ? (prefersDark.value ? 'dark' : 'light') : theme.value,
  )

  function applyTheme(): void {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme.value === 'dark')
    // 主题色跟随背景：切到 custom 档，把提取主色的四档派生色写进内联变量
    //（浅色读 --accent-custom*，深色读 --accent-custom-dark*，见 index.css）
    const variants =
      accentFollowBg.value && chatBgAccent.value ? accentVariants(chatBgAccent.value) : null
    if (variants) {
      root.dataset.accent = 'custom'
      root.style.setProperty('--accent-custom', variants.light)
      root.style.setProperty('--accent-soft-custom', variants.softLight)
      root.style.setProperty('--accent-custom-dark', variants.dark)
      root.style.setProperty('--accent-soft-custom-dark', variants.softDark)
    } else {
      root.dataset.accent = accent.value
      for (const name of CUSTOM_ACCENT_VARS) root.style.removeProperty(name)
    }
    root.dataset.reduceMotion = reduceMotion.value ? 'true' : 'false'
    root.style.setProperty('--font-scale', String(fontScale.value))
  }

  function setTheme(next: ThemeMode): void {
    theme.value = next
    localStorage.setItem(THEME_KEY, next)
    applyTheme()
  }

  function toggleTheme(): void {
    setTheme(resolvedTheme.value === 'dark' ? ThemeMode.Light : ThemeMode.Dark)
  }

  function setAccent(next: string): void {
    accent.value = next
    localStorage.setItem(ACCENT_KEY, next)
    applyTheme()
  }

  function setConversationListCollapsed(next: boolean): void {
    conversationListCollapsed.value = next
    localStorage.setItem(CONVERSATION_LIST_KEY, String(next))
  }

  function setMessageStyle(next: MessageStyle): void {
    messageStyle.value = next
    localStorage.setItem(MESSAGE_STYLE_KEY, next)
  }

  function setLinkDisplay(next: LinkDisplay): void {
    linkDisplay.value = next
    localStorage.setItem(LINK_DISPLAY_KEY, next)
  }

  function setSendKey(next: 'enter' | 'ctrl+enter'): void {
    sendKey.value = next
    localStorage.setItem(SEND_KEY_KEY, next)
  }

  function setReduceMotion(next: boolean): void {
    reduceMotion.value = next
    localStorage.setItem(REDUCE_MOTION_KEY, String(next))
    applyTheme()
  }

  function setShowNavLabels(next: boolean): void {
    showNavLabels.value = next
    localStorage.setItem(NAV_LABELS_KEY, String(next))
  }

  function setShowConnectorHints(next: boolean): void {
    showConnectorHints.value = next
    localStorage.setItem(CONNECTOR_HINTS_KEY, String(next))
  }

  function setShowAiBadge(next: boolean): void {
    showAiBadge.value = next
    localStorage.setItem(AI_BADGE_KEY, String(next))
  }

  /** 设置/清除聊天背景（null 表示清除），同步镜像到 localStorage 供下次启动免闪 */
  function setChatBackground(url: string | null, accentHex: string | null): void {
    chatBgUrl.value = url
    chatBgAccent.value = accentHex ? normalizeHex(accentHex) : null
    if (url) localStorage.setItem(CHAT_BG_URL_KEY, url)
    else localStorage.removeItem(CHAT_BG_URL_KEY)
    if (chatBgAccent.value) localStorage.setItem(CHAT_BG_ACCENT_KEY, chatBgAccent.value)
    else localStorage.removeItem(CHAT_BG_ACCENT_KEY)
    applyTheme()
  }

  function setAccentFollowBg(next: boolean): void {
    accentFollowBg.value = next
    localStorage.setItem(ACCENT_FOLLOW_BG_KEY, String(next))
    applyTheme()
  }

  /** 服务端下发的背景设置覆盖本地镜像（只碰背景字段，theme/accent 仍是纯本地偏好） */
  function applyServerBackground(settings: Pick<UserSettings, 'chatBgUrl' | 'chatBgAccent'>): void {
    setChatBackground(settings.chatBgUrl, settings.chatBgAccent)
  }

  /** 登出/切服务器时清掉上一账号的背景，避免下一账号首屏串台 */
  function clearServerBackground(): void {
    setChatBackground(null, null)
  }

  function toggleConversationList(): void {
    setConversationListCollapsed(!conversationListCollapsed.value)
  }

  /** 服务端下发的用户设置覆盖本地默认值 */
  function applyServerSettings(settings: UserSettings): void {
    theme.value = settings.theme
    accent.value = settings.accent
    density.value = settings.density
    fontScale.value = settings.fontScale
    setSendKey(settings.sendKey)
    setReduceMotion(settings.reduceMotion)
    localStorage.setItem(THEME_KEY, settings.theme)
    localStorage.setItem(ACCENT_KEY, settings.accent)
    applyTheme()
  }

  watch(prefersDark, () => {
    if (theme.value === ThemeMode.System) applyTheme()
  })

  applyTheme()

  return {
    theme,
    accent,
    density,
    fontScale,
    reduceMotion,
    sendKey,
    messageStyle,
    linkDisplay,
    conversationListCollapsed,
    showNavLabels,
    showConnectorHints,
    showAiBadge,
    chatBgUrl,
    chatBgAccent,
    accentFollowBg,
    navSection,
    mobileTab,
    rightPanel,
    drawerOpen,
    commandOpen,
    isMobile,
    isTablet,
    isDesktop,
    resolvedTheme,
    applyTheme,
    setTheme,
    toggleTheme,
    setAccent,
    setMessageStyle,
    setLinkDisplay,
    setSendKey,
    setReduceMotion,
    setConversationListCollapsed,
    toggleConversationList,
    setShowNavLabels,
    setShowConnectorHints,
    setShowAiBadge,
    setChatBackground,
    setAccentFollowBg,
    applyServerBackground,
    clearServerBackground,
    applyServerSettings,
  }
})
