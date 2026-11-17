import type {
  BilibiliVideoMaterial,
  ConnectorSearchResult,
} from '../entities'

/** 从一段文本里挑出 http(s) 链接，去掉末尾的中英文标点 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。；！？、）】」》]+/g

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? []
  const seen = new Set<string>()
  const urls: string[] = []
  for (const raw of matches) {
    const url = raw.replace(/[.,;!?)\]}>，。；！？）】」]+$/u, '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

/** BV 号形如 BV1xx411c7mD；也接受 av 号 */
export function parseBilibiliVideoId(input: string): string | null {
  const text = input.trim()
  if (!text) return null

  const direct = text.match(/^(?:BV[0-9A-Za-z]{10})$/i)
  if (direct) return `BV${direct[0].slice(2)}`

  const av = text.match(/^av(\d+)$/i)
  if (av) return `av${av[1]}`

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (!/(^|\.)bilibili\.com$/.test(host) && host !== 'b23.tv') return null

  const fromPath = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/i)
  if (fromPath) return `BV${fromPath[1]!.slice(2)}`
  const fromAv = url.pathname.match(/\/video\/av(\d+)/i)
  if (fromAv) return `av${fromAv[1]}`

  const bvidParam = url.searchParams.get('bvid')
  if (bvidParam && /^BV[0-9A-Za-z]{10}$/i.test(bvidParam)) {
    return `BV${bvidParam.slice(2)}`
  }
  const aidParam = url.searchParams.get('aid')
  if (aidParam && /^\d+$/.test(aidParam)) return `av${aidParam}`
  return null
}

/** 输入里是否包含 B 站视频链接或 BV 号 */
export function findBilibiliVideoId(text: string): string | null {
  const direct = parseBilibiliVideoId(text)
  if (direct) return direct
  const bv = text.match(/BV[0-9A-Za-z]{10}/i)
  if (bv) return `BV${bv[0].slice(2)}`
  return null
}

/** 从消息里找出要交给服务端抓取的 B 站输入：完整链接（含短链）或裸 BV 号 */
export function findBilibiliInput(text: string): string | null {
  for (const url of extractUrls(text)) {
    if (parseBilibiliVideoId(url)) return url
    if (/^https?:\/\/(?:b23\.tv|bili2233\.cn)\//i.test(url)) return url
  }
  return findBilibiliVideoId(text)
}

/**
 * 搜索触发词：只在用户明确表达「要查外部信息」时联网。
 * 不做全量搜索，避免每条消息都产生费用与额外延迟。
 */
const SEARCH_KEYWORDS = [
  '搜索',
  '搜一下',
  '搜搜',
  '搜下',
  '查一下',
  '查查',
  '查一查',
  '帮我查',
  '帮我搜',
  '网上查',
  '上网查',
  '联网',
  '最新',
  '新闻',
  'search',
  'look up',
]

export function shouldSearchWeb(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  // 纯链接消息不触发搜索，交给链接卡片
  const withoutUrls = trimmed.replace(URL_PATTERN, '').trim()
  if (withoutUrls.length < 2) return false
  const haystack = withoutUrls.toLowerCase()
  return SEARCH_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()))
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/** 把搜索命中的网页资料渲染成给模型看的系统块 */
export function renderWebSearchContext(
  query: string,
  results: ConnectorSearchResult[],
): string {
  const usable = results.filter((item) => item.title && item.url).slice(0, 6)
  if (usable.length === 0) return ''
  const lines = usable.map((item, index) => {
    const parts = [`${index + 1}. ${item.title}`]
    if (item.siteName) parts.push(`（${item.siteName}）`)
    parts.push(`\n   URL：${item.url}`)
    const body = item.summary?.trim() || item.snippet?.trim()
    if (body) parts.push(`\n   摘要：${clip(body, 600)}`)
    return parts.join('')
  })
  return [
    '【联网检索资料】',
    `用户这句话需要外部信息，下面是刚用「${clip(query, 60)}」检索到的网页结果。`,
    '这些资料可能不完整或过时：只采用和问题相关的内容，不要编造资料里没有的事实或链接。',
    ...lines,
  ].join('\n')
}

/** 把 B 站视频材料渲染成给模型看的系统块；无字幕时明确标注 */
export function renderBilibiliContext(material: BilibiliVideoMaterial): string {
  const { video, transcript, comments, summary } = material
  const lines: string[] = [
    '【B 站视频资料】',
    `标题：${video.title}`,
    `作者：${video.author}`,
    `链接：${video.url}`,
  ]
  if (video.description.trim()) lines.push(`简介：${clip(video.description, 800)}`)

  if (transcript.trim()) {
    lines.push(`字幕转写（可能有识别误差）：\n${clip(transcript, 6000)}`)
  } else {
    lines.push(
      '该视频没有可用字幕，以下内容来自标题、简介与热评，属于间接信息；回答时不要假装看过视频画面。',
    )
    if (comments.length > 0) {
      const hot = comments
        .slice(0, 8)
        .map((item, index) => `${index + 1}. ${item.author}（${item.like} 赞）：${clip(item.content, 160)}`)
      lines.push(`热评：\n${hot.join('\n')}`)
    }
  }

  if (summary?.trim()) {
    lines.push(`已有的视频总结（可直接当作你已知的内容）：\n${clip(summary, 1200)}`)
  }
  return lines.join('\n')
}

/** 总结 B 站视频时给模型的任务说明 */
export function buildBilibiliSummaryPrompt(material: BilibiliVideoMaterial): string {
  const { video, transcript, comments } = material
  const header = `视频标题：${video.title}\n作者：${video.author}\n简介：${clip(video.description, 1200)}`
  if (transcript.trim()) {
    return [
      header,
      `字幕转写（可能有识别误差）：\n${clip(transcript, 12000)}`,
      '请用中文写一段 300-600 字的视频内容总结，说明视频讲了什么、关键观点或步骤、适合谁看。' +
        '只依据给到的字幕，不要编造视频里没出现的信息。',
    ].join('\n\n')
  }
  const hot = comments
    .slice(0, 10)
    .map((item, index) => `${index + 1}. ${item.author}（${item.like} 赞）：${clip(item.content, 200)}`)
    .join('\n')
  return [
    header,
    '该视频没有可用字幕，以下为热门评论（可能带有观众主观评价）：',
    hot || '（没有抓取到评论）',
    '请用中文写一段 200-400 字的视频大致内容总结：结合标题、简介与热评推断主题与看点，' +
      '明确说明这是基于简介与评论的归纳、不是逐字内容，不要编造具体台词或画面细节。',
  ].join('\n\n')
}
