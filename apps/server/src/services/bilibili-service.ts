import {
  buildBilibiliSummaryPrompt,
  parseBilibiliVideoId,
  type BilibiliComment,
  type BilibiliVideoInfo,
  type BilibiliVideoMaterial,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as repo from '../db/repo/bilibili'
import {
  ConnectorRequestError,
  enabledConnectorOfType,
  fetchConnectorJson,
  readConnectorSecret,
  takeRateLimit,
  type ConnectorSecret,
} from './connector-service'
import { err } from '../util/errors'
import { assertPublicUrl } from '../util/ssrf'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const BASE_HEADERS: Record<string, string> = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
}

function biliHeaders(secret: ConnectorSecret): Record<string, string> {
  const headers = { ...BASE_HEADERS }
  if (secret.cookie) headers.cookie = secret.cookie
  return headers
}

function absolute(url: string): string {
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('http://')) return `https://${url.slice(7)}`
  return url
}

/** 把原始短链里的 p / cid 补回跳转后的地址（302 会丢弃查询参数，导致分 P 信息丢失） */
export function restoreShortLinkParams(originalUrl: string, finalUrl: string): string {
  try {
    const source = new URL(originalUrl)
    const resolved = new URL(finalUrl)
    for (const key of ['p', 'cid'] as const) {
      const value = source.searchParams.get(key)
      if (value && !resolved.searchParams.has(key)) resolved.searchParams.set(key, value)
    }
    return resolved.toString()
  } catch {
    return finalUrl
  }
}

/** b23.tv 短链需要跟随跳转拿到真实地址，并补回被跳转丢弃的分 P 参数 */
async function resolveShortUrl(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let current: URL
  try {
    current = await assertPublicUrl(url)
  } catch {
    return null
  }
  const maxHops = 5
  try {
    for (let hop = 0; hop < maxHops; hop++) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: BASE_HEADERS,
        signal: controller.signal,
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) return null
        // 每一跳都重新做 SSRF 校验，防止被跳转到内网地址
        current = await assertPublicUrl(new URL(location, current).toString())
        continue
      }
      const finalUrl = response.url || current.toString()
      return restoreShortLinkParams(url, finalUrl)
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface BilibiliVideoRequest {
  /** BV 或 av 号 */
  videoId: string
  /** 目标分 P，从 1 开始 */
  page: number
  /** URL 显式指定的 cid */
  cid: number | null
}

/**
 * 从 BV/av/URL 解析出视频标识与分 P。
 * 多 P 视频必须保留 URL 里的 p / cid，否则会退化成 P1。
 */
export function parseBilibiliVideoRequest(input: string): BilibiliVideoRequest | null {
  const text = input.trim()
  let page = 1
  let cid: number | null = null
  let isUrl = false
  try {
    const url = new URL(text)
    isUrl = true
    const p = Number(url.searchParams.get('p'))
    if (Number.isInteger(p) && p > 0) page = p
    const rawCid = Number(url.searchParams.get('cid'))
    if (Number.isInteger(rawCid) && rawCid > 0) cid = rawCid
  } catch {
    /* 裸 BV/av 号没有 URL 参数 */
  }

  const videoId = parseBilibiliVideoId(text)
  if (videoId) return { videoId, page, cid }

  // 已经是别的网站链接：不要从路径里抠 BV 号，避免抓错视频
  if (isUrl) return null

  // 整句话里夹带 BV 号
  const match = text.match(/BV[0-9A-Za-z]{10}/i)
  return match ? { videoId: `BV${match[0].slice(2)}`, page, cid } : null
}

export interface BilibiliPageRef {
  cid: number
  page: number
}

/**
 * 选出本次要抓取的 cid，并给出总结缓存键。
 * 多 P 视频按 cid 隔离缓存，避免 P1 的总结/字幕串到其他分 P。
 */
export function selectBilibiliPage(input: {
  bvid: string
  videos?: number | null
  fallbackCid?: number | null
  pages?: BilibiliPageRef[] | null
  page: number
  cid?: number | null
}): { cid: number; page: number; cacheKey: string } {
  const pages = input.pages ?? []
  const selected =
    (input.cid ? pages.find((item) => item.cid === input.cid) : undefined) ??
    pages.find((item) => item.page === input.page) ??
    pages[0]

  const cid = selected?.cid ?? input.fallbackCid ?? 0
  if (!cid) throw new ConnectorRequestError('无法获取视频分 P 信息，请稍后重试')

  const pageNo = selected?.page ?? input.page
  const multiPage = (input.videos ?? pages.length) > 1
  return {
    cid,
    page: pageNo,
    cacheKey: multiPage ? `${input.bvid}_c${cid}` : input.bvid,
  }
}

