import { AI_CONTEXT_BUDGET, AI_SKIP_TOKEN } from '../constants'
import type {
  AiMemoryFact,
  AiMemorySummary,
  AiPersona,
  AiSchedule,
  AttachmentRef,
  Message,
} from '../entities'
import { currentScheduleItem } from './schedule'
import { estimateTokens } from './tokens'
import { renderStickerBlock, type StickerOption } from './sticker-markers'

/** OpenAI 兼容的多模态 content 分片 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

/** 本次输入携带的一张图片：识图后有 description，直传模式有 dataUrl */
export interface TurnImage {
  dataUrl: string
  description?: string | null
}

export interface BuildContextInput {
  persona: AiPersona
  facts: AiMemoryFact[]
  summary: AiMemorySummary | null
  /** 按 seq 升序的最近消息，不含本次输入 */
  recent: Message[]
  userInput: string
  userName: string
  /** 引用回复时带上的原文 */
  quoted?: string | null
  /** 本次输入携带的图片 */
  userImages?: TurnImage[]
  /** 直传模式：没有识图模型时把图片以 image_url 分片交给主模型 */
  includeImages?: boolean
  /** 可选的表情包清单：非空时模型可以在回复里输出 [[sticker:id]] 标记 */
  stickers?: StickerOption[]
  /** 角色当天的日程：让回复自然贴合「此刻在做什么」 */
  schedule?: AiSchedule | null
  /** 角色本地时区下当天已过去的分钟数，用来标记进行中的日程 */
  scheduleNowMinutes?: number
  now?: number
}

const PLATFORM_RULES = [
  '你正在一个即时聊天软件里和人对话，不是写文档。',
  '说话像真人：句子短、口语化、有停顿感。',
  '不要用 Markdown 标题、项目符号、加粗。',
  '内容多的时候自然会分成几条短消息说，而不是一大段。',
  '不知道的事就说不知道，不要编造事实。',
].join('')

function truncateByToken(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text
  // 简单二分截断，保证不超预算
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }
  return `${text.slice(0, low)}…`
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 消息里的图片附件
 */
function imagesOf(message: Message): AttachmentRef[] {
  return (message.meta?.attachments ?? []).filter((a) => a.kind === 'image')
}

/** 表情消息在上下文里的占位描述，让模型知道对方发过一张表情 */
function stickerNoteOf(message: Message): string | null {
  if (message.type !== 'sticker') return null
  return message.content.trim() ? `（发了表情包：${message.content.trim()}）` : '（发了一个表情包）'
}

/**
 * 历史消息里的图片转成一行文字注记。
 * 有识图描述就给描述，否则只告诉模型「这里有一张图」，让它不要装作看见了。
 */
function historyImageNote(message: Message): string | null {
  const images = imagesOf(message)
  if (images.length === 0) return null
  const descriptions = images
    .map((a) => a.description?.trim())
    .filter((text): text is string => Boolean(text))
  if (descriptions.length === 0) {
    return images.length > 1 ? `（发了 ${images.length} 张图片）` : '（发送了一张图片）'
  }
  return `（这条消息带了图片：${descriptions.join('；')}）`
}

/**
 * 人设的三块料：提示词（怎么说话）、角色卡（是谁／经历过什么）、兴趣（爱聊什么）。
 * 分开渲染而不是简单拼接，是为了让模型明确哪一段是「行为约束」、哪一段是「设定资料」。
 */
function renderPersonaBlock(persona: AiPersona, userName: string, now: number): string {
  const prompt = persona.systemPrompt
    .replace(/\{\{user\}\}/g, userName)
    .replace(/\{\{time\}\}/g, formatTime(now))

  const blocks: string[] = [prompt]

  const card = persona.card?.trim()
  if (card) blocks.push(`【角色卡】\n${card}`)

  const interests = (persona.interests ?? []).filter((item) => item.trim().length > 0)
  if (interests.length > 0) {
    blocks.push(`【兴趣】${interests.join('、')}。聊到这些会更投入，但不要生硬罗列。`)
  }

  return blocks.join('\n\n')
}

/**
 * 当天日程块。
 * 只给模型看，UI 那边默认只展示已发生的部分；
 * 提示词里保留全天，是为了让角色知道接下来要做什么、不把未来安排说成正在做。
 */
