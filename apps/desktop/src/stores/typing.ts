import { defineStore } from 'pinia'
import { ref } from 'vue'
import { TYPING_THROTTLE_MS, TYPING_TTL_MS } from '@nenochat/shared'
import { wsClient } from '@/realtime/ws-client'

interface TypingEntry {
  state: 'start' | 'stop'
  expiresAt: number
}

/**
 * 「正在输入」状态。
 * 对面来的事件带过期时间，读取时惰性清扫过期项；
 * 自己发出的信号按 4 秒节流，避免每次按键都上行。
 */
export const useTypingStore = defineStore('typing', () => {
  const entries = ref<Record<string, Record<string, TypingEntry>>>({})
  const lastSentAt = ref<Record<string, number>>({})
  /** 会话 → 兜底 stop 定时器；stopTyping / clear 时要撤掉，避免堆积无用定时器 */
  const stopTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function applyTyping(conversationId: string, userId: string, state: 'start' | 'stop', expiresAt: number): void {
    const bucket = entries.value[conversationId] ?? {}
    if (state === 'stop') {
      delete bucket[userId]
    } else {
      bucket[userId] = { state, expiresAt }
    }
    entries.value[conversationId] = bucket
  }

  /** 当前仍在输入的人（把过期项一并清出 Map，防止长期驻留的会话把内存攒大） */
  function activeIn(conversationId: string): string[] {
    const bucket = entries.value[conversationId]
    if (!bucket) return []
    const now = Date.now()
    const kept: Record<string, TypingEntry> = {}
    const active: string[] = []
    for (const [userId, entry] of Object.entries(bucket)) {
      if (entry.state === 'start' && entry.expiresAt > now) {
        active.push(userId)
        kept[userId] = entry
      }
    }
    // 有过期项才写回，整体替换引用以触发订阅方刷新
    if (Object.keys(kept).length !== Object.keys(bucket).length) {
      entries.value[conversationId] = kept
    }
    return active
  }

  /** 用户开始输入；节流窗口内不重复上报 */
  function notifyTyping(conversationId: string): void {
    const last = lastSentAt.value[conversationId] ?? 0
    const now = Date.now()
    if (now - last < TYPING_THROTTLE_MS) return
    lastSentAt.value[conversationId] = now
    wsClient.emit('typing', { conversationId, state: 'start' })

    // 同一会话只挂一个兜底 stop 定时器；期间还在打字就顺延，停顿后再补发 stop
    if (stopTimers.has(conversationId)) return
    const armStopTimer = (): void => {
      stopTimers.set(
        conversationId,
        setTimeout(() => {
          stopTimers.delete(conversationId)
          const sentAt = lastSentAt.value[conversationId] ?? 0
          if (Date.now() - sentAt >= TYPING_TTL_MS - 500) {
            wsClient.emit('typing', { conversationId, state: 'stop' })
          } else {
            armStopTimer()
          }
        }, TYPING_TTL_MS),
      )
    }
    armStopTimer()
  }

  function stopTyping(conversationId: string): void {
    lastSentAt.value[conversationId] = 0
    const timer = stopTimers.get(conversationId)
    if (timer) {
      clearTimeout(timer)
      stopTimers.delete(conversationId)
    }
    wsClient.emit('typing', { conversationId, state: 'stop' })
  }

  /** 会话离开时清干净内存与定时器 */
  function clear(conversationId: string): void {
    const timer = stopTimers.get(conversationId)
    if (timer) {
      clearTimeout(timer)
      stopTimers.delete(conversationId)
    }
    delete entries.value[conversationId]
    delete lastSentAt.value[conversationId]
  }

  return { entries, applyTyping, activeIn, notifyTyping, stopTyping, clear }
})
