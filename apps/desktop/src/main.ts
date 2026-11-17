import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './app/router'
import './styles/index.css'

/**
 * 移动端 WebView 手感补丁：
 * - 阻止双指/双击缩放与手势缩放
 * - 屏蔽长按文字选中、系统上下文菜单与图片拖影
 * - 单指滚动保持原样
 */
function installMobileGuards(): void {
  /** 只影响手机形态，桌面端的右键与文本选择保持原样 */
  const mobile = window.matchMedia('(max-width: 767px)')
  const isMobile = (): boolean => mobile.matches

  const isEditable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && Boolean(target.closest('input, textarea, [contenteditable="true"]'))

  const stop = (event: Event): void => {
    if (!isMobile()) return
    event.preventDefault()
  }

  // Safari / 部分 WebView 的私有手势事件
  const gestureTarget = document as Document & {
    addEventListener(
      type: 'gesturestart' | 'gesturechange' | 'gestureend',
      listener: (event: Event) => void,
      options?: AddEventListenerOptions,
    ): void
  }
  for (const name of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    gestureTarget.addEventListener(name, stop, { passive: false })
  }

  document.addEventListener('dblclick', stop, { passive: false })

  // 手机端非输入区域的系统右键/长按菜单一律拦掉，交给应用自己的长按菜单
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!isMobile() || isEditable(event.target)) return
      event.preventDefault()
    },
    { passive: false },
  )

  // 双指触摸时阻止浏览器级缩放；单指仍交给页面滚动
  let multiTouch = false
  document.addEventListener(
    'touchstart',
    (event) => {
      multiTouch = isMobile() && event.touches.length > 1
    },
    { passive: true },
  )
  document.addEventListener(
    'touchmove',
    (event) => {
      if (multiTouch && event.touches.length > 1) event.preventDefault()
    },
    { passive: false },
  )
  document.addEventListener(
    'touchend',
    (event) => {
      if (event.touches.length === 0) multiTouch = false
    },
    { passive: true },
  )

  // 手机端拖拽图片/链接会触发 WebView 的原生拖影
  document.addEventListener('dragstart', (event) => {
    if (!isMobile() || isEditable(event.target)) return
    event.preventDefault()
  })
}

installMobileGuards()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