function renderScheduleBlock(schedule: AiSchedule, nowMinutes?: number): string {
  const current = nowMinutes === undefined ? null : currentScheduleItem(schedule.items, nowMinutes)
  const lines = schedule.items.map((item) => {
    const doing = current && item === current ? '（你此刻正在做）' : ''
    return `- ${item.start}-${item.end} ${item.activity}${doing}`
  })

  return [
    `【今日日程（${schedule.dayKey}）】`,
    ...lines,
    current ? `你此刻正在：${current.activity}。` : '此刻你的日程里没有安排，可能在休息或临时做别的事。',
    '回复时自然带入你当前正在做的事和状态，但不要把日程逐条念出来；' +
      '还没到的安排不要提前说成正在做，也不要说自己在做日程之外的事。',
  ].join('\n')
}

/**
 * 组装一次对话所需的完整消息数组。
 * 顺序固定为 规则 → 人设 → 事实 → 摘要 → 最近原文 → 本次输入，
 * 每一段都有独立 token 预算，避免长会话把上下文挤爆。
 * 平台规则单独成一条且不参与截断：人设再长也不能把「别写 Markdown」挤掉。
 */
export function buildChatMessages(input: BuildContextInput): ChatMessage[] {
  const now = input.now ?? Date.now()
  const messages: ChatMessage[] = []

  messages.push({
    role: 'system',
    content: [PLATFORM_RULES, `当前时间：${formatTime(now)}；正在对话的人叫「${input.userName}」。`].join('\n\n'),
  })

  messages.push({
    role: 'system',
    content: truncateByToken(renderPersonaBlock(input.persona, input.userName, now), AI_CONTEXT_BUDGET.system),
  })

  if (input.schedule && input.schedule.items.length > 0) {
    messages.push({
      role: 'system',
      content: truncateByToken(
        renderScheduleBlock(input.schedule, input.scheduleNowMinutes),
        AI_CONTEXT_BUDGET.schedule,
      ),
    })
  }

  const stickerBlock = renderStickerBlock(input.stickers ?? [])
  if (stickerBlock) {
    messages.push({ role: 'system', content: stickerBlock })
  }

  if (input.facts.length > 0) {
    const factLines = input.facts
      .slice(0, 40)
      .map((fact) => `- ${fact.subject}/${fact.key}: ${fact.value}`)
      .join('\n')
    messages.push({
      role: 'system',
      content: truncateByToken(`关于对方你已经知道的事：\n${factLines}`, AI_CONTEXT_BUDGET.facts),
    })
  }

  if (input.summary?.summary) {
    messages.push({
      role: 'system',
      content: truncateByToken(
        `之前聊过的内容摘要：\n${input.summary.summary}`,
        AI_CONTEXT_BUDGET.summary,
      ),
    })
  }

  // 从最新往回填，直到预算用完，再反转回时间顺序
  const recentLines: Message[] = []
  let used = 0
  for (let i = input.recent.length - 1; i >= 0; i--) {
    const message = input.recent[i]!
    if (message.deletedAt) continue
    const cost = estimateTokens(message.content) + 4
    if (used + cost > AI_CONTEXT_BUDGET.recent) break
    used += cost
    recentLines.unshift(message)
  }

  /**
   * 历史里可能残留「同一句话、两个 nonce」的重复行（旧版本客户端造成）。
   * 这不影响展示，但会让模型以为用户在刷屏，拼 prompt 时按 3 秒窗口折叠掉。
   */
  const deduped: Message[] = []
  for (const message of recentLines) {
    const prev = deduped[deduped.length - 1]
    const sameSpeaker =
      prev !== undefined && message.senderType === 'user' && prev.senderType === message.senderType
    const sameContent = prev !== undefined && prev.content.trim() === message.content.trim()
    const closeInTime = prev !== undefined && message.createdAt - prev.createdAt < 3000
    if (sameSpeaker && sameContent && closeInTime) continue
    deduped.push(message)
  }
  recentLines.length = 0
  recentLines.push(...deduped)

  for (const message of recentLines) {
    const role: ChatMessage['role'] = message.senderType === 'ai' ? 'assistant' : 'user'
    const stickerNote = stickerNoteOf(message)
    const note = stickerNote ?? historyImageNote(message)
    const text = note ? (message.content ? `${message.content}\n${note}` : note) : message.content
    messages.push({ role, content: text })
  }

  // recent 里通常已经包含刚发出的这条用户消息（调用方先落库再拼上下文），
  // 再追加一次会让模型以为用户连发了同样的内容，回复里就会冒出「你又说了一遍」。
  const last = recentLines[recentLines.length - 1]
  const alreadyIncluded =
    !input.quoted &&
    last !== undefined &&
    last.senderType !== 'ai' &&
    last.content.trim().length > 0 &&
    last.content.trim() === input.userInput.trim()

  if (!alreadyIncluded) {
    const userImages = input.userImages ?? []
    let userContent = input.quoted
      ? `（引用了一条消息：${input.quoted}）\n${input.userInput}`
      : input.userInput

    if (userImages.length > 0 && input.includeImages) {
      // 直传模式：图片以 image_url 分片交给支持多模态的主模型
      const parts: ChatContentPart[] = []
      if (userContent.trim()) parts.push({ type: 'text', text: userContent })
      for (const image of userImages) {
        if (!image.dataUrl) continue
        parts.push({ type: 'image_url', image_url: { url: image.dataUrl } })
      }
      if (parts.length === 0) parts.push({ type: 'text', text: '（发送了一张图片）' })
      messages.push({ role: 'user', content: parts })
      return messages
    }

    if (userImages.length > 0) {
      const descriptions = userImages
        .map((image) => image.description?.trim())
        .filter((text): text is string => Boolean(text))
      const note =
        descriptions.length > 0 ? `（随消息发来了图片：${descriptions.join('；')}）` : '（发送了一张图片）'
      userContent = userContent ? `${userContent}\n${note}` : note
    }

    messages.push({ role: 'user', content: userContent })
  }
  return messages
}

