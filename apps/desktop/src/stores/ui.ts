import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { ThemeMode, type UserSettings } from '@nenochat/shared'
import { useMediaQuery } from '@vueuse/core'

const THEME_KEY = 'nenochat.theme'
const ACCENT_KEY = 'nenochat.accent'
const MESSAGE_STYLE_KEY = 'nenochat.messageStyle'
const LINK_DISPLAY_KEY = 'nenochat.linkDisplay'
const SEND_KEY_KEY = 'nenochat.sendKey'
const REDUCE_MOTION_KEY = 'nenochat.reduceMotion'
const CONVERSATION_LIST_KEY = 'nenochat.conversationListCollapsed'

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
    root.dataset.accent = accent.value
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
    applyServerSettings,
  }
})
