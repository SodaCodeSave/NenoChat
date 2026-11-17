import { describe, expect, it } from 'vitest'
import { AI_SKIP_TOKEN } from '../constants'
import type { AiPersona } from '../entities'
import { ReplyStyle } from '../enums'
import {
  buildChatMessages,
  buildGroupPrompt,
  buildMomentCommentPrompt,
  buildMomentPostPrompt,
  buildProactivePrompt,
  isSkipReply,
} from './prompt'

function persona(patch: Partial<AiPersona> = {}): AiPersona {
  const now = 1_700_000_000_000
  return {
    id: 'p1',
    ownerId: 'u1',
    name: '小禾',
    avatarUrl: null,
    systemPrompt: '你是 {{user}} 的朋友，说话随意。',
    greeting: null,
    interests: [],
    card: null,
    cardUrl: null,
    cardFilename: null,
    inContacts: true,
    providerId: null,
    modelOverride: null,
    temperature: null,
    replyStyle: ReplyStyle.Chatty,
    proactive: { enabled: true, minIdleHours: 6, maxPerDay: 1 },
    proactiveMode: 'custom',
    lastProactiveAt: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
}

const baseMessage = {
  id: 'm1',
  conversationId: 'c1',
  senderId: 'u1',
  senderType: 'user' as const,
  type: 'text' as const,
  content: '',
  seq: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

describe('buildChatMessages', () => {
  it('recent 末尾已经包含当前输入时不再重复追加', () => {
    const messages = buildChatMessages({
      persona: persona(),
      facts: [],
      summary: null,
      recent: [{ ...baseMessage, content: '在吗' }],
      userInput: '在吗',
      userName: '阿岚',
    })

    const userLines = messages.filter((m) => m.role === 'user')
    expect(userLines).toHaveLength(1)
    expect(userLines[0]!.content).toBe('在吗')
  })

  it('recent 末尾不是当前输入时仍然补一条 user', () => {
    const messages = buildChatMessages({
      persona: persona(),
      facts: [],
      summary: null,
      recent: [{ ...baseMessage, id: 'm0', content: '早上好' }],
      userInput: '在吗',
      userName: '阿岚',
    })

    const userLines = messages.filter((m) => m.role === 'user')
    expect(userLines.map((m) => m.content)).toEqual(['早上好', '在吗'])
  })

  it('历史里的重复行（两个 nonce）在 prompt 中只保留一条', () => {
    const messages = buildChatMessages({
      persona: persona(),
      facts: [],
      summary: null,
      recent: [
        { ...baseMessage, id: 'a', content: '哈喽', createdAt: 1_700_000_000_000 },
        { ...baseMessage, id: 'b', content: '哈喽', createdAt: 1_700_000_000_050 },
      ],
      userInput: '在吗',
      userName: '阿岚',
    })

    const hello = messages.filter((m) => m.role === 'user' && m.content === '哈喽')
    expect(hello).toHaveLength(1)
  })

  it('带引用时即使内容相同也要保留引用信息', () => {
    const messages = buildChatMessages({
      persona: persona(),
      facts: [],
      summary: null,
      recent: [{ ...baseMessage, content: '在吗' }],
      userInput: '在吗',
      quoted: '昨天那条消息',
      userName: '阿岚',
    })

    const last = messages[messages.length - 1]!
    expect(last.role).toBe('user')
    expect(last.content).toContain('昨天那条消息')
  })

  it('兴趣与角色卡都进入人设段', () => {
    const messages = buildChatMessages({
      persona: persona({ interests: ['独立音乐', '猫'], card: '你住在一间临街旧书店的楼上。' }),
      facts: [],
      summary: null,
      recent: [],
      userInput: '在吗',
      userName: '阿岚',
      now: 1_700_000_000_000,
    })

    const system = messages.map((m) => m.content).join('\n')
    expect(system).toContain('独立音乐')
    expect(system).toContain('旧书店的楼上')
    expect(system).toContain('阿岚')
  })

  it('兴趣与角色卡为空时不产生空段落', () => {
    const messages = buildChatMessages({
      persona: persona(),
      facts: [],
      summary: null,
      recent: [],
      userInput: '在吗',
      userName: '阿岚',
    })

    const joined = messages.map((m) => m.content).join('\n')
    expect(joined).not.toContain('【角色卡】')
    expect(joined).not.toContain('【兴趣】')
  })

  it('角色卡超长时被截断，但平台规则仍在', () => {
    const messages = buildChatMessages({
      persona: persona({ card: '设定'.repeat(4000) }),
      facts: [],
      summary: null,
      recent: [],
      userInput: '在吗',
      userName: '阿岚',
    })

    const joined = messages.map((m) => m.content).join('\n')
    // 规则单独成一条且不参与截断
    expect(messages[0]!.content).toContain('不要用 Markdown 标题')
    expect(joined.length).toBeLessThan(8000 * 2)
  })

  it('顺序为 规则 → 人设 → 本次输入', () => {
    const messages = buildChatMessages({
      persona: persona(),
      facts: [],
      summary: null,
      recent: [],
      userInput: '你好',
      userName: '阿岚',
    })

    expect(messages).toHaveLength(3)
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]!.role).toBe('system')
    expect(messages[2]).toEqual({ role: 'user', content: '你好' })
  })
})