async function resolveVideoRequest(input: string): Promise<BilibiliVideoRequest | null> {
  const trimmed = input.trim()
  if (/^https?:\/\/(?:b23\.tv|bili2233\.cn)\//i.test(trimmed)) {
    const finalUrl = await resolveShortUrl(trimmed)
    return finalUrl ? parseBilibiliVideoRequest(finalUrl) : null
  }
  return parseBilibiliVideoRequest(input)
}

export interface BilibiliVideoTarget {
  info: BilibiliVideoInfo
  cid: number
  page: number
  cacheKey: string
}

/** 供链接卡片复用：解析 BV/短链并取公开视频信息 */
export async function loadVideoTarget(input: string): Promise<BilibiliVideoTarget | null> {
  const request = await resolveVideoRequest(input)
  if (!request) return null
  return fetchVideoInfo(request)
}

interface ViewPayload {
  code?: number
  message?: string
  data?: {
    bvid?: string
    aid?: number
    title?: string
    desc?: string
    pic?: string
    duration?: number
    pubdate?: number
    cid?: number
    videos?: number
    pages?: Array<{ cid?: number; page?: number; part?: string }>
    owner?: { name?: string; face?: string }
  }
}

/** 多 P 视频里找到当前选中分 P 的标题，单 P 或缺失时为 null */
function pickPartTitle(
  pages: Array<{ cid?: number; part?: string }> | undefined,
  cid: number,
  multiPage: boolean,
): string | null {
  if (!multiPage || !pages) return null
  return pages.find((item) => item.cid === cid)?.part?.trim() || null
}

async function fetchVideoInfo(request: BilibiliVideoRequest): Promise<BilibiliVideoTarget> {
  const param = request.videoId.startsWith('av')
    ? `aid=${request.videoId.slice(2)}`
    : `bvid=${request.videoId}`
  const payload = await fetchConnectorJson<ViewPayload>(
    `https://api.bilibili.com/x/web-interface/view?${param}`,
    { headers: BASE_HEADERS, timeoutMs: 12_000 },
  )
  const data = payload.data
  if (payload.code !== 0 || !data?.bvid) {
    throw new ConnectorRequestError(payload.message || '无法获取视频信息，请检查视频是否可访问')
  }

  const picked = selectBilibiliPage({
    bvid: data.bvid,
    videos: data.videos,
    fallbackCid: data.cid,
    pages: (data.pages ?? [])
      .filter(
        (item): item is { cid: number; page: number } =>
          typeof item.cid === 'number' && typeof item.page === 'number',
      )
      .map((item) => ({ cid: item.cid, page: item.page })),
    page: request.page,
    cid: request.cid,
  })

  const multiPage = (data.videos ?? 1) > 1
  const info: BilibiliVideoInfo = {
    bvid: data.bvid,
    aid: data.aid ?? 0,
    title: data.title ?? '',
    description: data.desc ?? '',
    author: data.owner?.name ?? '',
    authorAvatar: data.owner?.face ?? null,
    cover: data.pic ? absolute(data.pic) : '',
    duration: data.duration ?? 0,
    pubDate: data.pubdate ?? 0,
    url: `https://www.bilibili.com/video/${data.bvid}${picked.page > 1 ? `?p=${picked.page}` : ''}`,
    page: picked.page,
    cid: picked.cid,
    partTitle: pickPartTitle(data.pages, picked.cid, multiPage),
  }
  return { info, ...picked }
}

interface PlayerPayload {
  code?: number
  data?: {
    cid?: number
    subtitle?: {
      subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string }>
    }
  }
}

interface SubtitleBody {
  body?: Array<{ from?: number; to?: number; content?: string }>
}

/** 优先中文（含 AI 生成字幕），都没有时取第一条 */
function pickSubtitle(
  list: Array<{ lan?: string; subtitle_url?: string }>,
): { lan?: string; subtitle_url?: string } | null {
  if (list.length === 0) return null
  const preferred =
    list.find((item) => item.lan === 'zh-CN' || item.lan === 'zh-Hans') ??
    list.find((item) => item.lan?.startsWith('ai-zh')) ??
    list.find((item) => item.lan?.startsWith('zh')) ??
    list[0]
  return preferred ?? null
}

