import { Cron } from 'croner'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import {
  MOMENT_AI_DEFAULTS,
  buildMomentCommentPrompt,
  buildMomentPostPrompt,
  isSkipReply,
  ulid,
  type AiGlobalSettings,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as aiRepo from '../db/repo/ai'
import * as conversationsRepo from '../db/repo/conversations'
import * as momentRepo from '../db/repo/moment-ai'
import * as postsRepo from '../db/repo/posts'
import { callUpstream, resolveServerApiKey } from './ai-service'
import { createComment, createPost } from './post-service'
import {
  formatLocalTime,
  localDayKey,
  minutesOfDay,
  serverTzOffsetMinutes,
} from './proactive-rules'
import { hub } from '../ws/hub'

/**
 * 角色在动态广场的活动：刷动态、点赞、评论、自己发一条。
 *
 * 与主动私聊一样，判定与生成默认都在服务端完成，多端看到的是同一条。
 * 密钥在本机的角色服务端发不了，改为通过 WS 派发给在线客户端代跑。
 */

const TZ_OFFSET_MIN = serverTzOffsetMinutes()
const STALE_PENDING_MS = 10 * 60_000
const KICKOFF_DELAY_MS = 45_000

/** 每轮扫描里各动作的发生概率，避免刚打开客户端就刷一屏 */
const LIKE_CHANCE = 0.5
const COMMENT_CHANCE = 0.55
const POST_CHANCE = 0.08

interface PersonaContext {
  userId: string
  persona: aiRepo.PersonaRow
  provider: aiRepo.ProviderRow
  settings: AiGlobalSettings
  dayKey: string
  now: number
  random: () => number
}

function pick<T>(items: T[], random: () => number): T | undefined {
  if (items.length === 0) return undefined
  return items[Math.floor(random() * items.length) % items.length]
}

/** 角色的服务商：优先自己指定的，否则退回默认服务商 */
function resolveProvider(db: DB, persona: aiRepo.PersonaRow): aiRepo.ProviderRow | undefined {
  if (persona.provider_id) {
    const provider = aiRepo.findProvider(db, persona.provider_id)
    if (provider) return provider
  }
  return aiRepo.defaultProvider(db, persona.owner_id)
}

/** 记忆摘要 + 事实，让角色发动态时记得最近聊过什么 */
function buildMemoryDigest(db: DB, personaId: string): string {
  const conversation = conversationsRepo.findByPersonaId(db, personaId)
  if (!conversation) return ''

  const summary = aiRepo.latestSummary(db, conversation.id)
  const facts = aiRepo.listFacts(db, conversation.id).map(aiRepo.mapFact)
  return [summary?.summary ?? '', ...facts.map((fact) => `${fact.key}: ${fact.value}`)]
    .filter((line) => line.length > 0)
    .join('\n')
}

/** 模型偶尔会带上引号或换行，落库前统一收敛成一句话 */
function cleanReply(text: string, maxChars: number): string {
  return text
    .trim()
    .replace(/^["'「『（(]+/, '')
    .replace(/["'」』）)]+$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, maxChars)
    .trim()
}

function broadcastLike(postId: string, personaId: string, likeCount: number): void {
  hub().sendToUsers(hub().onlineUserIds(), 'post.like.changed', {
    postId,
    userId: personaId,
    liked: true,
    likeCount,
  })
}

/** 点赞不需要模型，服务端可以直接做，因此不受密钥存放位置影响 */
function likeSomething(db: DB, ctx: PersonaContext): void {
  const { userId, persona, settings, dayKey, now, random } = ctx
  if (settings.momentsLikesPerDay <= 0) return
  if (momentRepo.countToday(db, persona.id, 'like', dayKey) >= settings.momentsLikesPerDay) return
  if (random() >= LIKE_CHANCE) return

  const candidates = postsRepo
    .listRecentForAi(db, now - MOMENT_AI_DEFAULTS.freshWindowMs, 24)
    .filter((post) => post.persona_id !== persona.id)
  const target = pick(candidates, random)
  if (!target) return

  const reserved = momentRepo.recordAction(db, {
    personaId: persona.id,
    userId,
    kind: 'like',
    postId: target.id,
    dayKey,
    status: 'done',
  })
  if (!reserved) return

  const likeCount = postsRepo.addPersonaLike(db, target.id, userId, persona.id)
  broadcastLike(target.id, persona.id, likeCount)
}

async function commentOnPost(
  db: DB,
  log: FastifyBaseLogger,
  ctx: PersonaContext,
  target: postsRepo.AiPostCandidate,
): Promise<void> {
  const { userId, persona, provider, dayKey, now } = ctx

  const reserved = momentRepo.recordAction(db, {
    personaId: persona.id,
    userId,
    kind: 'comment',
    postId: target.id,
    dayKey,
    status: 'pending',
  })
  if (!reserved) return

  // 密钥在本机：服务端只能把「该评论哪条」派发给在线客户端
  if (provider.key_location !== 'server') {
    if (!hub().isOnline(userId)) {
      momentRepo.markStatus(db, {
        personaId: persona.id,
        kind: 'comment',
        postId: target.id,
        dayKey,
        status: 'failed',
      })
      return
    }
    hub().sendToUser(userId, 'ai.moment.due', {
      taskId: ulid(),
      kind: 'comment',
      personaId: persona.id,
      postId: target.id,
      dueAt: now,
    })
    return
  }

  const mapped = aiRepo.mapPersona(persona)
  const comments = postsRepo.listComments(db, target.id).map((comment) => ({
    author: comment.author?.displayName ?? '某人',
    content: comment.content,
    isMine: comment.personaId === persona.id,
  }))

  try {
    const reply = (
      await callUpstream({
        baseUrl: provider.base_url,
        apiKey: resolveServerApiKey(provider),
        model: persona.model_override ?? provider.model,
        temperature: 0.95,
        maxTokens: 120,
        messages: buildMomentCommentPrompt({
          persona: mapped,
          postAuthor: target.author_name,
          postContent: target.content,
          imageCount: target.image_count,
          minutesAgo: Math.max(0, Math.round((now - target.created_at) / 60_000)),
          comments,
          localTime: formatLocalTime(now, TZ_OFFSET_MIN),
        }),
        record: {
          db,
          ownerId: userId,
          conversationId: null,
          personaId: persona.id,
          providerId: provider.id,
          kind: 'moment',
        },
      })
    )
      .content
      .trim()

    if (isSkipReply(reply)) {
      momentRepo.markStatus(db, {
        personaId: persona.id,
        kind: 'comment',
        postId: target.id,
        dayKey,
        status: 'skipped',
      })
      return
    }

    // 落库成功后由动态服务把这条 pending 标成 done
    createComment(db, userId, target.id, {
      content: cleanReply(reply, 200),
      personaId: persona.id,
    })
  } catch (e) {
    log.warn({ err: e, personaId: persona.id, postId: target.id }, '角色评论生成失败')
    momentRepo.markStatus(db, {
      personaId: persona.id,
      kind: 'comment',
      postId: target.id,
      dayKey,
      status: 'failed',
    })
  }
}

async function publishMoment(
  db: DB,
  log: FastifyBaseLogger,
  ctx: PersonaContext,
): Promise<void> {
  const { userId, persona, provider, dayKey, now } = ctx

  const reserved = momentRepo.recordAction(db, {
    personaId: persona.id,
    userId,
    kind: 'post',
    dayKey,
    status: 'pending',
  })
  if (!reserved) return

  if (provider.key_location !== 'server') {
    if (!hub().isOnline(userId)) {
      momentRepo.markStatus(db, { personaId: persona.id, kind: 'post', dayKey, status: 'failed' })
      return
    }
    hub().sendToUser(userId, 'ai.moment.due', {
      taskId: ulid(),
      kind: 'post',
      personaId: persona.id,
      dueAt: now,
    })
    return
  }

  const mapped = aiRepo.mapPersona(persona)
  const recentMoments = postsRepo
    .listRecentForAi(db, now - MOMENT_AI_DEFAULTS.freshWindowMs, 6)
    .map((post) => ({ author: post.author_name, content: post.content.slice(0, 120) }))

  try {
    const reply = (
      await callUpstream({
        baseUrl: provider.base_url,
        apiKey: resolveServerApiKey(provider),
        model: persona.model_override ?? provider.model,
        temperature: 1,
        maxTokens: 200,
        messages: buildMomentPostPrompt({
          persona: mapped,
          memoryDigest: buildMemoryDigest(db, persona.id),
          recentMoments,
          localTime: formatLocalTime(now, TZ_OFFSET_MIN),
        }),
        record: {
          db,
          ownerId: userId,
          conversationId: null,
          personaId: persona.id,
          providerId: provider.id,
          kind: 'moment',
        },
      })
    )
      .content
      .trim()

    if (isSkipReply(reply)) {
      momentRepo.markStatus(db, { personaId: persona.id, kind: 'post', dayKey, status: 'skipped' })
      return
    }

    createPost(db, userId, {
      content: cleanReply(reply, 500),
      attachmentIds: [],
      visibility: 'friends',
      personaId: persona.id,
    })
  } catch (e) {
    log.warn({ err: e, personaId: persona.id }, '角色发动态失败')
    momentRepo.markStatus(db, { personaId: persona.id, kind: 'post', dayKey, status: 'failed' })
  }
}

/** 一个角色在一轮扫描里最多点赞 + 评论 + 发一条，顺序按「轻到重」 */
async function runPersona(db: DB, log: FastifyBaseLogger, ctx: PersonaContext): Promise<void> {
  const { persona, settings, dayKey, now, random } = ctx

  likeSomething(db, ctx)

  if (
    settings.momentsCommentsPerDay > 0 &&
    momentRepo.countToday(db, persona.id, 'comment', dayKey) < settings.momentsCommentsPerDay &&
    random() < COMMENT_CHANCE
  ) {
    const candidates = postsRepo
      .listRecentForAi(db, now - MOMENT_AI_DEFAULTS.freshWindowMs, 24)
      .filter((post) => post.persona_id !== persona.id)
    const done = momentRepo.commentedPostIds(
      db,
      persona.id,
      candidates.map((post) => post.id),
    )
    const target = pick(
      candidates.filter((post) => !done.has(post.id)),
      random,
    )
    if (target) await commentOnPost(db, log, ctx, target)
  }

  const hour = Math.floor(minutesOfDay(now, TZ_OFFSET_MIN) / 60)
  const inActiveHours = hour >= MOMENT_AI_DEFAULTS.activeHourStart && hour < MOMENT_AI_DEFAULTS.activeHourEnd
  if (
    settings.momentsPostsPerDay > 0 &&
    inActiveHours &&
    momentRepo.countToday(db, persona.id, 'post', dayKey) < settings.momentsPostsPerDay &&
    random() < POST_CHANCE
  ) {
    await publishMoment(db, log, ctx)
  }
}

/** 跑一轮扫描。导出以便测试与手动触发。 */
export async function scanMomentsOnce(
  db: DB,
  log: FastifyBaseLogger,
  options: { random?: () => number } = {},
): Promise<void> {
  const now = Date.now()
  const dayKey = localDayKey(now, TZ_OFFSET_MIN)
  const random = options.random ?? Math.random

  // 进程崩溃留下的 pending 会一直占着配额
  momentRepo.releaseStalePending(db, now - STALE_PENDING_MS)

  for (const userId of aiRepo.listUsersWithMomentsEnabled(db)) {
    const settings = aiRepo.readGlobalSettings(db, userId)
    if (!settings.momentsEnabled) continue

    for (const persona of aiRepo.listPersonas(db, userId)) {
      const provider = resolveProvider(db, persona)
      if (!provider) continue
      try {
        await runPersona(db, log, { userId, persona, provider, settings, dayKey, now, random })
      } catch (e) {
        log.error({ err: e, personaId: persona.id }, '角色动态互动异常')
      }
    }
  }
}

/**
 * 启动调度器，返回停止函数。
 * 测试环境不启动（否则定时器会拖住 vitest 进程）。
 */
export function startMomentsScheduler(app: FastifyInstance, db: DB): () => void {
  if (process.env.NODE_ENV === 'test') return () => {}

  const job = new Cron(MOMENT_AI_DEFAULTS.scanIntervalCron, { protect: true }, () => {
    void scanMomentsOnce(db, app.log).catch((e) => {
      app.log.error({ err: e }, '角色动态扫描失败')
    })
  })

  const kickoff = setTimeout(() => {
    void scanMomentsOnce(db, app.log).catch(() => undefined)
  }, KICKOFF_DELAY_MS)

  return () => {
    job.stop()
    clearTimeout(kickoff)
  }
}
