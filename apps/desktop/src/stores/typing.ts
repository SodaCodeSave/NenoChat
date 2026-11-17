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
 * 对面来的事件带过期时间，本地定时清理；
 * 自己发出的信号按 4 秒节流，避免每次按键都上行。
 */
export const useTypingStore = defineStore('typing', () => {
  const entries = ref<Record<string, Record<string, TypingEntry>>>({})
  const lastSentAt = ref<Record<string, number>>({})

  function applyTyping(conversationId: string, userId: string, state: 'start' | 'stop', expiresAt: number): void {
    const bucket = entries.value[conversationId] ?? {}
    if (state === 'stop') {
      delete bucket[userId]
    } else {
      bucket[userId] = { state, expiresAt }
    }
    entries.value[conversationId] = bucket
  }

  /** 当前仍在输入的人（已过期的自动过滤掉） */
  function activeIn(conversationId: string): string[] {
    const bucket = entries.value[conversationId] ?? {}
    const now = Date.now()
    return Object.entries(bucket)
      .filter(([, entry]) => entry.state === 'start' && entry.expiresAt > now)
      .map(([userId]) => userId)
  }

  /** 用户开始输入；节流窗口内不重复上报 */
  function notifyTyping(conversationId: string): void {
    const last = lastSentAt.value[conversationId] ?? 0
    const now = Date.now()
    if (now - last < TYPING_THROTTLE_MS) return
    lastSentAt.value[conversationId] = now
    wsClient.emit('typing', { conversationId, state: 'start' })

    setTimeout(() => {
      if (Date.now() - (lastSentAt.value[conversationId] ?? 0) >= TYPING_TTL_MS - 500) {
        wsClient.emit('typing', { conversationId, state: 'stop' })
      }
    }, TYPING_TTL_MS)
  }

  function stopTyping(conversationId: string): void {
    lastSentAt.value[conversationId] = 0
    wsClient.emit('typing', { conversationId, state: 'stop' })
  }

  function clear(conversationId: string): void {
    delete entries.value[conversationId]
  }

  return { entries, applyTyping, activeIn, notifyTyping, stopTyping, clear }
})
