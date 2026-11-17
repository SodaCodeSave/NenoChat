import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  buildChatMessages,
  buildBilibiliSummaryPrompt,
  buildPageSummaryPrompt,
  buildCompactionPrompt,
  buildGroupPrompt,
  buildMomentCommentPrompt,
  buildMomentPostPrompt,
  buildProactivePrompt,
  buildSchedulePrompt,
  cutStreamingSegments,
  dayKeyOf,
  estimateTokens,
  extractUrls,
  findBilibiliInput,
  isBilibiliUrl,
  isSkipReply,
  minutesOfLocalDay,
  parseScheduleItems,
  renderBilibiliContext,
  renderFetchedPagesContext,
  segmentDelay,
  SEGMENT_REPLY_DEFAULTS,
  splitSegments,
  renderWebSearchContext,
  shouldSearchWeb,
  stickerOptionsFromPacks,
  stripStickerMarkers,
  ulid,
  type AiGlobalSettings,
  type AiMemoryFact,
  type AiMemorySummary,
  type AiPersona,
  type AiProvider,
  type AiSchedule,
  type AiScheduleItem,
  type AttachmentRef,
  type ChatMessage,
  type ConnectorActionMeta,
  type Message,
  type SegmentRule,
  type TurnImage,
} from '@nenochat/shared'
import { aiApi } from '@/api/ai'
import { connectorApi } from '@/api/connectors'
import { resolveFileUrl } from '@/api/http'
import { conversationApi, messageApi } from '@/api/endpoints'
import { postApi } from '@/api/posts'
import { messagePreview } from '@/composables/conversation'
import { listPersonas, upsertPersona as upsertPersonaRow } from '@/db/dao/ai'
import { hasLocalDb } from '@/platform/db'
import { isTauri } from '@/platform/device'
import { loadProviderKey } from '@/platform/ai-keys'
import { useAuthStore } from './auth'
import { useConversationsStore } from './conversations'
import { useMessagesStore } from './messages'
import { useServersStore } from './servers'
import { useStickersStore } from './stickers'

interface StreamDelta {
  generation_id: string
  delta: string
}

interface StreamDone {
  generation_id: string
  prompt_tokens: number | null
  completion_tokens: number | null
  cached_tokens: number | null
  model: string | null
}

interface StreamError {
  generation_id: string
  message: string
}

/** Rust ai_complete 的返回：正文 + 真实用量 */
interface AiCompleteResult {
  content: string
  usage: {
    prompt_tokens: number | null
    completion_tokens: number | null
    cached_tokens: number | null
  } | null
}

const MEMORY_COMPACT_THRESHOLD = 20

/**
 * rAF 合帧：把逐 token 的流式增量收敛到每帧最多一次响应式写入。
 * 每个 token 都重建消息对象会让消息列表对着 ~300 行重算一遍布局；
 * 没有 rAF 的环境（单测）退化为 16ms 定时器。
 */
function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(callback, 16) as unknown as number
}

function cancelFrame(handle: number | null): void {
  if (handle == null) return
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
}

/** 识图提示词：描述结果会作为文字注记进入主模型提示词 */
const VISION_PROMPT =
  '请客观描述这张图片的内容：主体、场景、画面里的文字等关键信息。' +
  '不超过 120 字，这段描述会交给另一个无法看图的 AI 用于回复用户。' +
  '直接输出描述正文，不要任何开场白或解释。'

/**
 * AI 会话编排。
 * 密钥在本机时走 Rust 流式网关（真正的逐字打字感），
 * 密钥托管在服务端时由服务端生成：开了流式就逐字推送，
 * 开了分段就切好一段发一段，均通过 WS 事件实时驱动界面。
 */