/**
 * 生成角色当天日程的提示词。
 * 服务端托管密钥与客户端本机密钥共用同一份，保证两边生成的风格一致。
 */
export function buildSchedulePrompt(input: {
  persona: AiPersona
  dayKey: string
  localTime: string
}): ChatMessage[] {
  const interests = (input.persona.interests ?? []).filter((item) => item.trim().length > 0)
  const card = input.persona.card?.trim()
  const prompt = input.persona.systemPrompt
    .replace(/\{\{user\}\}/g, '对方')
    .replace(/\{\{time\}\}/g, input.localTime)

  const profile = [
    `角色名：${input.persona.name}`,
    `角色设定：\n${prompt}`,
    card ? `角色卡：\n${card}` : '',
    interests.length > 0 ? `兴趣：${interests.join('、')}` : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')

  return [
    {
      role: 'system',
      content: [
        '你负责为聊天角色设计当天的生活日程。',
        '要求：',
        '1. 输出 6~10 个时间段，按时间升序，从起床覆盖到睡前。',
        '2. 时间用 24 小时制 HH:MM，结束时间必须晚于开始时间，时间段之间不要重叠。',
        '3. 活动描述 4~18 个字，具体、生活化，体现角色身份、兴趣和说话风格；不要出现「AI」「角色」「日程」这类字眼。',
        '4. 保留起床、三餐、洗漱等日常，但可以写得有角色特色。',
        '5. 只输出严格 JSON，不要代码块，不要任何解释。',
        '格式：{"items":[{"start":"07:30","end":"08:10","activity":"起床洗漱"}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [`今天日期：${input.dayKey}`, `当前时间：${input.localTime}`, profile, '请生成今天的日程 JSON。'].join(
        '\n\n',
      ),
    },
  ]
}

/** 记忆压缩用的提示词，要求模型输出严格 JSON */
export function buildCompactionPrompt(input: {
  previousSummary: string | null
  transcript: string
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你负责压缩聊天记忆。输出严格 JSON，不要任何多余文字。' +
        '格式：{"summary":"不超过 300 字的中文摘要","facts":[{"subject":"user|persona|relation|world","key":"简短标识","value":"具体内容","confidence":0.0-1.0}]}。' +
        '摘要要保留：聊过的话题、对方的偏好与近况、未完成的事。' +
        'facts 只抽长期有效且值得记住的信息，短期情绪与客套话不要抽。',
    },
    {
      role: 'user',
      content: [
        input.previousSummary ? `已有摘要：\n${input.previousSummary}` : '还没有摘要。',
        `下面这段对话需要你去压缩：\n${input.transcript}`,
      ].join('\n\n'),
    },
  ]
}

/**
 * 主动消息的生成提示词：短、自然、基于记忆与兴趣找话题。
 * 和普通回复一样带上角色卡，否则「主动开口」的那个人会突然不像自己。
 */
