import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  dayKeyOf,
  estimateTokens,
  SEGMENT_REPLY_DEFAULTS,
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
  type ConnectorActionMeta,
  type Message,
  type SegmentRule,
} from '@nenochat/shared'
import { aiApi } from '@/api/ai'
import { listPersonas, prunePersonas, upsertPersona as upsertPersonaRow } from '@/db/dao/ai'
import { hasLocalDb } from '@/platform/db'
import { useAuthStore } from './auth'
import { useConversationsStore } from './conversations'
import { useMessagesStore } from './messages'
import { useServersStore } from './servers'


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
 * 生成全部由服务端完成：开了流式就逐字推送，
 * 开了分段就切好一段发一段，均通过 WS 事件实时驱动界面。
 */
export const useAiStore = defineStore('ai', () => {
  const providers = ref<AiProvider[]>([])
  const personas = ref<AiPersona[]>([])
  const globalSettings = ref<AiGlobalSettings | null>(null)
  /** 角色列表的加载状态：load 守卫用，服务端拉取成功才算 loaded */
  const loading = ref(false)
  const loaded = ref(false)
  /** loaded 标记属于哪个服务器；切服后旧标记作废，必须重新拉取 */
  const loadedServerId = ref<string | null>(null)
  const streaming = ref<Record<string, { generationId: string; text: string }>>({})
  const generating = ref<Record<string, boolean>>({})
  /** 生成中正在执行的连接器动作（B 站 / 抓网页 / 搜索 / 天气），用于占位气泡的实时提示 */
  const connectorLive = ref<Record<string, ConnectorActionMeta['kind'] | null>>({})
  /** 生成中正在调用的 MCP / 技能工具（人类可读名），占位气泡实时提示 */
  const toolLive = ref<Record<string, string | null>>({})
  const lastError = ref<string | null>(null)
  /** 各服务商的模型列表缓存；刷新后由设置页重新拉取 */
  const modelsByProvider = ref<Record<string, string[]>>({})
  const loadingModels = ref<Record<string, boolean>>({})

  const auth = useAuthStore()
  const messages = useMessagesStore()
  const conversations = useConversationsStore()

  const providerById = computed(() => new Map(providers.value.map((p) => [p.id, p])))
  const personaById = computed(() => new Map(personas.value.map((p) => [p.id, p])))

  /** 当前服务器 id：角色、服务商与全局设置都按服务器隔离 */
  function currentServerId(): string {
    return useServersStore().currentId ?? ''
  }

  /** 记录/清除某会话正在执行的连接器动作；kind 传 null 表示结束 */
  function setConnectorLive(conversationId: string, kind: ConnectorActionMeta['kind'] | null): void {
    if (kind) connectorLive.value = { ...connectorLive.value, [conversationId]: kind }
    else delete connectorLive.value[conversationId]
  }

  /** 记录/清除某会话正在调用的工具；tool 传 null 表示结束 */
  function setToolLive(conversationId: string, tool: string | null): void {
    if (tool) toolLive.value = { ...toolLive.value, [conversationId]: tool }
    else delete toolLive.value[conversationId]
  }

  /** 从服务端拉取并缓存某个服务商的模型列表；失败时保留旧列表 */
  async function loadModels(providerId: string): Promise<string[]> {
    if (loadingModels.value[providerId]) return modelsByProvider.value[providerId] ?? []
    loadingModels.value = { ...loadingModels.value, [providerId]: true }
    try {
      const result = await aiApi.providerModels(providerId)
      modelsByProvider.value = { ...modelsByProvider.value, [providerId]: result.models }
      return result.models
    } finally {
      const next = { ...loadingModels.value }
      delete next[providerId]
      loadingModels.value = next
    }
  }

  /* ------------------------------- 角色日程 ------------------------------- */

  /** 内存里的当天日程：按 personaId + dayKey 缓存，不落本地库 */
  const schedules = ref<Record<string, AiSchedule>>({})
  const schedulePending = new Map<string, Promise<AiSchedule | null>>()

  function scheduleKeyOf(personaId: string, dayKey: string): string {
    // 带上服务器：不同服务器上可能存在同 id 的角色，缓存不能互相命中
    return `${currentServerId()}:${personaId}:${dayKey}`
  }

  function cachedSchedule(personaId: string, dayKey = dayKeyOf()): AiSchedule | null {
    return schedules.value[scheduleKeyOf(personaId, dayKey)] ?? null
  }

  function rememberSchedule(schedule: AiSchedule): AiSchedule {
    schedules.value = { ...schedules.value, [scheduleKeyOf(schedule.personaId, schedule.dayKey)]: schedule }
    return schedule
  }

  /** 确保某个角色当天有日程；已缓存直接返回 */
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

  /**
   * 全局自动互动设置；读取失败时保持 null，界面按默认值渲染。
   * guard 用来丢弃切服之后才回来的旧响应，避免旧服务器的开关盖住新服务器。
   */
  async function loadSettings(guard?: () => boolean): Promise<void> {
    try {
      const result = await aiApi.settings()
      if (guard?.()) return
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

  /* --------------------- 服务器切换时的内存态清理 --------------------- */

  /** load 代次：切服或重置后递增，还没回来的旧请求按代次丢弃 */
  let loadSeq = 0
  /** 正在加载的服务器：同服重复请求合并，跨服请求各自进行 */
  let loadingServerId: string | null = null

  /**
   * 丢掉所有跟着服务器走的内存态。
   * 角色、服务商、全局设置、模型缓存、日程缓存与生成中的气泡都属于某一台服务器，
   * 换服后必须全部作废，否则新服务器会看到上一台服务器的「幽灵角色」。
   */
  function dropServerScopedState(): void {
    // loaded 只对拉取时的服务器成立，状态一清就必须连带作废
    loaded.value = false
    personas.value = []
    providers.value = []
    globalSettings.value = null
    modelsByProvider.value = {}
    loadingModels.value = {}
    schedules.value = {}
    schedulePending.clear()
    recentTurns.clear()
    lastError.value = null
    for (const timer of serverWatchdogs.values()) clearTimeout(timer)
    serverWatchdogs.clear()
    for (const frame of pendingDeltaFrames.values()) cancelFrame(frame)
    pendingDeltaFrames.clear()
    pendingDeltas.clear()
    streaming.value = {}
    generating.value = {}
    connectorLive.value = {}
    toolLive.value = {}
  }

  /** 切换服务器 / 退出登录时清空内存态，交由下一次 load 重新按当前服务器拉取 */
  function reset(): void {
    loadSeq += 1
    loading.value = false
    loadingServerId = null
    loaded.value = false
    loadedServerId.value = null
    dropServerScopedState()
  }

  async function load(force = false): Promise<void> {
    // 通讯录与新建聊天每次打开都会调 load，不做守卫的话每次都白拉 3 个接口并重写角色镜像；
    // 保存角色后的手动刷新传 force。离线时不标记 loaded，联网后再拉。
    const serverId = currentServerId()
    if (loading.value && loadingServerId === serverId) return
    // loaded 只对拉取时的服务器有效：切服后标记作废，必须重新走一遍
    if (loaded.value && !force && loadedServerId.value === serverId) return

    const seq = ++loadSeq
    loading.value = true
    loadingServerId = serverId
    // 换了服务器先清空：旧服务的角色留在列表里就是幽灵数据的根源
    if (loadedServerId.value !== serverId) dropServerScopedState()

    /** 本次请求是否已经过期：又发生了切服或重置 */
    const stale = () => seq !== loadSeq || currentServerId() !== serverId

    try {
      // 先出本地镜像（断网也有角色列表），再拉服务端覆盖
      if (hasLocalDb() && serverId) {
        const local = await listPersonas(serverId)
        if (stale()) return
        // 镜像本身就按服务器隔离，为空也要覆盖——不能保留上一台服务器的列表
        personas.value = local
      }

      try {
        const [providerResult, personaResult] = await Promise.all([
          aiApi.providers(),
          aiApi.personas(),
          loadSettings(stale),
        ])
        if (stale()) return
        providers.value = providerResult.providers
        personas.value = personaResult.personas
        loaded.value = true
        loadedServerId.value = serverId

        if (hasLocalDb() && serverId) {
          for (const persona of personaResult.personas) {
            await upsertPersonaRow(serverId, persona)
          }
          // 服务端已经没有的角色要从镜像里删掉，否则断网时会冒出来
          await prunePersonas(
            serverId,
            personaResult.personas.map((persona) => persona.id),
          )
        }
        // 模型列表随服务商一起补齐；失败静默，设置页可手动刷新
        for (const provider of providers.value) {
          if (!modelsByProvider.value[provider.id]) {
            void loadModels(provider.id).catch(() => undefined)
          }
        }
      } catch {
        /* 离线：保留本地镜像，下次打开再拉 */
      }
    } finally {
      // 只有最新一次请求有权清掉加载状态，迟到的旧请求不能把新请求的 loading 关掉
      if (seq === loadSeq) {
        loading.value = false
        loadingServerId = null
      }
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
    setToolLive(payload.conversationId, null)
  }

  function applyServerError(payload: { generationId: string; conversationId: string; message: string }): void {
    applyServerDone(payload)
    lastError.value = payload.message
  }

  /** 同一句话的重复提交（双击/旧事件处理器）在 700ms 内只放行一次 */
  const recentTurns = new Map<string, { content: string; at: number }>()

  /**
   * 发送一轮 AI 对话：先把用户消息按普通消息发出（保证立刻可见），再由服务端生成。
   * replyTo 让「引用某条消息再提问」成立：消息带上 replyToId，提示词里也带上被引原文。
   * attachments 是随本轮一起发出的图片，由服务端识图后交给模型。
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
    await messages.send({
      conversationId,
      content,
      clientNonce: nonce,
      // 图片消息类型让气泡正常渲染图片；纯文字部分会显示在图下方
      type: images.length > 0 ? 'image' : 'text',
      meta: { clientNonce: nonce, ...(attachments.length > 0 ? { attachments } : {}) },
      replyToId: replyTo?.id ?? null,
    })

    await generateOnServer(conversationId, persona, provider, content, nonce)
  }

  /**
   * 发送一条语音消息并触发 AI 生成。
   * 语音消息本体按普通消息先发（类型 voice + 附件），生成请求正文传空：
   * 服务端识别语音消息后按转写文本（ASR 未接入时为占位说明）组装上下文。
   */
  async function sendVoiceTurn(
    conversationId: string,
    attachment: AttachmentRef,
    replyTo?: Message | null,
  ): Promise<void> {
    lastError.value = null
    const persona = personaOf(conversationId)
    if (!persona) throw new Error('这个会话没有绑定 AI 角色')
    const provider = providerOf(persona)
    if (!provider) throw new Error('还没有配置 AI 服务商')

    await ensureSchedule(persona.id).catch(() => null)

    const nonce = ulid()
    await messages.send({
      conversationId,
      content: '',
      clientNonce: nonce,
      type: 'voice',
      meta: { clientNonce: nonce, attachments: [attachment] },
      replyToId: replyTo?.id ?? null,
    })

    await generateOnServer(conversationId, persona, provider, '', nonce)
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
    toolLive,
    setToolLive,
    lastError,
    modelsByProvider,
    loadingModels,
    loadModels,
    load,
    reset,
    loadSettings,
    saveSettings,
    upsertLocal,
    removeLocal,
    personaOf,
    providerOf,
    streamTextOf,
    isGenerating,
    sendTurn,
    sendVoiceTurn,
    applyServerDelta,
    applyServerSegment,
    applyServerDone,
    applyServerError,
    schedules,
    cachedSchedule,
    ensureSchedule,
    saveScheduleItems,
    estimateTokens,
  }
})
