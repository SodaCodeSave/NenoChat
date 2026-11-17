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

/** b23.tv 短链需要跟随跳转才能拿到真实 BV 号 */
async function resolveShortUrl(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: BASE_HEADERS,
      signal: controller.signal,
    })
    const finalUrl = response.url || url
    return parseBilibiliVideoId(finalUrl)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function resolveVideoId(input: string): Promise<string | null> {
  const direct = parseBilibiliVideoId(input)
  if (direct) return direct
  const trimmed = input.trim()
  if (/^https?:\/\/(?:b23\.tv|bili2233\.cn)\//i.test(trimmed)) {
    return resolveShortUrl(trimmed)
  }
  // 整句话里夹带 BV 号
  const match = trimmed.match(/BV[0-9A-Za-z]{10}/i)
  return match ? `BV${match[0].slice(2)}` : null
}

/** 供链接卡片复用：解析 BV / av / 短链 */
export async function resolveBilibiliVideoId(input: string): Promise<string | null> {
  return resolveVideoId(input)
}

/** 供链接卡片复用：只取公开视频信息 */
export async function getVideoInfo(videoId: string): Promise<BilibiliVideoInfo> {
  return (await fetchVideoInfo(videoId)).info
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
    owner?: { name?: string; face?: string }
  }
}

async function fetchVideoInfo(
  videoId: string,
): Promise<{ info: BilibiliVideoInfo; cid: number }> {
  const param = videoId.startsWith('av') ? `aid=${videoId.slice(2)}` : `bvid=${videoId}`
  const payload = await fetchConnectorJson<ViewPayload>(
    `https://api.bilibili.com/x/web-interface/view?${param}`,
    { headers: BASE_HEADERS, timeoutMs: 12_000 },
  )
  const data = payload.data
  if (payload.code !== 0 || !data?.bvid) {
    throw new ConnectorRequestError(payload.message || '无法获取视频信息，请检查视频是否可访问')
  }
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
    url: `https://www.bilibili.com/video/${data.bvid}`,
    page: 1,
    cid: data.cid ?? 0,
  }
  return { info, cid: data.cid ?? 0 }
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

  const videoId = await resolveVideoId(input)
  if (!videoId) throw err.validation('无法识别的 B 站视频地址')

  takeRateLimit(`bilibili:${ownerId}`, 15, 60_000)
  const secret = readConnectorSecret(connector)
  const { info: video, cid } = await fetchVideoInfo(videoId)

  let transcript = ''
  try {
    transcript = await fetchTranscript(video, cid, secret)
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

  const cached = repo.findSummary(db, ownerId, video.bvid)
  return {
    video,
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
 * 总结结果按用户 + bvid 去重缓存。失败只返回原材料，不抛错。
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
      videoId: material.video.bvid,
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
