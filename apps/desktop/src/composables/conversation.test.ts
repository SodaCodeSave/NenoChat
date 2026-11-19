import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '@/api/endpoints'
import { conversationTitle } from '@/composables/conversation'

const direct = {
  id: 'c1',
  type: 'direct',
  partnerId: 'u1',
  partnerName: '张三',
} as ConversationSummary

describe('会话标题', () => {
  it('好友私聊显示对方昵称', () => {
    expect(conversationTitle(direct, true)).toBe('张三')
  })

  it('非好友私聊追加临时标记', () => {
    expect(conversationTitle(direct, false)).toBe('张三 [临时对话]')
  })

  it('群聊不受好友关系影响', () => {
    expect(conversationTitle({ ...direct, type: 'group', name: '活动群' }, false)).toBe('活动群')
  })
})
