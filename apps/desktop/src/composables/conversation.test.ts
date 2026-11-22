import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '@/api/endpoints'
import type { LastMessageSummary } from '@nenochat/shared'
import { conversationTitle, messagePreviewFromSummary } from '@/composables/conversation'

const direct = {
  id: 'c1',
  type: 'direct',
  partnerId: 'u1',
  partnerName: '张三',
} as ConversationSummary

function summary(patch: Partial<LastMessageSummary>): LastMessageSummary {
  return { senderId: 'u1', type: 'text', content: '', attachmentName: null, deleted: false, ...patch }
}

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

describe('列表摘要预览', () => {
  it('文本消息取正文前 60 字', () => {
    const long = '啊'.repeat(80)
    expect(messagePreviewFromSummary(summary({ content: long }))).toBe('啊'.repeat(60))
  })

  it('附件与特殊类型用占位文案，文件带文件名', () => {
    expect(messagePreviewFromSummary(summary({ type: 'image' }))).toBe('[图片]')
    expect(messagePreviewFromSummary(summary({ type: 'file', attachmentName: '报告.pdf' }))).toBe('[文件] 报告.pdf')
    expect(messagePreviewFromSummary(summary({ type: 'sticker' }))).toBe('[表情]')
    expect(messagePreviewFromSummary(summary({ type: 'voice' }))).toBe('[语音]')
  })

  it('撤回消息优先显示已撤回占位', () => {
    expect(messagePreviewFromSummary(summary({ content: '原文', deleted: true }))).toBe('[消息已撤回]')
  })

  it('空摘要返回空串，回退逻辑交给调用方', () => {
    expect(messagePreviewFromSummary(null)).toBe('')
  })
})