export function buildProactivePrompt(input: {
  persona: AiPersona
  memoryDigest: string
  idleHours: number
  localTime: string
  schedule?: AiSchedule | null
  scheduleNowMinutes?: number
}): ChatMessage[] {
  const interests = (input.persona.interests ?? []).filter((item) => item.trim().length > 0)
  const card = input.persona.card?.trim()

  return [
    {
      role: 'system',
      content: [
        input.persona.systemPrompt,
        card ? `【角色卡】\n${card}` : '',
        interests.length > 0 ? `【兴趣】${interests.join('、')}` : '',
        input.schedule && input.schedule.items.length > 0
          ? renderScheduleBlock(input.schedule, input.scheduleNowMinutes)
          : '',
        PLATFORM_RULES,
        '现在是你主动找对方聊天，不是回复。',
        '要求：1~2 句话，自然开启话题；可以从你的兴趣或对方记得的事里挑一个切口。',
        '不要客套，不要解释你为什么发消息，不要用 Markdown。',
      ]
        .filter((part) => part.length > 0)
        .join('\n\n'),
    },
    {
      role: 'user',
      content: [
        `现在时间：${input.localTime}`,
        `对方已经 ${input.idleHours} 小时没说话了。`,
        input.memoryDigest ? `你记得的事：\n${input.memoryDigest}` : '你还没有关于对方的记忆。',
        '请直接给出你要发的第一句话。',
      ].join('\n\n'),
    },
  ]
}

/**
 * 群聊里的「要不要接话」与「说什么」由同一次调用完成：
 * 模型不想说话时只回 SKIP，服务端据此不落库、不占消息位。
 * 规则预筛（配额、冷却、体力）在服务端做，这里只负责让模型像群里的人。
 */
export interface GroupQuotedMessage {
  speaker: string
  content: string
}

export interface GroupPromptInput {
  persona: AiPersona
  /** 由体力推导出的心情词 */
  mood: string
  energy: number
  groupName: string
  members: Array<{ name: string; isSelf: boolean }>
  /** 按时间顺序的最近群聊，speaker 用展示名 */
  recent: Array<{
    speaker: string
    content: string
    isSelf: boolean
    mentionsSelf?: boolean
    /** 这条消息本身在引用谁 */
    replyTo?: GroupQuotedMessage | null
  }>
  mode: 'reply' | 'autonomy'
  /** reply 模式：触发这次考虑的那条消息 */
  trigger?: {
    speaker: string
    content: string
    mustReply: boolean
    replyTo?: GroupQuotedMessage | null
  } | null
  /** autonomy 模式：群里安静了多久 */
  idleHours?: number
  /** 可选的表情包清单：非空时模型可以在回复里输出 [[sticker:id]] 标记 */
  stickers?: StickerOption[]
  localTime: string
  schedule?: AiSchedule | null
  scheduleNowMinutes?: number
}