describe('buildProactivePrompt', () => {
  it('主动消息同样带上角色卡与兴趣', () => {
    const messages = buildProactivePrompt({
      persona: persona({ interests: ['深夜写代码'], card: '你有一只叫年糕的橘猫。' }),
      memoryDigest: '对方最近在改一个聊天应用',
      idleHours: 8,
      localTime: '2026-11-16 23:30',
    })

    const system = messages[0]!.content
    expect(system).toContain('年糕')
    expect(system).toContain('深夜写代码')
    expect(system).toContain('主动找对方聊天')

    const user = messages[1]!.content
    expect(user).toContain('8 小时')
    expect(user).toContain('聊天应用')
  })
})

describe('buildMomentCommentPrompt', () => {
  it('带上动态原文与已有评论，并要求可以跳过', () => {
    const messages = buildMomentCommentPrompt({
      persona: persona({ interests: ['独立音乐'] }),
      postAuthor: '阿岚',
      postContent: '今天路过一家旧书店',
      imageCount: 0,
      minutesAgo: 12,
      comments: [{ author: '路人', content: '哪家？', isMine: false }],
      localTime: '2026-11-17 12:00',
    })

    expect(messages[0]!.content).toContain('独立音乐')
    expect(messages[0]!.content).toContain(AI_SKIP_TOKEN)

    const user = messages[1]!.content
    expect(user).toContain('阿岚')
    expect(user).toContain('旧书店')
    expect(user).toContain('路人：哪家？')
    // 没看到图就不要让模型去描述图
    expect(user).not.toContain('张图')
  })
})

describe('buildMomentPostPrompt', () => {
  it('最近动态只作参考，避免重复', () => {
    const messages = buildMomentPostPrompt({
      persona: persona(),
      memoryDigest: '对方在改聊天应用',
      recentMoments: [{ author: '阿岚', content: '今天加班到十点' }],
      localTime: '2026-11-17 12:00',
    })

    const user = messages[1]!.content
    expect(user).toContain('聊天应用')
    expect(user).toContain('今天加班到十点')
    expect(user).toContain('不要重复')
  })
})

describe('buildGroupPrompt', () => {
  it('把「谁在回复谁」写进历史与触发消息', () => {
    const messages = buildGroupPrompt({
      persona: persona(),
      mood: '平静',
      energy: 60,
      groupName: '夜谈会',
      members: [
        { name: '小禾', isSelf: true },
        { name: '阿岚', isSelf: false },
      ],
      recent: [
        {
          speaker: '阿岚',
          content: '那本书我读完了',
          isSelf: false,
          replyTo: { speaker: '小禾', content: '你最近在看什么' },
        },
      ],
      mode: 'reply',
      trigger: {
        speaker: '阿岚',
        content: '你觉得结局怎么样',
        mustReply: false,
        replyTo: { speaker: '小禾', content: '你最近在看什么' },
      },
      localTime: '2026-11-17 21:00',
    })

    const user = messages[1]!.content
    expect(user).toContain('阿岚（回复 小禾「你最近在看什么」）：那本书我读完了')
    expect(user).toContain('这是在回复 小禾')
  })
})

describe('isSkipReply', () => {
  it('识别各种「不想说话」的写法', () => {
    expect(isSkipReply('SKIP')).toBe(true)
    expect(isSkipReply(' skip。')).toBe(true)
    expect(isSkipReply('「SKIP」')).toBe(true)
    expect(isSkipReply('   ')).toBe(true)
  })

  it('正常内容不会被误判成跳过', () => {
    expect(isSkipReply('这家书店我也去过。')).toBe(false)
    expect(isSkipReply('Skip it, 我没什么想说的但还是要说')).toBe(false)
  })
})
