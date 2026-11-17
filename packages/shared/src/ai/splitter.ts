import { ReplyStyle } from '../enums'

export interface SplitOptions {
  /** 单条消息的软长度上限，超过就开始找切点 */
  softLimit: number
  /** 找不到任何标点时的硬切长度 */
  hardLimit: number
  /** 片段合并的最小长度，避免「嗯。」这种超短独立条 */
  minMerge: number
  /** 一次回复最多分成几条，超出部分合并进最后一条 */
  maxSegments: number
}

export const SPLIT_DEFAULTS: Record<ReplyStyle, SplitOptions> = {
  [ReplyStyle.Chatty]: { softLimit: 180, hardLimit: 700, minMerge: 25, maxSegments: 8 },
  [ReplyStyle.Concise]: { softLimit: 120, hardLimit: 500, minMerge: 20, maxSegments: 4 },
  [ReplyStyle.Narrative]: { softLimit: 260, hardLimit: 900, minMerge: 40, maxSegments: 10 },
}

/** 句末标点，按这些位置断句最自然 */
const SENTENCE_BREAKS = '。！？!?…~'
/** 次级断点，句子仍然太长时退而求其次 */
const CLAUSE_BREAKS = '，,；;：:'

/** 去掉 Markdown 装饰，聊天窗里不该出现标题和星号 */
function stripMarkdownNoise(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 在每个指定标点之后断开，保留标点本身 */
function splitAfterPuncts(text: string, puncts: string): string[] {
  const out: string[] = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (puncts.includes(ch)) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf)
  return out
}

/** 拼接两段文本：拉丁字母之间补一个空格，中日韩直接相连 */
function joinText(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  const last = a[a.length - 1]!
  const first = b[0]!
  if (/[A-Za-z0-9,.;:!?)\]]/.test(last) && /[A-Za-z0-9(["']/.test(first)) {
    return `${a} ${b}`
  }
  return a + b
}

/** 把碎片累积到接近目标长度再成条 */
function mergeToLimit(pieces: string[], target: number, minMerge: number): string[] {
  const out: string[] = []
  let buf = ''
  for (const piece of pieces) {
    const trimmed = piece.trim()
    if (!trimmed) continue
    buf = joinText(buf, trimmed)
    if (buf.length >= target) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) {
    const last = out[out.length - 1]
    if (last !== undefined && buf.length < minMerge) {
      out[out.length - 1] = joinText(last, buf)
    } else {
      out.push(buf)
    }
  }
  return out
}

/** 完全没有标点可切时的兜底：按长度硬切，尽量落在空格处 */
function hardChunk(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    const space = rest.lastIndexOf(' ', limit)
    if (space > limit * 0.6) cut = space + 1
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim()) out.push(rest.trim())
  return out.filter(Boolean)
}

/** 条数超限时把尾部合并进最后一条，保证语义完整而不是截断 */
function finalize(segments: string[], opts: SplitOptions): string[] {
  const cleaned = segments.map((s) => s.trim()).filter(Boolean)
  const max = Math.max(1, opts.maxSegments)
  if (cleaned.length <= max) return cleaned
  if (max === 1) return [cleaned.reduce((acc, s) => joinText(acc, s), '')]
  const head = cleaned.slice(0, max - 1)
  const tail = cleaned.slice(max - 1).reduce((acc, s) => joinText(acc, s), '')
  return [...head, tail]
}

/**
 * 把一段 AI 长回复切成多条「像人一样分批发出」的消息。
 * 纯函数，同样的输入永远得到同样的切分。
 */
export function splitReply(
  raw: string,
  style: ReplyStyle = ReplyStyle.Chatty,
  overrides?: Partial<SplitOptions>,
): string[] {
  const opts: SplitOptions = { ...(SPLIT_DEFAULTS[style] ?? SPLIT_DEFAULTS.chatty), ...overrides }
  const text = stripMarkdownNoise(raw)
  if (!text) return []
  if (text.length <= opts.softLimit) return [text]

  const segments: string[] = []

  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    if (trimmed.length <= opts.softLimit) {
      segments.push(trimmed)
      continue
    }

    const sentences = mergeToLimit(splitAfterPuncts(trimmed, SENTENCE_BREAKS), opts.softLimit, opts.minMerge)
    for (const sentence of sentences) {
      if (sentence.length <= opts.hardLimit) {
        segments.push(sentence)
        continue
      }
      const clauses = mergeToLimit(splitAfterPuncts(sentence, CLAUSE_BREAKS), opts.softLimit, opts.minMerge)
      for (const clause of clauses) {
        if (clause.length <= opts.hardLimit) segments.push(clause)
        else segments.push(...hardChunk(clause, opts.hardLimit))
      }
    }
  }

  return finalize(segments, opts)
}