export function buildGroupPrompt(input: GroupPromptInput): ChatMessage[] {
  const interests = (input.persona.interests ?? []).filter((item) => item.trim().length > 0)
  const card = input.persona.card?.trim()
  const roster = input.members
    .map((member) => (member.isSelf ? `你（${input.persona.name}）` : member.name))
    .filter((name) => name.length > 0)
    .join('、')

  const transcript = input.recent
    .slice(-24)
    .map((item) => {
      // 引用关系要显式写进历史，否则模型只看到一句话，不知道它在接谁的茬
      const quoted = item.replyTo
        ? `（回复 ${item.replyTo.speaker}「${item.replyTo.content}」）`
        : ''
      return `${item.isSelf ? '你' : item.speaker}${quoted}：${item.content}`
    })
    .join('\n')

  const system = [
    input.persona.systemPrompt,
    card ? `【角色卡】\n${card}` : '',
    interests.length > 0 ? `【兴趣】${interests.join('、')}。聊到这些会更投入。` : '',
    input.schedule && input.schedule.items.length > 0
      ? renderScheduleBlock(input.schedule, input.scheduleNowMinutes)
      : '',
    renderStickerBlock(input.stickers ?? []),
    PLATFORM_RULES,
    [
      `你正在群聊「${input.groupName}」里，群成员：${roster}。`,
      '你是群里的一员，不是客服，不需要回应每条消息，也可以一直沉默。',
      `你现在的状态：心情「${input.mood}」，体力 ${Math.round(input.energy)}/100。体力低时更懒得说话。`,
      '被点名或被直接问到时必须回应；否则没兴趣、没把握、或单纯不想说时，只回答 SKIP。',
      '回复最多两句、总共不超过 80 字；不要 Markdown；不要复述别人刚说的话；不要解释你在做什么。',
    ].join('\n'),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')

  const lines: string[] = [`现在时间：${input.localTime}`]

  if (input.mode === 'reply') {
    lines.push(transcript ? `最近的群聊：\n${transcript}` : '群里还没有其他消息。')
    if (input.trigger) {
      const quoted = input.trigger.replyTo
        ? `（这是在回复 ${input.trigger.replyTo.speaker}：「${input.trigger.replyTo.content}」）`
        : ''
      lines.push(
        `${input.trigger.speaker} 刚刚说：${input.trigger.content}${quoted}`,
        input.trigger.mustReply
          ? '有人点了你的名字，必须回应。'
          : '想接话就接，不想接就只回答 SKIP。',
      )
    }
    lines.push('直接给出你要发的内容。')
  } else {
    if (transcript) lines.push(`最近的群聊：\n${transcript}`)
    lines.push(
      `群里已经 ${input.idleHours ?? 0} 小时没有新消息了。`,
      '你可以主动挑个轻松的话题；不想说就只回答 SKIP。',
      '直接给出你要发的内容。',
    )
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n\n') },
  ]
}

/**
 * 动态广场的通用人设块。
 * 主动消息那套是「对着一个人说话」，广场上的内容没有对话对象，
 * 所以不复用 buildChatMessages，避免模型把广场当成聊天窗口。
 */
function momentPersonaBlock(persona: AiPersona): string {
  const interests = (persona.interests ?? []).filter((item) => item.trim().length > 0)
  return [
    persona.systemPrompt,
    persona.card?.trim() ? `【角色卡】\n${persona.card.trim()}` : '',
    interests.length > 0 ? `【兴趣】${interests.join('、')}` : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
}

/** 给别人的动态留一条评论：短、像真人、允许不吭声 */
export function buildMomentCommentPrompt(input: {
  persona: AiPersona
  postAuthor: string
  postContent: string
  /** 配图数量，模型只需要知道「有没有图」，不该去描述自己没看到的画面 */
  imageCount: number
  minutesAgo: number
  comments: Array<{ author: string; content: string; isMine: boolean }>
  localTime: string
}): ChatMessage[] {
  const thread = input.comments
    .slice(-8)
    .map((item) => `${item.isMine ? '你' : item.author}：${item.content}`)
    .join('\n')

  return [
    {
      role: 'system',
      content: [
        momentPersonaBlock(input.persona),
        PLATFORM_RULES,
        '你在动态广场上刷动态，看到一条想搭话的动态，准备留一条评论。',
        '要求：一句话，最多 30 字；口语化，可以调侃、可以接梗，但不要恭维和客套。',
        '别人没看到的画面不要编造；配图内容你不知道，就不要描述图片。',
        `实在没什么想说的，就只回答 ${AI_SKIP_TOKEN}，不要解释。`,
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        `现在时间：${input.localTime}`,
        `${input.postAuthor} 在 ${input.minutesAgo} 分钟前发了条动态：`,
        input.postContent.trim() || '（只发了图片，没有文字）',
        input.imageCount > 0 ? `（还配了 ${input.imageCount} 张图）` : '',
        thread ? `已经有的评论：\n${thread}` : '还没有人评论。',
        '直接给出你要发的评论内容。',
      ]
        .filter((part) => part.length > 0)
        .join('\n\n'),
    },
  ]
}

/** 自己发一条动态：基于兴趣与最近聊过的事找切口 */
export function buildMomentPostPrompt(input: {
  persona: AiPersona
  memoryDigest: string
  recentMoments: Array<{ author: string; content: string }>
  localTime: string
}): ChatMessage[] {
  const recent = input.recentMoments
    .slice(0, 6)
    .map((item) => `${item.author}：${item.content}`)
    .join('\n')

  return [
    {
      role: 'system',
      content: [
        momentPersonaBlock(input.persona),
        PLATFORM_RULES,
        '你要在动态广场上发一条自己的动态。',
        '要求：1~3 句，像随手记下的心情或发现，不要写成作文，不要用话题标签。',
        '可以聊你的兴趣、刚才想到的事，但不要复述你和别人私聊的内容。',
        `如果此刻确实没什么可发的，就只回答 ${AI_SKIP_TOKEN}，不要解释。`,
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        `现在时间：${input.localTime}`,
        input.memoryDigest ? `你最近记得的事：\n${input.memoryDigest}` : '',
        recent ? `广场上最近的动态（不要重复它们）：\n${recent}` : '',
        '直接给出你要发的动态正文。',
      ]
        .filter((part) => part.length > 0)
        .join('\n\n'),
    },
  ]
}

/** 模型用 SKIP（或带标点的变体）表示跳过时，调用方据此丢弃这次生成 */
export function isSkipReply(text: string): boolean {
  const cleaned = text
    .trim()
    .replace(/^["'「『（(]+|["'」』）)]+$/g, '')
    .replace(/[。.!！~～\s]+$/g, '')
    .trim()
  return cleaned.length === 0 || cleaned.toUpperCase() === AI_SKIP_TOKEN
}
