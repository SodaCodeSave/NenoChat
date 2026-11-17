import { describe, expect, it } from 'vitest'
import {
  extractStickerMarker,
  renderStickerBlock,
  stickerOptionsFromPacks,
  stripStickerMarkers,
  type StickerPackWithStickers,
} from './sticker-markers'

const ids = new Set(['ABC1', 'DEF2'])

describe('extractStickerMarker', () => {
  it('解析正文中间的标记并剔除', () => {
    const result = extractStickerMarker('哈哈哈太好笑了 [[sticker:ABC1]]', ids)
    expect(result.stickerId).toBe('ABC1')
    expect(result.text).toBe('哈哈哈太好笑了')
    expect(result.stickerFirst).toBe(false)
  })

  it('标记在开头时表情先发', () => {
    const result = extractStickerMarker('[[sticker:ABC1]] 来了来了', ids)
    expect(result.stickerId).toBe('ABC1')
    expect(result.text).toBe('来了来了')
    expect(result.stickerFirst).toBe(true)
  })

  it('只有标记时返回空正文', () => {
    const result = extractStickerMarker('[[sticker:DEF2]]', ids)
    expect(result.stickerId).toBe('DEF2')
    expect(result.text).toBe('')
    expect(result.stickerFirst).toBe(true)
  })

  it('编造的编号按噪音剔除，不产生表情', () => {
    const result = extractStickerMarker('看这个 [[sticker:FAKE9]]', ids)
    expect(result.stickerId).toBeNull()
    expect(result.text).toBe('看这个')
  })

  it('多个有效标记只保留第一个（防刷屏）', () => {
    const result = extractStickerMarker('[[sticker:ABC1]] 还有 [[sticker:DEF2]]', ids)
    expect(result.stickerId).toBe('ABC1')
    expect(result.text).toBe('还有')
  })

  it('模型换了写法（少一层括号）不误判', () => {
    const result = extractStickerMarker('[sticker:ABC1] 哈哈', ids)
    expect(result.stickerId).toBeNull()
    expect(result.text).toBe('[sticker:ABC1] 哈哈')
  })

  it('没有标记时原文原样返回', () => {
    expect(extractStickerMarker('普通一句话', ids)).toEqual({
      stickerId: null,
      text: '普通一句话',
      stickerFirst: false,
    })
  })
})

describe('stripStickerMarkers', () => {
  it('剔除所有标记，无论编号是否有效', () => {
    expect(stripStickerMarkers('前 [[sticker:ABC1]] 中 [[sticker:X]] 后')).toBe('前 中 后')
  })
})

describe('stickerOptionsFromPacks', () => {
  const pack = (allowAi: boolean, kind: 'image' | 'emoji' = 'image'): StickerPackWithStickers['pack'] => ({
    id: 'p1',
    name: '包',
    kind,
    allowAi,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
  })

  it('只收「允许 AI 使用」且带标签的图片表情', () => {
    const packs: StickerPackWithStickers[] = [
      {
        pack: pack(true),
        stickers: [
          { id: 'S1', packId: 'p1', kind: 'image', keywords: ['开心'], position: 0, createdAt: 0, updatedAt: 0 },
          { id: 'S2', packId: 'p1', kind: 'image', keywords: [], position: 1, createdAt: 0, updatedAt: 0 },
          { id: 'S3', packId: 'p1', kind: 'gif', keywords: ['庆祝'], position: 2, createdAt: 0, updatedAt: 0 },
        ],
      },
      {
        pack: pack(false),
        stickers: [
          { id: 'S4', packId: 'p1', kind: 'image', keywords: ['无语'], position: 0, createdAt: 0, updatedAt: 0 },
        ],
      },
      {
        pack: pack(true, 'emoji'),
        stickers: [
          { id: 'S5', packId: 'p1', kind: 'unicode', value: '😀', keywords: ['笑'], position: 0, createdAt: 0, updatedAt: 0 },
        ],
      },
    ]
    expect(stickerOptionsFromPacks(packs)).toEqual([
      { id: 'S1', tags: ['开心'] },
      { id: 'S3', tags: ['庆祝'] },
    ])
  })
})

describe('renderStickerBlock', () => {
  it('空清单返回空串', () => {
    expect(renderStickerBlock([])).toBe('')
  })

  it('清单包含标记格式、标签与使用规则', () => {
    const block = renderStickerBlock([{ id: 'ABC1', tags: ['开心', '庆祝'] }])
    expect(block).toContain('[[sticker:ABC1]]：开心、庆祝')
    expect(block).toContain('最多写一个标记')
  })
})
