/** 动态分享到聊天时的正文前缀与定位标记 */
export const MOMENT_SHARE_PREFIX = '[动态]'
export const MOMENT_SHARE_SCHEME = 'nenochat://moment/'

export interface MomentShareContentInput {
  postId: string
  authorName: string
  content: string
  coverUrl?: string | null
}

/** 正文里带上完整动态内容与定位标记：链接卡片式渲染，AI 也能直接读到正文 */
export function buildMomentShareContent(input: MomentShareContentInput): string {
  const body = input.content.replace(/\s+/g, ' ').trim().slice(0, 4000)
  let marker = `${MOMENT_SHARE_SCHEME}${encodeURIComponent(input.postId)}`
  if (input.coverUrl) marker += `?cover=${encodeURIComponent(input.coverUrl)}`
  return `${MOMENT_SHARE_PREFIX} ${input.authorName}：${body}\n${marker}`
}

/** 从消息正文还原动态定位信息，兼容服务端未下发 meta 的旧消息 */
export function parseMomentShare(content: string): {
  postId: string
  authorName: string
  excerpt: string
  coverUrl: string | null
} | null {
  const match = new RegExp(`${MOMENT_SHARE_SCHEME.replace(/:\/\//g, ':\\/\\/')}(\\S+)`).exec(content)
  if (!match) return null

  const [rawId = '', query = ''] = match[1]!.split('?')
  let postId = rawId
  try {
    postId = decodeURIComponent(rawId)
  } catch {
    /* 坏编码就按原文处理 */
  }
  if (!postId) return null

  let coverUrl: string | null = null
  try {
    coverUrl = new URLSearchParams(query).get('cover')
  } catch {
    coverUrl = null
  }

  const head = content.slice(0, match.index).trim()
  const line = head.split('\n').find((item) => item.startsWith(MOMENT_SHARE_PREFIX)) ?? head
  const text = line.startsWith(MOMENT_SHARE_PREFIX)
    ? line.slice(MOMENT_SHARE_PREFIX.length).trim()
    : line.trim()
  const split = text.indexOf('：')
  const authorName = (split >= 0 ? text.slice(0, split) : '用户').trim() || '用户'
  const excerpt = (split >= 0 ? text.slice(split + 1) : text).trim().slice(0, 200)

  return { postId, authorName, excerpt, coverUrl }
}

/** 列表与引用里的单行摘要：保留 [动态] 前缀，丢掉定位标记 */
export function momentSharePreview(content: string, max = 60): string | null {
  const parsed = parseMomentShare(content)
  if (!parsed) return null
  const label = `${MOMENT_SHARE_PREFIX} ${parsed.authorName}：${parsed.excerpt}`
  return label.replace(/\s+/g, ' ').trim().slice(0, max)
}
