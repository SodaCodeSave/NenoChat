/**
 * 动效偏好：系统设置或应用内「减少动效」任一开启即视为开启。
 * CSS 动画由 index.css 的两条全局规则压平，但 JS 驱动的滚动不走 CSS，必须自己判断。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  if (document.documentElement.dataset.reduceMotion === 'true') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 需要平滑滚动时的 behavior，减少动效下退化为 auto */
export function smoothScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
