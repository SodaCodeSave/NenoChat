import { onBeforeUnmount } from 'vue'

/** 长按触发阈值（ms） */
const LONG_PRESS_MS = 450
/** 手指移动超过该距离（px）视为滚动，取消长按 */
const CANCEL_DISTANCE_PX = 10
/** 长按弹层后部分 WebView 不再派发 click，超过此时长兜底复位标志位（ms） */
const LONG_PRESS_RESET_MS = 600

export interface LongPressHandlers {
  onTouchStart: (event: TouchEvent) => void
  onTouchMove: (event: TouchEvent) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
  /** 长按刚触发过则消费掉标志并返回 true：抬手产生的 click 不应再触发选中 */
  consumeLongPressed: () => boolean
}

/**
 * 手机端长按手势：按住 450ms 触发回调，移动超过 10px 视为滚动并取消。
 * 触发条件（是否手机端、消息是否可操作等）由组件自行判断后再转交事件；
 * 需要拦截「长按弹层后抬手误触 click」时用 consumeLongPressed。
 */
export function useLongPress(callback: (x: number, y: number) => void): LongPressHandlers {
  let pressTimer = 0
  let resetTimer = 0
  let startX = 0
  let startY = 0
  let longPressed = false

  function clearPress(): void {
    window.clearTimeout(pressTimer)
    pressTimer = 0
  }

  function onTouchStart(event: TouchEvent): void {
    const touch = event.touches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    longPressed = false
    window.clearTimeout(resetTimer)
    resetTimer = 0
    clearPress()
    pressTimer = window.setTimeout(() => {
      longPressed = true
      callback(startX, startY)
      // 部分 WebView 长按后不会再派发 click，兜底恢复，避免吞掉下一次点击
      resetTimer = window.setTimeout(() => {
        longPressed = false
        resetTimer = 0
      }, LONG_PRESS_RESET_MS)
    }, LONG_PRESS_MS)
  }

  function onTouchMove(event: TouchEvent): void {
    const touch = event.touches[0]
    if (!touch || !pressTimer) return
    if (
      Math.abs(touch.clientX - startX) > CANCEL_DISTANCE_PX ||
      Math.abs(touch.clientY - startY) > CANCEL_DISTANCE_PX
    ) {
      clearPress()
    }
  }

  function consumeLongPressed(): boolean {
    if (!longPressed) return false
    longPressed = false
    window.clearTimeout(resetTimer)
    resetTimer = 0
    return true
  }

  // 长按与复位定时器都必须随组件卸载清掉，否则会挂到下一次挂载
  onBeforeUnmount(() => {
    clearPress()
    window.clearTimeout(resetTimer)
    resetTimer = 0
  })

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd: clearPress,
    onTouchCancel: clearPress,
    consumeLongPressed,
  }
}
