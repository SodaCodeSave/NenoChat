import dns from 'node:dns/promises'
import net from 'node:net'
import type { LinkPreview } from '@nenochat/shared'
import { parseBilibiliVideoId } from '@nenochat/shared'
import type { DB } from '../db'
import * as repo from '../db/repo/link-previews'
import { sha256 } from '../util/crypto'
import {
  enabledConnectorOfType,
  takeRateLimit,
} from './connector-service'
import {
  getCachedSummary,
  loadVideoTarget,
} from './bilibili-service'

/** 元信息缓存 7 天，过期后重新抓取 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000
const MAX_BODY_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((part) => Number(part))
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1]!)
    return false
  }
  return false
}

/** SSRF 防护：只允许 http(s)，解析域名后拒绝回环、内网、链路本地与保留地址 */
async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('不支持的链接协议')
  }
  if (url.username || url.password) throw new Error('链接不能包含账号密码')

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new Error('链接缺少域名')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问内网地址')
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问内网地址')
    return url
  }

  const records = await dns.lookup(host, { all: true, verbatim: true })
  if (records.length === 0) throw new Error('域名无法解析')
  for (const record of records) {
    if (isPrivateIp(record.address)) throw new Error('不允许访问内网地址')
  }
  return url
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('页面内容过大')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/** 手动跟随跳转，每一跳都重新做 SSRF 校验 */
async function fetchHtml(rawUrl: string): Promise<{ html: string; finalUrl: string } | null> {
  let current = await assertPublicUrl(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(current.toString(), {
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: controller.signal,
      })

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) return null
        current = await assertPublicUrl(new URL(location, current).toString())
        continue
      }
      if (!response.ok) return null

      const type = response.headers.get('content-type') ?? ''
      if (!type.includes('text/html') && !type.includes('application/xhtml')) return null

      const html = await readLimited(response, MAX_BODY_BYTES)
      return { html, finalUrl: current.toString() }
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1]?.toLowerCase() === 'x'
      const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : match
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match
  })
}

function clean(text: string | null | undefined, limit = 400): string | null {
  if (!text) return null
  const value = decodeEntities(text).replace(/\s+/g, ' ').trim()
  if (!value) return null
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function metaContent(html: string, key: string): string | null {
  const escaped = escapeRegExp(key)
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

function parseHtmlMeta(
  html: string,
  baseUrl: string,
): { title: string | null; description: string | null; image: string | null; siteName: string | null } {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = clean(metaContent(html, 'og:title') ?? titleTag?.[1], 200)
  const description = clean(
    metaContent(html, 'og:description') ??
      metaContent(html, 'description') ??
      metaContent(html, 'twitter:description'),
  )
  const siteName = clean(
    metaContent(html, 'og:site_name') ?? new URL(baseUrl).hostname.replace(/^www\./, ''),
    80,
  )

  const rawImage =
    metaContent(html, 'og:image') ??
    metaContent(html, 'twitter:image') ??
    metaContent(html, 'twitter:image:src')
  let image: string | null = null
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage), baseUrl)
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') image = resolved.toString()
    } catch {
      image = null
    }
  }
  return { title, description, image, siteName }
}

function withSummary(db: DB, ownerId: string, preview: LinkPreview): LinkPreview {
  if (preview.kind !== 'bilibili' || !preview.videoId) return preview
  const cached = getCachedSummary(db, ownerId, preview.videoId)
  return { ...preview, hasSummary: Boolean(cached.summary) }
}

/**
 * 抓取链接卡片元信息：B 站链接在启用连接器时走视频接口，其余走网页 meta。
 * 任何失败都返回 null，客户端保留纯链接，不报错。
 */
export async function getLinkPreview(
  db: DB,
  ownerId: string,
  rawUrl: string,
): Promise<LinkPreview | null> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const normalized = url.toString()
  const urlHash = sha256(normalized)
  const cached = repo.findLinkPreview(db, urlHash)
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return withSummary(db, ownerId, repo.mapLinkPreview(cached))
  }

  takeRateLimit(`link-preview:${ownerId}`, 60, 60_000)

  try {
    const bilibiliEnabled = Boolean(enabledConnectorOfType(db, ownerId, 'bilibili'))
    const looksBilibili =
      /(^|\.)bilibili\.com$/i.test(url.hostname) ||
      url.hostname === 'b23.tv' ||
      url.hostname === 'bili2233.cn' ||
      Boolean(parseBilibiliVideoId(normalized))

    if (bilibiliEnabled && looksBilibili) {
      const target = await loadVideoTarget(normalized)
      if (target) {
        const video = target.info
        const row = repo.saveLinkPreview(db, {
          urlHash,
          url: normalized,
          kind: 'bilibili',
          title: clean(video.title, 200),
          description: clean(video.description),
          image: video.cover || null,
          siteName: '哔哩哔哩',
          author: clean(video.author, 80),
          videoId: target.cacheKey,
        })
        return withSummary(db, ownerId, repo.mapLinkPreview(row))
      }
    }

    const page = await fetchHtml(normalized)
    if (!page) return null
    const meta = parseHtmlMeta(page.html, page.finalUrl)
    if (!meta.title && !meta.description) return null
    const row = repo.saveLinkPreview(db, {
      urlHash,
      url: normalized,
      kind: 'website',
      title: meta.title,
      description: meta.description,
      image: meta.image,
      siteName: meta.siteName,
    })
    return repo.mapLinkPreview(row)
  } catch {
    return null
  }
}