export const useAiStore = defineStore('ai', () => {
  const providers = ref<AiProvider[]>([])
  const personas = ref<AiPersona[]>([])
  const globalSettings = ref<AiGlobalSettings | null>(null)
  /** 角色列表的加载状态：load 守卫用，服务端拉取成功才算 loaded */
  const loading = ref(false)
  const loaded = ref(false)
  const streaming = ref<Record<string, { generationId: string; text: string }>>({})
  const generating = ref<Record<string, boolean>>({})
  /** 生成中正在执行的连接器动作（B 站 / 抓网页 / 搜索），用于占位气泡的实时提示 */
  const connectorLive = ref<Record<string, ConnectorActionMeta['kind'] | null>>({})
  const lastError = ref<string | null>(null)

  const auth = useAuthStore()
  const messages = useMessagesStore()
  const conversations = useConversationsStore()

  const providerById = computed(() => new Map(providers.value.map((p) => [p.id, p])))
  const personaById = computed(() => new Map(personas.value.map((p) => [p.id, p])))

  /** 记录/清除某会话正在执行的连接器动作；kind 传 null 表示结束 */
  function setConnectorLive(conversationId: string, kind: ConnectorActionMeta['kind'] | null): void {
    if (kind) connectorLive.value = { ...connectorLive.value, [conversationId]: kind }
    else delete connectorLive.value[conversationId]
  }

  /* ------------------------------- 角色日程 ------------------------------- */

  /** 内存里的当天日程：按 personaId + dayKey 缓存，不落本地库 */
  const schedules = ref<Record<string, AiSchedule>>({})
  const schedulePending = new Map<string, Promise<AiSchedule | null>>()

  function scheduleKeyOf(personaId: string, dayKey: string): string {
    return `${personaId}:${dayKey}`
  }

  function cachedSchedule(personaId: string, dayKey = dayKeyOf()): AiSchedule | null {
    return schedules.value[scheduleKeyOf(personaId, dayKey)] ?? null
  }

  function rememberSchedule(schedule: AiSchedule): AiSchedule {
    schedules.value = { ...schedules.value, [scheduleKeyOf(schedule.personaId, schedule.dayKey)]: schedule }
    return schedule
  }

  /** 本机密钥：用角色自己的服务商生成当天日程并回传保存 */
  async function generateScheduleLocally(
    persona: AiPersona,
    dayKey: string,
  ): Promise<AiSchedule> {
    if (!isTauri()) throw new Error('本机密钥需要桌面客户端生成日程')
    const provider = providerOf(persona)
    if (!provider) throw new Error('还没有配置 AI 服务商')
    // 服务端已判定需要本机生成，这里再确认一次密钥确实在本机
    if (provider.keyLocation !== 'local') {
      throw new Error('当前角色使用的是云端密钥，日程应由服务端生成，请稍后重试')
    }
    const apiKey = await loadProviderKey(provider.id)
    if (!apiKey) throw new Error('本机没有找到该服务商的密钥，请到设置里重新填写')

    const result = await invoke<AiCompleteResult>('ai_complete', {
      baseUrl: provider.baseUrl,
      apiKey,
      model: persona.modelOverride ?? provider.model,
      messages: buildSchedulePrompt({
        persona,
        dayKey,
        localTime: new Date().toLocaleString(),
      }),
      temperature: 0.8,
      maxTokens: 800,
      jsonMode: true,
    })

    const items = parseScheduleItems(result.content)
    if (items.length === 0) throw new Error('日程生成失败，请重试')

    reportUsage({
      personaId: persona.id,
      providerId: provider.id,
      kind: 'schedule',
      model: persona.modelOverride ?? provider.model,
      usage: result.usage,
    })

    const saved = await aiApi.saveSchedule(persona.id, { dayKey, items, source: 'ai' })
    return rememberSchedule(saved.schedule)
  }

  /**
   * 确保某个角色当天有日程。
   * 已缓存直接返回；服务端托管密钥由服务端生成；本机密钥在客户端生成后回传。
   */
  async function ensureSchedule(
    personaId: string,
    options: { dayKey?: string; force?: boolean } = {},
  ): Promise<AiSchedule | null> {
    const persona = personaById.value.get(personaId)
    if (!persona) return null
    const dayKey = options.dayKey ?? dayKeyOf()

    if (!options.force) {
      const cached = cachedSchedule(personaId, dayKey)
      if (cached) return cached
    }

    const key = scheduleKeyOf(personaId, dayKey)
    const pending = schedulePending.get(key)
    if (pending) return pending

    const task = (async (): Promise<AiSchedule | null> => {
      try {
        const result = options.force
          ? await aiApi.regenerateSchedule(personaId, dayKey)
          : await aiApi.ensureSchedule(personaId, dayKey)
        if (result.schedule) return rememberSchedule(result.schedule)
        if (result.needsClientGeneration) return await generateScheduleLocally(persona, dayKey)
        return cachedSchedule(personaId, dayKey)
      } catch (e) {
        // 手动重新生成失败要明确报错；自动补日程失败则回退到已有内容
        if (options.force) throw e
        const cached = cachedSchedule(personaId, dayKey)
        if (cached) return cached
        throw e
      } finally {
        schedulePending.delete(key)
      }
    })()

    schedulePending.set(key, task)
    return task
  }

  /** 手动保存当天日程（面板编辑） */
  async function saveScheduleItems(
    personaId: string,
    dayKey: string,
    items: AiScheduleItem[],
  ): Promise<AiSchedule> {
    const result = await aiApi.saveSchedule(personaId, { dayKey, items, source: 'manual' })
    return rememberSchedule(result.schedule)
  }

  /** 分段规则以全局设置为准；离线读不到设置时退回默认规则 */
  function currentSegmentRule(): SegmentRule {
    const settings = globalSettings.value
    return {
      enabled: settings?.segmentEnabled ?? SEGMENT_REPLY_DEFAULTS.enabled,
      pattern: settings?.segmentPattern ?? SEGMENT_REPLY_DEFAULTS.pattern,
    }
  }

  /** 调试开关：全局设置里的 debugMode */
  function debugEnabled(): boolean {
    return globalSettings.value?.debugMode ?? false
  }

  /** 本机代跑的真实 usage 上报服务端；失败静默，调试数据不影响主流程 */
  function reportUsage(input: {
    conversationId?: string
    personaId?: string
    providerId?: string
    kind:
      | 'chat'
      | 'group_reply'
      | 'group_autonomy'
      | 'proactive'
      | 'moment'
      | 'schedule'
      | 'summary'
      | 'vision'
    refId?: string
    model?: string
    usage: AiCompleteResult['usage']
  }): void {
    if (!input.usage || input.usage.prompt_tokens == null) return
    void aiApi
      .reportUsage({
        conversationId: input.conversationId,
        personaId: input.personaId,
        providerId: input.providerId,
        kind: input.kind,
        refId: input.refId,
        model: input.model,
        promptTokens: input.usage.prompt_tokens ?? 0,
        completionTokens: input.usage.completion_tokens ?? 0,
        cachedTokens: input.usage.cached_tokens ?? 0,
      })
      .catch(() => undefined)
  }

  /** 全局自动互动设置；读取失败时保持 null，界面按默认值渲染 */
  async function loadSettings(): Promise<void> {
    try {
      const result = await aiApi.settings()
      globalSettings.value = result.settings
    } catch {
      /* 离线或老服务端：先不显示 */
    }
  }

  async function saveSettings(patch: Partial<Omit<AiGlobalSettings, 'updatedAt'>>): Promise<void> {
    // 先本地生效，避免开关回弹；服务端失败再用返回值纠正
    const current = globalSettings.value
    if (current) globalSettings.value = { ...current, ...patch }
    try {
      const result = await aiApi.updateSettings(patch)
      globalSettings.value = result.settings
    } catch {
      await loadSettings()
      throw new Error('保存全局设置失败')
    }
  }

  async function load(force = false): Promise<void> {
    // 通讯录与新建聊天每次打开都会调 load，不做守卫的话每次都白拉 3 个接口并重写角色镜像；
    // 保存角色后的手动刷新传 force。离线时不标记 loaded，联网后再拉。
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    try {
      // 先出本地镜像（断网也有角色列表），再拉服务端覆盖
      if (hasLocalDb()) {
        const sid = useServersStore().currentId ?? ''
        if (sid) {
          const local = await listPersonas(sid)
          if (local.length > 0) personas.value = local
        }
      }

      try {
        const [providerResult, personaResult] = await Promise.all([
          aiApi.providers(),
          aiApi.personas(),
          loadSettings(),
        ])
        providers.value = providerResult.providers
        personas.value = personaResult.personas

        if (hasLocalDb()) {
          const sid = useServersStore().currentId ?? ''
          if (sid) {
            for (const persona of personaResult.personas) {
              await upsertPersonaRow(sid, persona)
            }
          }
        }
        loaded.value = true
      } catch {
        /* 离线：保留本地镜像，下次打开再拉 */
      }
    } finally {
      loading.value = false
    }
  }

  /** sync 落库后同步内存，避免通讯录与角色列表要等下一次 load */
  function upsertLocal(persona: AiPersona): void {
    const index = personas.value.findIndex((p) => p.id === persona.id)
    if (index >= 0) personas.value[index] = { ...personas.value[index], ...persona }
    else personas.value = [...personas.value, persona]
  }

  function removeLocal(personaId: string): void {
    personas.value = personas.value.filter((p) => p.id !== personaId)
  }

  function personaOf(conversationId: string): AiPersona | null {
    const conversation = conversations.byId.get(conversationId)
    if (!conversation?.aiPersonaId) return null
    return personaById.value.get(conversation.aiPersonaId) ?? null
  }

  function providerOf(persona: AiPersona | null): AiProvider | null {
    if (!persona) return null
    return (
      (persona.providerId ? providerById.value.get(persona.providerId) : undefined) ??
      providers.value.find((p) => p.isDefault) ??
      providers.value[0] ??
      null
    )
  }

  function streamTextOf(conversationId: string): string {
    // 表情标记落库时才拆成真正的表情消息，打字气泡里不能露出原始标记
    return stripStickerMarkers(streaming.value[conversationId]?.text ?? '')
  }

  function isGenerating(conversationId: string): boolean {
    return Boolean(generating.value[conversationId])
  }

  async function collectContext(
    conversationId: string,
    persona: AiPersona,
    userInput: string,
    currentMessageId?: string,
    quoted?: string | null,
    images?: TurnImage[],
    includeImages?: boolean,
    provider?: AiProvider | null,
    apiKey?: string | null,
  ): Promise<{
    chat: ChatMessage[]
    memories: { summaries: AiMemorySummary[]; facts: AiMemoryFact[] }
    /** 成功执行的连接器动作，随消息 meta 落库供界面展示 */
    connectorActions: ConnectorActionMeta[]
  }> {
    let memories: { summaries: AiMemorySummary[]; facts: AiMemoryFact[] } = { summaries: [], facts: [] }
    try {
      memories = await aiApi.memory(conversationId)
    } catch {
      /* 记忆读取失败不阻断对话 */
    }

    // 当前这句由 buildChatMessages 追加，先把它从 recent 里排除，避免出现两次
    const recent = messages
      .messagesOf(conversationId)
      .filter((message) => message.id !== currentMessageId)
      .slice(-60)

    // 日程只影响角色「此刻是谁」，取不到就照常回复
    const schedule = await ensureSchedule(persona.id).catch(() => null)

    /**
     * 本机密钥模式下服务端不参与生成，连接器资料在这里取好再注入；
     * 任何一步失败都不影响回复。
     */
    const contextBlocks: string[] = []

    /** 本机密钥复用于 B 站/网页正文的总结，失败返回 null */
    const summarizeLocally = async (prompt: string, refId: string): Promise<string | null> => {
      if (!provider || !apiKey) return null
      const model = persona.modelOverride ?? provider.model
      try {
        const result = await invoke<AiCompleteResult>('ai_complete', {
          baseUrl: provider.baseUrl,
          apiKey,
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          maxTokens: 900,
          jsonMode: false,
        })
        reportUsage({
          conversationId,
          personaId: persona.id,
          providerId: provider.id,
          kind: 'summary',
          refId,
          model,
          usage: result.usage,
        })
        return result.content.trim()
      } catch {
        return null
      }
    }

    const connectorActions: ConnectorActionMeta[] = []

    const videoInput = findBilibiliInput(userInput)
    if (videoInput) {
      try {
        setConnectorLive(conversationId, 'bilibili')
        const { material } = await connectorApi.prepareBilibili(videoInput)
        // 服务端没有缓存时用本机密钥总结一次，结果回传服务端按视频去重
        if (!material.summary?.trim()) {
          const summary = await summarizeLocally(
            buildBilibiliSummaryPrompt(material),
            material.cacheKey,
          )
          if (summary) {
            material.summary = summary
            void connectorApi
              .saveBilibiliSummary({
                videoId: material.cacheKey,
                summary,
                model: persona.modelOverride ?? provider?.model,
              })
              .catch(() => undefined)
          }
        }
        contextBlocks.push(renderBilibiliContext(material))
        connectorActions.push({ kind: 'bilibili', detail: material.video.title })
      } catch {
        /* 抓取失败不注入 */
      } finally {
        setConnectorLive(conversationId, null)
      }
    }

    // 只抓当前这条用户消息里的非 B 站链接，最多 3 条；单条失败不影响其他链接
    let connectorFetchContext: string | null = null
    const pageUrls = extractUrls(userInput)
      .filter((url) => !isBilibiliUrl(url))
      .slice(0, 3)
    if (pageUrls.length > 0 && provider && apiKey) {
      setConnectorLive(conversationId, 'fetch')
      const summaries: Array<{ url: string; title: string; summary: string }> = []
      for (const url of pageUrls) {
        try {
          const { page } = await connectorApi.fetchPage(url)
          const summary = (await summarizeLocally(buildPageSummaryPrompt(page), url)) || page.content
          summaries.push({ url: page.url, title: page.title, summary })
        } catch {
          /* 单条抓取/总结失败跳过 */
        }
      }
      connectorFetchContext = renderFetchedPagesContext(summaries) || null
      if (summaries.length > 0) {
        connectorActions.push({ kind: 'fetch', detail: `${summaries.length} 个网页` })
      }
      setConnectorLive(conversationId, null)
    }

    if (shouldSearchWeb(userInput)) {
      try {
        setConnectorLive(conversationId, 'web_search')
        const { results } = await connectorApi.search(userInput)
        const block = renderWebSearchContext(userInput, results)
        if (block) {
          contextBlocks.push(block)
          connectorActions.push({ kind: 'web_search' })
        }
      } catch {
        /* 搜索失败不注入 */
      } finally {
        setConnectorLive(conversationId, null)
      }
    }
    const connectorContext = contextBlocks.length > 0 ? contextBlocks.join('\n\n') : null

    const chat = buildChatMessages({
      persona,
      facts: memories.facts,
      summary: memories.summaries[0] ?? null,
      recent,
      userInput,
      userName: auth.user?.displayName ?? '用户',
      quoted: quoted ?? null,
      userImages: images,
      includeImages,
      stickers: stickerOptionsFromPacks(useStickersStore().packs),
      schedule,
      scheduleNowMinutes: minutesOfLocalDay(),
      connectorContext,
      connectorFetchContext,
    })

    return { chat, memories, connectorActions }
  }

  /* ------------------------------- 图片识图 ------------------------------- */

  /** 把服务端的相对文件地址读成 base64 data URL，供识图模型或多模态主模型消费 */
  async function fetchImageDataUrl(url: string): Promise<string | null> {
    const absolute = resolveFileUrl(url)
    if (!absolute) return null
    try {
      const response = await fetch(absolute)
      if (!response.ok) return null
      const blob = await response.blob()
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }

  /** 把描述写回本地消息 meta，后续轮次的上下文就能直接读到 */
  function patchLocalDescription(
    conversationId: string,
    messageId: string,
    attachmentId: string,
    description: string,
  ): void {
    const target = messages.messagesOf(conversationId).find((m) => m.id === messageId)
    const ref = target?.meta?.attachments?.find((a) => a.id === attachmentId)
    if (ref) ref.description = description
  }

  /** 本机识图：当前这轮的每张图调用一次识图模型，描述回写服务端缓存 */
  async function describeImagesLocally(
    conversationId: string,
    provider: AiProvider,
    apiKey: string,
    messageId: string,
    attachments: AttachmentRef[],
  ): Promise<TurnImage[]> {
    const images: TurnImage[] = []
    for (const attachment of attachments) {
      const dataUrl = await fetchImageDataUrl(attachment.url)
      if (!dataUrl) continue
      try {
        const result = await invoke<AiCompleteResult>('ai_complete', {
          baseUrl: provider.baseUrl,
          apiKey,
          model: provider.visionModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VISION_PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          temperature: 0.2,
          maxTokens: 400,
          jsonMode: false,
        })
        reportUsage({
          conversationId,
          providerId: provider.id,
          kind: 'vision',
          refId: attachment.id,
          model: provider.visionModel ?? undefined,
          usage: result.usage,
        })
        const description = result.content.trim().slice(0, 1000)
        if (!description) continue
        await aiApi
          .saveImageDescription({
            messageId,
            attachmentId: attachment.id,
            description,
            model: provider.visionModel,
          })
          .catch(() => undefined)
        patchLocalDescription(conversationId, messageId, attachment.id, description)
        images.push({ dataUrl: '', description })
      } catch {
        // 识图失败不阻断对话，图片按占位注记处理
      }
    }
    return images
  }

  /** 直传模式：图片转 data URL 交给支持多模态的主模型 */
  async function toDataUrlImages(attachments: AttachmentRef[]): Promise<TurnImage[]> {
    const images: TurnImage[] = []
    for (const attachment of attachments) {
      const dataUrl = await fetchImageDataUrl(attachment.url)
      if (dataUrl) images.push({ dataUrl, description: null })
    }
    return images
  }

  /** 本地密钥模式：Rust 流式生成 → 分条 → 逐条落库 */
  async function generateLocally(
    conversationId: string,
    persona: AiPersona,
    provider: AiProvider,
    userInput: string,
    currentMessageId?: string,
    quoted?: string | null,
    imageAttachments: AttachmentRef[] = [],
  ): Promise<void> {
    if (!isTauri()) throw new Error('本机密钥模式需要桌面客户端，网页版请使用服务端托管密钥')

    const apiKey = await loadProviderKey(provider.id)
    if (!apiKey) throw new Error('本机没有找到该服务商的密钥，请到设置里重新填写')

    // 配了识图模型就先把图转成文字描述，没配就把图转成 data URL 直传主模型
    let turnImages: TurnImage[] = []
    if (imageAttachments.length > 0 && currentMessageId) {
      turnImages = provider.visionModel
        ? await describeImagesLocally(
            conversationId,
            provider,
            apiKey,
            currentMessageId,
            imageAttachments,
          )
        : await toDataUrlImages(imageAttachments)
    }

    const generationId = ulid()
    const { chat, connectorActions } = await collectContext(
      conversationId,
      persona,
      userInput,
      currentMessageId,
      quoted,
      turnImages,
      !provider.visionModel,
      provider,
      apiKey,
    )

    streaming.value[conversationId] = { generationId, text: '' }
    generating.value[conversationId] = true

    const unlisteners: UnlistenFn[] = []
    let finished = false

    const rule = currentSegmentRule()
    let pending = ''
    let segIndex = 0
    let appendChain: Promise<unknown> = Promise.resolve()

    /** 切好的段落按序落库；用串行链保证 index 顺序不会乱 */
    const pushSegment = (text: string): void => {
      const index = segIndex++
      appendChain = appendChain.then(() =>
        aiApi.appendMessage(conversationId, {
          generationId,
          index,
          content: text,
          clientNonce: ulid(),
          connector: connectorActions.length > 0 ? connectorActions : undefined,
        }),
      )
    }

    /** 流式增量切分：能切就先落库，气泡里只留还没切出去的半截话 */
    const cutNow = (atEnd: boolean): void => {
      const { ready, rest } = cutStreamingSegments(pending, rule, atEnd)
      pending = rest
      for (const piece of ready) pushSegment(piece)
    }

    /** 打字气泡文本按帧合并写入；每个 token 都写一次会让消息列表跟着每 token 重排 */
    let textFrame: number | null = null
    const flushStreamText = (): void => {
      cancelFrame(textFrame)
      textFrame = null
      const current = streaming.value[conversationId]
      if (current) current.text = stripStickerMarkers(pending)
    }
    const scheduleStreamText = (): void => {
      if (textFrame != null) return
      textFrame = scheduleFrame(() => {
        textFrame = null
        const current = streaming.value[conversationId]
        if (current) current.text = stripStickerMarkers(pending)
      })
    }

    const cleanup = (): void => {
      for (const off of unlisteners) off()
      unlisteners.length = 0
      cancelFrame(textFrame)
      textFrame = null
    }

    await new Promise<void>((resolve, reject) => {
      void listen<StreamDelta>('ai://delta', (event) => {
        if (event.payload.generation_id !== generationId) return
        pending += event.payload.delta
        cutNow(false)
        scheduleStreamText()
      }).then((off) => unlisteners.push(off))

      void listen<StreamDone>('ai://done', (event) => {
        if (event.payload.generation_id !== generationId || finished) return
        finished = true
        // 收尾前把攒着的增量写完，保证尾字不丢
        flushStreamText()
        cleanup()
        reportUsage({
          conversationId,
          personaId: persona.id,
          providerId: provider.id,
          kind: 'chat',
          refId: generationId,
          model: event.payload.model ?? persona.modelOverride ?? provider.model,
          usage: {
            prompt_tokens: event.payload.prompt_tokens,
            completion_tokens: event.payload.completion_tokens,
            cached_tokens: event.payload.cached_tokens,
          },
        })
        resolve()
      }).then((off) => unlisteners.push(off))

      void listen<StreamError>('ai://error', (event) => {
        if (event.payload.generation_id !== generationId || finished) return
        finished = true
        flushStreamText()
        cleanup()
        reject(new Error(event.payload.message))
      }).then((off) => unlisteners.push(off))

      void invoke('ai_generate', {
        request: {
          generation_id: generationId,
          base_url: provider.baseUrl,
          api_key: apiKey,
          model: persona.modelOverride ?? provider.model,
          temperature: persona.temperature ?? provider.temperature,
          max_tokens: provider.maxTokens,
          messages: chat,
        },
      }).catch((e: unknown) => {
        if (finished) return
        finished = true
        flushStreamText()
        cleanup()
        reject(e instanceof Error ? e : new Error('生成失败'))
      })
    }).finally(() => {
      delete streaming.value[conversationId]
      generating.value[conversationId] = false
      setConnectorLive(conversationId, null)
    })

    // 流结束：把剩余部分全部切出，并等排队中的段落都落库完
    cutNow(true)
    await appendChain.catch(() => undefined)

    void maybeCompact(conversationId, persona, provider)
  }

  /** 服务端密钥模式：交给服务端生成，进度靠 WS 事件推进，结束后由 ai.done 收尾 */
  async function generateOnServer(
    conversationId: string,
    persona: AiPersona,
    provider: AiProvider,
    content: string,
    clientNonce: string,
  ): Promise<void> {
    generating.value[conversationId] = true
    armServerWatchdog(conversationId)
    try {
      await aiApi.startGeneration({
        conversationId,
        content,
        clientNonce,
        providerId: provider.id,
      })
    } catch (e) {
      disarmServerWatchdog(conversationId)
      generating.value[conversationId] = false
      throw e
    }
  }

  /* ------------------- 服务端流式回复：WS 事件驱动 ------------------- */

  /** 服务端异常没发 ai.done 时的兜底，避免「生成中」状态卡死 */
  const serverWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()

  function armServerWatchdog(conversationId: string): void {
    disarmServerWatchdog(conversationId)
    serverWatchdogs.set(
      conversationId,
      setTimeout(() => {
        serverWatchdogs.delete(conversationId)
        generating.value[conversationId] = false
        delete streaming.value[conversationId]
      }, 180000),
    )
  }

  function disarmServerWatchdog(conversationId: string): void {
    const timer = serverWatchdogs.get(conversationId)
    if (timer) {
      clearTimeout(timer)
      serverWatchdogs.delete(conversationId)
    }
  }

  /* ---------- 服务端逐字增量的合帧缓冲 ----------
     每 token 直接写 streaming 会让消息列表跟着每 token 重算布局；
     先攒进普通 Map，rAF 一帧最多往响应式对象写一次。 */

  const pendingDeltas = new Map<string, string>()
  const pendingDeltaFrames = new Map<string, number>()

  /** 把攒着的增量写进气泡；顺带取消未触发的合帧 */
  function flushServerDelta(conversationId: string): void {
    const frame = pendingDeltaFrames.get(conversationId)
    if (frame != null) {
      cancelFrame(frame)
      pendingDeltaFrames.delete(conversationId)
    }
    const buffered = pendingDeltas.get(conversationId)
    if (buffered == null) return
    pendingDeltas.delete(conversationId)
    const current = streaming.value[conversationId]
    if (current) current.text += buffered
  }

  /** 丢弃未合帧的增量：换代或切段时，这些文本按旧行为本来就不再展示 */
  function dropServerDelta(conversationId: string): void {
    const frame = pendingDeltaFrames.get(conversationId)
    if (frame != null) {
      cancelFrame(frame)
      pendingDeltaFrames.delete(conversationId)
    }
    pendingDeltas.delete(conversationId)
  }

  /** 服务端逐字推送：增量接到打字气泡上（按帧合并写入） */
  function applyServerDelta(payload: {
    generationId: string
    conversationId: string
    index: number
    delta: string
  }): void {
    const target = streaming.value[payload.conversationId]
    if (!target || target.generationId !== payload.generationId) {
      dropServerDelta(payload.conversationId)
      streaming.value[payload.conversationId] = { generationId: payload.generationId, text: payload.delta }
      return
    }
    pendingDeltas.set(
      payload.conversationId,
      (pendingDeltas.get(payload.conversationId) ?? '') + payload.delta,
    )
    if (pendingDeltaFrames.has(payload.conversationId)) return
    pendingDeltaFrames.set(
      payload.conversationId,
      scheduleFrame(() => {
        pendingDeltaFrames.delete(payload.conversationId)
        flushServerDelta(payload.conversationId)
      }),
    )
  }

  /** 一段话切好了：清掉气泡里的半截话，正式消息随后由 message.created 下发 */
  function applyServerSegment(payload: {
    generationId: string
    conversationId: string
    index: number
    text: string
  }): void {
    const target = streaming.value[payload.conversationId]
    if (target && target.generationId === payload.generationId) {
      dropServerDelta(payload.conversationId)
      target.text = ''
    }
  }

  function applyServerDone(payload: { generationId: string; conversationId: string }): void {
    const target = streaming.value[payload.conversationId]
    if (target && target.generationId !== payload.generationId) return
    disarmServerWatchdog(payload.conversationId)
    // 收尾前先把攒着的增量合帧写完，保证尾字不丢
    flushServerDelta(payload.conversationId)
    delete streaming.value[payload.conversationId]
    generating.value[payload.conversationId] = false
    setConnectorLive(payload.conversationId, null)
  }

  function applyServerError(payload: { generationId: string; conversationId: string; message: string }): void {
    applyServerDone(payload)
    lastError.value = payload.message
  }

  /** 同一句话的重复提交（双击/旧事件处理器）在 700ms 内只放行一次 */
  const recentTurns = new Map<string, { content: string; at: number }>()

  /**
   * 发送一轮 AI 对话：先把用户消息按普通消息发出（保证立刻可见），
   * 再根据密钥位置决定由谁生成。
   * replyTo 让「引用某条消息再提问」成立：消息带上 replyToId，提示词里也带上被引原文。
   * attachments 是随本轮一起发出的图片，识图后交给模型。
   */
  async function sendTurn(
    conversationId: string,
    content: string,
    replyTo?: Message | null,
    attachments: AttachmentRef[] = [],
  ): Promise<void> {
    const now = Date.now()
    const last = recentTurns.get(conversationId)
    if (last && last.content === content.trim() && now - last.at < 700) return
    recentTurns.set(conversationId, { content: content.trim(), at: now })

    lastError.value = null
    const persona = personaOf(conversationId)
    if (!persona) throw new Error('这个会话没有绑定 AI 角色')
    const provider = providerOf(persona)
    if (!provider) throw new Error('还没有配置 AI 服务商')

    // 跨天后第一条消息：先把今天的日程准备好；失败不阻断这轮回复
    await ensureSchedule(persona.id).catch(() => null)

    const images = attachments.filter((a) => a.kind === 'image')
    const nonce = ulid()
    // clientNonce 必须与下面 generation 用的完全一致：
    // 服务端按 (sender, nonce) 做幂等，两个不同的值会插出第二条同样的用户消息
    const sent = await messages.send({
      conversationId,
      content,
      clientNonce: nonce,
      // 图片消息类型让气泡正常渲染图片；纯文字部分会显示在图下方
      type: images.length > 0 ? 'image' : 'text',
      meta: { clientNonce: nonce, ...(attachments.length > 0 ? { attachments } : {}) },
      replyToId: replyTo?.id ?? null,
    })

    if (provider.keyLocation === 'server') {
      // 密钥在服务端：识图也由服务端在生成前完成
      await generateOnServer(conversationId, persona, provider, content, nonce)
      return
    }

    try {
      await generateLocally(conversationId, persona, provider, content, sent.id, quotedOf(replyTo), images)
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : '生成失败'
      throw e
    }
  }

  /** 引用原文交给模型；撤回的消息没有可引用内容 */
  function quotedOf(message: Message | null | undefined): string | null {
    if (!message || message.deletedAt) return null
    return message.content.trim().slice(0, 400) || null
  }

  /** 记忆压缩：超过阈值时把旧对话压成摘要 + 事实，失败静默重试交给下次触发 */
  async function maybeCompact(
    conversationId: string,
    persona: AiPersona,
    provider: AiProvider,
  ): Promise<void> {
    if (!isTauri()) return
    try {
      const memory = await aiApi.memory(conversationId)
      const lastCompactedSeq = memory.summaries.reduce((max, s) => Math.max(max, s.toSeq), 0)
      const list = messages.messagesOf(conversationId)
      const pending = list.filter((m) => m.seq > lastCompactedSeq && !m.deletedAt)
      if (pending.length < MEMORY_COMPACT_THRESHOLD) return

      const apiKey = await loadProviderKey(provider.id)
      if (!apiKey) return

      const transcript = pending
        .slice(0, 60)
        .map((m) => `${m.senderType === 'ai' ? persona.name : '我'}：${m.content}`)
        .join('\n')

      const prompt = buildCompactionPrompt({
        previousSummary: memory.summaries[0]?.summary ?? null,
        transcript,
      })

      const result = await invoke<AiCompleteResult>('ai_complete', {
        baseUrl: provider.baseUrl,
        apiKey,
        model: persona.modelOverride ?? provider.model,
        messages: prompt,
        temperature: 0.2,
        maxTokens: 800,
        jsonMode: true,
      })
      reportUsage({
        conversationId,
        personaId: persona.id,
        providerId: provider.id,
        kind: 'summary',
        model: persona.modelOverride ?? provider.model,
        usage: result.usage,
      })

      const parsed = JSON.parse(result.content) as {
        summary?: string
        facts?: Array<{ subject: string; key: string; value: string; confidence?: number }>
      }

      const lastMessage = pending[pending.length - 1]!
      await aiApi.writeMemory(conversationId, {
        summary: parsed.summary
          ? {
              fromSeq: lastCompactedSeq,
              toSeq: lastMessage.seq,
              text: parsed.summary,
              model: persona.modelOverride ?? provider.model,
            }
          : undefined,
        facts: (parsed.facts ?? []).map((fact) => ({
          subject: (['user', 'persona', 'relation', 'world'].includes(fact.subject)
            ? fact.subject
            : 'user') as 'user' | 'persona' | 'relation' | 'world',
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
        })),
      })
    } catch {
      /* 压缩失败不影响主流程，下次对话继续尝试 */
    }
  }

  /** 正在跑主动消息的会话，避免服务端重发事件时生成两遍 */
  const proactiveBusy = new Set<string>()

  /**
   * 服务端判定「该主动找你了」，但密钥在本机所以它自己发不了。
   * 由在线客户端代跑一次生成，结果仍走普通消息接口落库。
   */
  async function handleProactiveDue(payload: {
    conversationId: string
    personaId: string
    hint?: string
  }): Promise<void> {
    if (!isTauri()) return
    if (proactiveBusy.has(payload.conversationId)) return

    const persona = personas.value.find((p) => p.id === payload.personaId) ?? personaOf(payload.conversationId)
    if (!persona) return
    const provider = providerOf(persona)
    if (!provider || provider.keyLocation !== 'local') return

    proactiveBusy.add(payload.conversationId)
    try {
      await generateProactiveLocally(payload.conversationId, persona, provider, payload.hint)
    } catch {
      /* 配额已被服务端占掉，失败不重试，避免刷屏 */
    } finally {
      proactiveBusy.delete(payload.conversationId)
    }
  }

  /** 本机密钥的主动消息：非流式一次生成，最多两条 */
  async function generateProactiveLocally(
    conversationId: string,
    persona: AiPersona,
    provider: AiProvider,
    hint?: string,
  ): Promise<void> {
    const apiKey = await loadProviderKey(provider.id)
    if (!apiKey) return

    let digest = ''
    try {
      const memories = await aiApi.memory(conversationId)
      digest = [
        memories.summaries[0]?.summary ?? '',
        ...memories.facts.map((f) => `${f.key}: ${f.value}`),
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      /* 没有记忆也能主动开口 */
    }

    const schedule = await ensureSchedule(persona.id).catch(() => null)
    const prompt = buildProactivePrompt({
      persona,
      memoryDigest: hint ? `${digest}\n提示：${hint}` : digest,
      idleHours: 0,
      localTime: new Date().toLocaleString(),
      schedule,
      scheduleNowMinutes: minutesOfLocalDay(),
    })

    const result = await invoke<AiCompleteResult>('ai_complete', {
      baseUrl: provider.baseUrl,
      apiKey,
      model: persona.modelOverride ?? provider.model,
      messages: prompt,
      temperature: 0.9,
      maxTokens: 200,
      jsonMode: false,
    })
    reportUsage({
      conversationId,
      personaId: persona.id,
      providerId: provider.id,
      kind: 'proactive',
      model: persona.modelOverride ?? provider.model,
      usage: result.usage,
    })

    const segments = splitSegments(result.content, currentSegmentRule()).slice(0, 2)
    if (segments.length === 0) return

    const generationId = `proactive-local-${conversationId}-${Date.now()}`
    for (let index = 0; index < segments.length; index++) {
      await aiApi.appendMessage(conversationId, {
        generationId,
        index,
        content: segments[index]!,
        clientNonce: `${generationId}-${index}`,
        model: persona.modelOverride ?? provider.model,
        totalSegments: segments.length,
        proactive: true,
      })
    }
  }

  /** 正在跑群聊回复的日志，避免服务端重发事件时生成两遍 */
  const groupBusy = new Set<string>()

  /**
   * 群聊里轮到某个角色说话，但密钥在本机：
   * 服务端已经算好心情、占好配额，这里只负责生成内容并回传。
   */
  async function handleGroupDue(payload: {
    logId: string
    conversationId: string
    personaId: string
    kind: 'reply' | 'autonomy'
    triggerMessageId?: string | null
    mood: string
    energy: number
  }): Promise<void> {
    if (groupBusy.has(payload.logId)) return

    const persona = personaById.value.get(payload.personaId)
    if (!persona) {
      void aiApi.skipGroup(payload.logId, 'persona_not_loaded').catch(() => undefined)
      return
    }
    const provider = providerOf(persona)
    if (!provider) {
      void aiApi.skipGroup(payload.logId, 'no_provider').catch(() => undefined)
      return
    }

    // 网页端没有本机密钥，直接回报跳过，避免服务端一直等
    if (!isTauri()) {
      void aiApi.skipGroup(payload.logId, 'client_cannot_run_local_key').catch(() => undefined)
      return
    }
    if (provider.keyLocation !== 'local') {
      void aiApi.skipGroup(payload.logId, 'provider_not_local').catch(() => undefined)
      return
    }

    const apiKey = await loadProviderKey(provider.id)
    if (!apiKey) {
      void aiApi.skipGroup(payload.logId, 'missing_local_key').catch(() => undefined)
      return
    }

    groupBusy.add(payload.logId)
    try {
      const conversation = conversations.byId.get(payload.conversationId)
      let recent: Message[] = messages.messagesOf(payload.conversationId)
      if (recent.length === 0) {
        const page = await messageApi.page(payload.conversationId, { limit: 30 })
        recent = page.messages
      }

      let members = (await import('./members')).useMembersStore().of(payload.conversationId)
      if (members.length === 0) {
        const detail = await conversationApi.detail(payload.conversationId)
        members = detail.members
      }
      const nameById = new Map(
        members.map((member) => [
          member.userId,
          member.nickname || member.user?.displayName || member.userId,
        ]),
      )

      const trigger =
        payload.kind === 'reply'
          ? recent.find((message) => message.id === payload.triggerMessageId) ?? null
          : null
      const mustReply = trigger ? trigger.content.includes(`@${persona.name}`) : false
      const lastAt = recent.length > 0 ? recent[recent.length - 1]!.createdAt : Date.now()

      // 群里的引用关系也要让模型看见：谁在接谁的茬，决定它该不该插话
      const byId = new Map(recent.map((message) => [message.id, message]))
      const quotedContextOf = (message: Message): { speaker: string; content: string } | null => {
        if (!message.replyToId) return null
        const target = byId.get(message.replyToId)
        if (target) {
          return {
            speaker: nameById.get(target.senderId ?? '') ?? '群友',
            content: previewOfMessage(target),
          }
        }
        const snapshot = message.meta?.replyTo
        return snapshot ? { speaker: snapshot.senderName, content: snapshot.preview } : null
      }

      const schedule = await ensureSchedule(persona.id).catch(() => null)
      const prompt = buildGroupPrompt({
        persona,
        mood: payload.mood,
        energy: payload.energy,
        groupName: conversation?.name ?? '群聊',
        members: members.map((member) => ({
          name: nameById.get(member.userId) ?? member.userId,
          isSelf: member.userId === persona.userId,
        })),
        recent: recent
          .filter(
            (message) =>
              message.senderType !== 'system' && !message.deletedAt && message.content.trim().length > 0,
          )
          .slice(-24)
          .map((message) => ({
            speaker: nameById.get(message.senderId ?? '') ?? '群友',
            content: message.content,
            isSelf: Boolean(persona.userId) && message.senderId === persona.userId,
            mentionsSelf: Boolean(message.meta?.mentions?.includes(persona.userId ?? '')),
            replyTo: quotedContextOf(message),
          })),
        mode: payload.kind,
        stickers: stickerOptionsFromPacks(useStickersStore().packs),
        trigger:
          trigger && payload.kind === 'reply'
            ? {
                speaker: nameById.get(trigger.senderId ?? '') ?? '群友',
                content: trigger.content,
                mustReply,
                replyTo: quotedContextOf(trigger),
              }
            : null,
        idleHours: Math.max(0, Math.floor((Date.now() - lastAt) / 3_600_000)),
        localTime: new Date().toLocaleString(),
        schedule,
        scheduleNowMinutes: minutesOfLocalDay(),
      })

      const groupResult = await invoke<AiCompleteResult>('ai_complete', {
        baseUrl: provider.baseUrl,
        apiKey,
        model: persona.modelOverride ?? provider.model,
        messages: prompt,
        temperature: persona.temperature ?? provider.temperature,
        maxTokens: 300,
        jsonMode: false,
      })
      reportUsage({
        conversationId: payload.conversationId,
        personaId: persona.id,
        providerId: provider.id,
        kind: payload.kind === 'reply' ? 'group_reply' : 'group_autonomy',
        refId: payload.logId,
        model: persona.modelOverride ?? provider.model,
        usage: groupResult.usage,
      })

      const raw = groupResult.content

      if (isSkipReply(raw)) {
        await aiApi.skipGroup(payload.logId, 'client_skip')
        return
      }

      const segments = splitSegments(raw, currentSegmentRule()).slice(0, 3)
      if (segments.length === 0) {
        await aiApi.skipGroup(payload.logId, 'empty_reply')
        return
      }

      for (let index = 0; index < segments.length; index++) {
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, segmentDelay(segments[index]!)))
        }
        await aiApi.appendGroupMessage({
          logId: payload.logId,
          personaId: persona.id,
          conversationId: payload.conversationId,
          generationId: payload.logId,
          index,
          content: segments[index]!,
          clientNonce: `${payload.logId}-${index}`,
          model: persona.modelOverride ?? provider.model,
          totalSegments: segments.length,
        })
      }
    } catch {
      /* 配额已被服务端占掉，失败不重试，避免群里刷屏 */
    } finally {
      groupBusy.delete(payload.logId)
    }
  }

  /** 引用块里展示的摘要：直接复用消息列表的 messagePreview，不再维护第二份收敛规则 */
  function previewOfMessage(message: Message): string {
    return messagePreview(message)
  }

  /** 模型偶尔带引号或换行，落库前收敛成一句话 */
  function cleanGenerated(text: string, maxChars: number): string {
    return text
      .trim()
      .replace(/^["'「『（(]+/, '')
      .replace(/["'」』）)]+$/, '')
      .replace(/\s+/g, ' ')
      .slice(0, maxChars)
      .trim()
  }

  /** 正在跑动态任务的角色，避免服务端重发事件时生成两遍 */
  const momentBusy = new Set<string>()

  /**
   * 服务端判定某个角色该去动态广场活动了，但密钥在本机，
   * 只能由在线客户端代跑生成，结果通过动态接口回写。
   */
  async function handleMomentDue(payload: {
    kind: 'post' | 'comment'
    personaId: string
    postId?: string
  }): Promise<void> {
    if (!isTauri()) return
    const persona = personaById.value.get(payload.personaId)
    if (!persona) return
    if (momentBusy.has(payload.personaId)) return

    const provider = providerOf(persona)
    if (!provider || provider.keyLocation !== 'local') return

    const apiKey = await loadProviderKey(provider.id)
    if (!apiKey) return

    momentBusy.add(payload.personaId)
    try {
      if (payload.kind === 'comment' && payload.postId) {
        const [{ post }, { comments }] = await Promise.all([
          postApi.get(payload.postId),
          postApi.comments(payload.postId),
        ])
        const result = await invoke<AiCompleteResult>('ai_complete', {
          baseUrl: provider.baseUrl,
          apiKey,
          model: persona.modelOverride ?? provider.model,
          messages: buildMomentCommentPrompt({
            persona,
            postAuthor: post.author?.displayName ?? '某人',
            postContent: post.content,
            imageCount: post.attachments?.length ?? 0,
            minutesAgo: Math.max(0, Math.round((Date.now() - post.createdAt) / 60_000)),
            comments: comments.map((comment) => ({
              author: comment.author?.displayName ?? '某人',
              content: comment.content,
              isMine: comment.personaId === persona.id,
            })),
            localTime: new Date().toLocaleString(),
          }),
          temperature: 0.95,
          maxTokens: 120,
          jsonMode: false,
        })
        reportUsage({
          personaId: persona.id,
          providerId: provider.id,
          kind: 'moment',
          model: persona.modelOverride ?? provider.model,
          usage: result.usage,
        })
        if (isSkipReply(result.content)) return
        await postApi.comment(payload.postId, {
          content: cleanGenerated(result.content, 200),
          personaId: persona.id,
        })
        return
      }

      const { posts } = await postApi.feed(undefined, 6)
      const result = await invoke<AiCompleteResult>('ai_complete', {
        baseUrl: provider.baseUrl,
        apiKey,
        model: persona.modelOverride ?? provider.model,
        messages: buildMomentPostPrompt({
          persona,
          memoryDigest: '',
          recentMoments: posts.map((post) => ({
            author: post.author?.displayName ?? '某人',
            content: post.content.slice(0, 120),
          })),
          localTime: new Date().toLocaleString(),
        }),
        temperature: 1,
        maxTokens: 200,
        jsonMode: false,
      })
      reportUsage({
        personaId: persona.id,
        providerId: provider.id,
        kind: 'moment',
        model: persona.modelOverride ?? provider.model,
        usage: result.usage,
      })
      if (isSkipReply(result.content)) return
      await postApi.create({
        content: cleanGenerated(result.content, 500),
        attachmentIds: [],
        visibility: 'friends',
        personaId: persona.id,
      })
    } catch {
      /* 配额已被服务端占掉，失败不重试，避免刷屏 */
    } finally {
      momentBusy.delete(payload.personaId)
    }
  }

  return {
    providers,
    personas,
    globalSettings,
    loading,
    loaded,
    streaming,
    generating,
    connectorLive,
    setConnectorLive,
    lastError,
    load,
    loadSettings,
    saveSettings,
    upsertLocal,
    removeLocal,
    personaOf,
    providerOf,
    streamTextOf,
    isGenerating,
    sendTurn,
    maybeCompact,
    applyServerDelta,
    applyServerSegment,
    applyServerDone,
    applyServerError,
    handleProactiveDue,
    handleMomentDue,
    handleGroupDue,
    schedules,
    cachedSchedule,
    ensureSchedule,
    saveScheduleItems,
    estimateTokens,
  }
})