async function fetchTranscript(
  video: BilibiliVideoInfo,
  cid: number,
  secret: ConnectorSecret,
): Promise<string> {
  const headers = biliHeaders(secret)
  const player = await fetchConnectorJson<PlayerPayload>(
    `https://api.bilibili.com/x/player/v2?bvid=${video.bvid}&cid=${cid}`,
    { headers, timeoutMs: 12_000 },
  )
  const list = player.data?.subtitle?.subtitles ?? []
  const picked = pickSubtitle(list)
  if (!picked?.subtitle_url) return ''

  const body = await fetchConnectorJson<SubtitleBody>(absolute(picked.subtitle_url), {
    headers,
    timeoutMs: 12_000,
    maxBytes: 4 * 1024 * 1024,
  })
  const lines = (body.body ?? [])
    .map((item) => item.content?.trim() ?? '')
    .filter((line) => line.length > 0)
    .join('\n')
  return lines.slice(0, 12_000)
}

interface CommentsPayload {
  code?: number
  data?: {
    replies?: Array<{
      like?: number
      content?: { message?: string }
      member?: { uname?: string }
    }>
  }
}

async function fetchComments(aid: number, limit: number): Promise<BilibiliComment[]> {
  if (!aid || limit <= 0) return []
  const payload = await fetchConnectorJson<CommentsPayload>(
    `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3`,
    { headers: BASE_HEADERS, timeoutMs: 12_000 },
  )
  return (payload.data?.replies ?? [])
    .map((item) => ({
      author: item.member?.uname ?? 'B 站用户',
      content: item.content?.message?.trim() ?? '',
      like: item.like ?? 0,
    }))
    .filter((item) => item.content.length > 0)
    .slice(0, limit)
}

/**
 * 抓取视频材料：信息 + 字幕（有 Cookie 时） + 热评（无字幕时降级）。
 * 用户没有启用 B 站连接器时返回 null。
 */
export async function prepareVideoMaterial(
  db: DB,
  ownerId: string,
  input: string,
): Promise<BilibiliVideoMaterial | null> {
  const connector = enabledConnectorOfType(db, ownerId, 'bilibili')
  if (!connector) return null

  const request = await resolveVideoRequest(input)
  if (!request) throw err.validation('无法识别的 B 站视频地址')

  takeRateLimit(`bilibili:${ownerId}`, 15, 60_000)
  const secret = readConnectorSecret(connector)
  const target = await fetchVideoInfo(request)
  const video = target.info

  let transcript = ''
  try {
    transcript = await fetchTranscript(video, target.cid, secret)
  } catch {
    transcript = ''
  }

  let comments: BilibiliComment[] = []
  if (!transcript) {
    try {
      comments = await fetchComments(video.aid, connectorConfigMaxComments(connector.config))
    } catch {
      comments = []
    }
  }

  const cached = repo.findSummary(db, ownerId, target.cacheKey)
  return {
    video,
    cacheKey: target.cacheKey,
    transcript,
    comments,
    summary: cached?.summary ?? null,
    summaryModel: cached?.model ?? null,
    summaryUpdatedAt: cached?.updated_at ?? null,
  }
}

function connectorConfigMaxComments(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { maxComments?: number | null }
    const value = parsed.maxComments
    if (typeof value === 'number') return Math.min(20, Math.max(0, Math.round(value)))
  } catch {
    /* 用默认值 */
  }
  return 8
}

export type VideoSummarizer = (prompt: string) => Promise<{ text: string; model?: string | null }>

/**
 * 有缓存直接用；没有则调用传入的 summarizer（服务端或客户端各自的模型通道），
 * 总结结果按用户 + 视频（多 P 按 cid）去重缓存。失败只返回原材料，不抛错。
 */
export async function ensureVideoSummary(
  db: DB,
  ownerId: string,
  material: BilibiliVideoMaterial,
  summarize: VideoSummarizer,
): Promise<void> {
  if (material.summary?.trim()) return
  try {
    const result = await summarize(buildBilibiliSummaryPrompt(material))
    const text = result.text.trim()
    if (!text) return
    const row = repo.saveSummary(db, {
      ownerId,
      videoId: material.cacheKey,
      title: material.video.title,
      summary: text,
      model: result.model ?? null,
    })
    material.summary = row.summary
    material.summaryModel = row.model
    material.summaryUpdatedAt = row.updated_at
  } catch {
    /* 总结失败：保留标题/简介/热评，回复继续 */
  }
}

export function getCachedSummary(
  db: DB,
  ownerId: string,
  videoId: string,
): { summary: string | null; updatedAt: number | null } {
  const row = repo.findSummary(db, ownerId, videoId)
  return { summary: row?.summary ?? null, updatedAt: row?.updated_at ?? null }
}

export function saveClientSummary(
  db: DB,
  ownerId: string,
  input: { videoId: string; summary: string; model?: string; title?: string },
): void {
  repo.saveSummary(db, {
    ownerId,
    videoId: input.videoId,
    title: input.title,
    summary: input.summary,
    model: input.model,
  })
}
