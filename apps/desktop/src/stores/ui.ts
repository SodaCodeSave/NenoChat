import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { ThemeMode, type UserSettings } from '@nenochat/shared'
import { useMediaQuery } from '@vueuse/core'

const THEME_KEY = 'nenochat.theme'
const ACCENT_KEY = 'nenochat.accent'

export type NavSection = 'messages' | 'contacts' | 'moments' | 'settings'
export type MobileTab = 'messages' | 'contacts' | 'moments' | 'me'
export type RightPanel = 'none' | 'members' | 'memory' | 'detail'

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
  const reduceMotion = ref(false)
  const sendKey = ref<'enter' | 'ctrl+enter'>('enter')

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

  /** 服务端下发的用户设置覆盖本地默认值 */
  function applyServerSettings(settings: UserSettings): void {
    theme.value = settings.theme
    accent.value = settings.accent
    density.value = settings.density
    fontScale.value = settings.fontScale
    sendKey.value = settings.sendKey
    reduceMotion.value = settings.reduceMotion
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
    applyServerSettings,
  }
})