/**
 * 流式场景用的增量切分：只吐出已经确定完整的段落，
 * 剩余部分继续留在缓冲区等待更多 token。
 */
export function splitIncremental(
  buffer: string,
  style: ReplyStyle = ReplyStyle.Chatty,
  overrides?: Partial<SplitOptions>,
): { ready: string[]; rest: string } {
  const opts: SplitOptions = { ...(SPLIT_DEFAULTS[style] ?? SPLIT_DEFAULTS.chatty), ...overrides }
  const ready: string[] = []
  let rest = buffer

  for (;;) {
    const idx = rest.indexOf('\n\n')
    if (idx < 0 || idx > opts.hardLimit) break
    const head = rest.slice(0, idx).trim()
    rest = rest.slice(idx + 2)
    if (head) ready.push(...splitReply(head, style, opts))
  }

  return { ready, rest }
}

/** 两条消息之间的间隔：文字越长停顿越久，模拟真人打字节奏 */
export function segmentDelay(segment: string): number {
  const base = 320 + 12 * segment.length
  return Math.min(1600, Math.max(400, base))
}

/** 用户在设置里配置的分段规则 */
export interface SegmentRule {
  /** 关掉后整段作为一条消息发出 */
  enabled: boolean
  /** 分隔符正则，匹配到的字符归属于前一段 */
  pattern: string
}

/** 默认按句号、感叹号、问号和换行分段 */
export const SEGMENT_REPLY_DEFAULTS: SegmentRule = {
  enabled: true,
  pattern: '[。！？!?\\n]',
}

/** 一次回复最多拆成几条，超出部分合并进最后一条，避免刷屏也满足落库上限 */
const SEGMENT_MAX = 20

/** 去掉空行，只保留有内容的行 */
export function stripBlankLines(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim()
}

/** 编译用户正则；写错时退回默认规则，不影响正常回复 */
function compilePattern(pattern: string): RegExp {
  const source = pattern.trim() || SEGMENT_REPLY_DEFAULTS.pattern
  try {
    return new RegExp(source, 'g')
  } catch {
    return new RegExp(SEGMENT_REPLY_DEFAULTS.pattern, 'g')
  }
}

/** 纯标点（如连续「！！」）不单独成条，并回上一段 */
function pushPiece(out: string[], piece: string): void {
  const last = out[out.length - 1]
  if (last !== undefined && !/[\p{L}\p{N}]/u.test(piece)) {
    out[out.length - 1] = last + piece
    return
  }
  out.push(piece)
}

/**
 * 按设置里的规则把 AI 回复拆成多条消息。
 * 默认在句号、感叹号、问号和换行处断开，并清理空行；
 * 关闭分段时整段作为一条消息发出。
 */
export function splitSegments(raw: string, rule: SegmentRule = SEGMENT_REPLY_DEFAULTS): string[] {
  const text = stripBlankLines(stripMarkdownNoise(raw))
  if (!text) return []
  if (!rule.enabled) return [text]

  const regex = compilePattern(rule.pattern)
  const out: string[] = []
  let start = 0
  for (const match of text.matchAll(regex)) {
    // 零宽匹配不能当切点，否则会切出一堆无意义的空片段
    if (match[0].length === 0) continue
    const end = (match.index ?? 0) + match[0].length
    const piece = text.slice(start, end).trim()
    if (piece) pushPiece(out, piece)
    start = end
  }
  const tail = text.slice(start).trim()
  if (tail) pushPiece(out, tail)

  if (out.length <= SEGMENT_MAX) return out
  const head = out.slice(0, SEGMENT_MAX - 1)
  const rest = out.slice(SEGMENT_MAX - 1).reduce((acc, piece) => joinText(acc, piece), '')
  return [...head, rest]
}
