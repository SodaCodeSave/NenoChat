import type { StickerPackWithStickers } from '../schemas/sticker'

export type { StickerPackWithStickers }

/**
 * 表情包标记协议。
 * 模型在回复文字里写 [[sticker:表情id]]，落库前解析成真正的表情消息。
 * 上下文里给模型的是带情绪标签的编号清单，编号必须逐字来自清单，编造的一律剔除。
 */

/** 提示词里给模型看的表情条目 */
export interface StickerOption {
  id: string
  tags: string[]
}

const MARKER_PATTERN = /\[\[sticker:([A-Za-z0-9]+)\]\]/g

export interface StickerMarkerResult {
  /** 第一个有效标记对应的表情；没有有效标记时为 null */
  stickerId: string | null
  /** 去掉全部标记后的正文 */
  text: string
  /** 标记是否出现在正文之前（决定表情消息和文字消息谁先发出） */
  stickerFirst: boolean
}

/**
 * 从一段文字里解析表情标记。
 * 只认出现在 validIds 里的编号；无效标记直接从文字中剔除，当作模型没发过。
 * 无论命中多少个有效标记，只返回第一个，其余的视为噪音丢弃（防刷屏）。
 */
export function extractStickerMarker(text: string, validIds: ReadonlySet<string>): StickerMarkerResult {
  let stickerId: string | null = null
  let stickerFirst = false
  let firstMarkerAt = Number.POSITIVE_INFINITY

  for (const match of text.matchAll(MARKER_PATTERN)) {
    const id = match[1] ?? ''
    const at = match.index ?? 0
    if (!stickerId && validIds.has(id)) {
      stickerId = id
      stickerFirst = at === 0 || text.slice(0, at).trim().length === 0
      firstMarkerAt = at
    }
  }

  const cleaned = text.replace(MARKER_PATTERN, ' ').replace(/[ \t]{2,}/g, ' ').trim()
  return { stickerId, text: cleaned, stickerFirst: stickerId !== null && stickerFirst }
}

/** 只把标记从文字里剔除，不判断编号是否有效；流式气泡等展示场景用 */
export function stripStickerMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

/** 客户端从本地表情包数据里筛出允许 AI 使用、且带情绪标签的图片表情 */
export function stickerOptionsFromPacks(packs: StickerPackWithStickers[]): StickerOption[] {
  return packs
    .filter((entry) => entry.pack.allowAi && entry.pack.kind !== 'emoji')
    .flatMap((entry) =>
      entry.stickers.filter(
        (sticker) =>
          (sticker.kind === 'image' || sticker.kind === 'gif') && sticker.keywords.length > 0,
      ),
    )
    .map((sticker) => ({ id: sticker.id, tags: sticker.keywords }))
}

/** 提示词里最多列多少个表情，防止清单挤占对话上下文 */
const MAX_STICKER_OPTIONS = 60

/**
 * 表情包清单的系统提示词块。
 * 清单为空时返回空串，调用方按没有表情处理。
 */
export function renderStickerBlock(options: StickerOption[]): string {
  if (options.length === 0) return ''
  const lines = options
    .slice(0, MAX_STICKER_OPTIONS)
    .map((option) => `- [[sticker:${option.id}]]：${option.tags.join('、')}`)
  return [
    '【表情包】',
    '你可以发下面这些表情包，每个表情有一个编号：',
    ...lines,
    '使用规则：',
    '- 想发表情包时，把它的标记原样写在回复里，系统会自动转成表情消息。',
    '- 一条回复最多写一个标记，多余的会被忽略。',
    '- 只在情绪真的很合适时才发，大多数回复不需要表情包。',
    '- 不要编造清单里没有的编号，不要解释你在发表情，标记前后的文字照常写。',
  ].join('\n')
}
