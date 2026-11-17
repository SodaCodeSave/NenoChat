import { describe, expect, it } from 'vitest'
import { AI_SKIP_TOKEN } from '../constants'
import type { AiMemoryFact, AiMemorySummary, AiPersona, AiSchedule } from '../entities'
import { ReplyStyle } from '../enums'
import {
  buildChatMessages,
  buildGroupPrompt,
  buildMomentCommentPrompt,
  buildMomentPostPrompt,
  buildProactivePrompt,
  isSkipReply,
} from './prompt'
import type { StickerOption } from './sticker-markers'

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

    // 末尾固定是时间戳 system，引用内容在它前面那条 user 消息里
    const lastUser = messages[messages.length - 2]!
    expect(lastUser.role).toBe('user')
    expect(lastUser.content).toContain('昨天那条消息')
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

  it('顺序为 规则+名字 → 人设 → 本次输入 → 时间戳，时间戳不在前部', () => {
    const messages = buildChatMessages({
      persona: persona(),
      facts: [],
      summary: null,
      recent: [],
      userInput: '你好',
      userName: '阿岚',
      now: 1_700_000_000_000,
    })

    expect(messages).toHaveLength(4)
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('正在对话的人叫「阿岚」')
    // 分钟级时间戳一旦出现在前部，前缀缓存立即失效，首条 system 不允许出现
    expect(messages[0]!.content).not.toContain('当前时间')
    expect(messages[1]!.role).toBe('system')
    expect(messages[2]).toEqual({ role: 'user', content: '你好' })
    // 时间戳固定是最后一条消息，之后不再有任何字节
    expect(messages[3]!.role).toBe('system')
    expect(messages[3]!.content).toMatch(/^当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('连续两轮提示词前缀字节级一致（前缀缓存回归）', () => {
    // 两轮共享的稳定块：人设 / 事实 / 摘要 / 表情包 / 日程全部相同
    const facts: AiMemoryFact[] = [
      {
        id: 'f1',
        conversationId: 'c1',
        subject: 'user',
        key: '职业',
        value: '程序员',
        confidence: 0.9,
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const summary: AiMemorySummary = {
      id: 's1',
      conversationId: 'c1',
      fromSeq: 1,
      toSeq: 10,
      summary: '之前聊过工作和猫。',
      tokenEstimate: 20,
      createdAt: 0,
    }
    const stickers: StickerOption[] = [{ id: 'stk1', tags: ['开心'] }]
    const schedule: AiSchedule = {
      personaId: 'p1',
      dayKey: '2026-11-17',
      items: [
        { start: '09:00', end: '12:00', activity: '写代码' },
        { start: '13:00', end: '18:00', activity: '改 bug' },
      ],
      source: 'manual',
      updatedAt: 0,
    }
    const stablePersona = persona({ interests: ['独立音乐'], card: '你住在一间临街旧书店的楼上。' })

    // 第一轮：还没有历史，用户说了第一句话
    const turn1 = buildChatMessages({
      persona: stablePersona,
      facts,
      summary,
      stickers,
      schedule,
      scheduleNowMinutes: 600,
      recent: [],
      userInput: '今天好累',
      userName: '阿岚',
      now: 1_700_000_000_000,
    })

    // 第二轮：第一轮的输入已落库进入历史，用户又发了一句，时间已经过去
    const turn2 = buildChatMessages({
      persona: stablePersona,
      facts,
      summary,
      stickers,
      schedule,
      scheduleNowMinutes: 600,
      recent: [
        { ...baseMessage, id: 'm1', content: '今天好累', createdAt: 1_700_000_000_000 },
        {
          ...baseMessage,
          id: 'm2',
          senderType: 'ai',
          content: '怎么了，还好吗',
          createdAt: 1_700_000_000_100,
        },
        { ...baseMessage, id: 'm3', content: '想听歌', createdAt: 1_700_000_000_200 },
      ],
      userInput: '想听歌',
      userName: '阿岚',
      now: 1_700_006_000_000,
    })

    // (a) 首条 system（规则+对方名字）两轮字节级一致
    expect(turn1[0]).toEqual(turn2[0])
    // (b) 稳定头部（人设/事实/摘要/表情包/日程）逐条字节级一致
    const stableHeadLength = turn1.length - 2 // 去掉末尾时间戳与本次输入后，剩下的稳定系统块
    for (let i = 1; i < stableHeadLength; i++) {
      expect(turn2[i]).toEqual(turn1[i]!)
    }
    // (c) 每轮最后一条都是当前时间 system，且两轮时间不同
    expect(turn1[turn1.length - 1]!.role).toBe('system')
    expect(turn2[turn2.length - 1]!.role).toBe('system')
    expect(turn1[turn1.length - 1]!.content).toMatch(/^当前时间：/)
    expect(turn2[turn2.length - 1]!.content).toMatch(/^当前时间：/)
    expect(turn2[turn2.length - 1]!.content).not.toBe(turn1[turn1.length - 1]!.content)
    // (d) 第二轮去掉时间戳后的完整序列，是第一轮去掉时间戳序列的超集：
    // 公共前缀一路延伸进历史消息，新消息只追加在尾部
    const head1 = turn1.slice(0, -1)
    expect(turn2.slice(0, head1.length)).toEqual(head1)
    expect(turn2.length).toBeGreaterThan(turn1.length)
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

  it('日程属于易变内容，只出现在 user 行，system 保持稳定', () => {
    const messages = buildProactivePrompt({
      persona: persona(),
      memoryDigest: '',
      idleHours: 3,
      localTime: '2026-11-17 10:00',
      schedule: {
        personaId: 'p1',
        dayKey: '2026-11-17',
        items: [{ start: '09:00', end: '12:00', activity: '写代码' }],
        source: 'manual',
        updatedAt: 0,
      },
      scheduleNowMinutes: 600,
    })

    expect(messages[0]!.content).not.toContain('今日日程')
    expect(messages[1]!.content).toContain('你此刻正在：写代码')
    expect(messages[1]!.content).toContain('现在时间：')
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
    // 心情/体力/日程都是每轮会变的内容，只在 user 行出现，system 保持字节级稳定
    const system = messages[0]!.content
    expect(system).not.toContain('心情「平静」')
    expect(system).not.toContain('今日日程')
    expect(user).toContain('心情「平静」')
    expect(user).toContain('体力 60/100')
    expect(user).toContain('现在时间：')
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
