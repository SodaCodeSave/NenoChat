import { describe, expect, it } from 'vitest'
import { parseBilibiliVideoRequest, selectBilibiliPage } from '../src/services/bilibili-service'

describe('parseBilibiliVideoRequest', () => {
  it('保留 URL 里的分 P 与 cid', () => {
    expect(
      parseBilibiliVideoRequest('https://www.bilibili.com/video/BV1GJ411x7h7?p=2&cid=999'),
    ).toEqual({ videoId: 'BV1GJ411x7h7', page: 2, cid: 999 })
  })

  it('裸 BV / av 号默认第一 P', () => {
    expect(parseBilibiliVideoRequest('BV1GJ411x7h7')).toEqual({
      videoId: 'BV1GJ411x7h7',
      page: 1,
      cid: null,
    })
    expect(parseBilibiliVideoRequest('av170001')).toEqual({
      videoId: 'av170001',
      page: 1,
      cid: null,
    })
  })

  it('非 B 站输入返回 null', () => {
    expect(parseBilibiliVideoRequest('https://example.com/video/BV1GJ411x7h7')).toBeNull()
    expect(parseBilibiliVideoRequest('随便说点什么')).toBeNull()
  })
})

describe('selectBilibiliPage', () => {
  const pages = [
    { cid: 111, page: 1 },
    { cid: 222, page: 2 },
  ]

  it('多 P 按页码取对应 cid，缓存键按 cid 隔离', () => {
    expect(
      selectBilibiliPage({ bvid: 'BV1GJ411x7h7', videos: 2, pages, page: 2, cid: null }),
    ).toEqual({ cid: 222, page: 2, cacheKey: 'BV1GJ411x7h7_c222' })
  })

  it('URL 显式指定 cid 时优先匹配该分 P', () => {
    expect(
      selectBilibiliPage({ bvid: 'BV1GJ411x7h7', videos: 2, pages, page: 2, cid: 111 }),
    ).toEqual({ cid: 111, page: 1, cacheKey: 'BV1GJ411x7h7_c111' })
  })

  it('单 P 视频沿用 bvid 作为缓存键', () => {
    expect(
      selectBilibiliPage({
        bvid: 'BV1GJ411x7h7',
        videos: 1,
        pages: [{ cid: 111, page: 1 }],
        page: 1,
        cid: null,
      }),
    ).toEqual({ cid: 111, page: 1, cacheKey: 'BV1GJ411x7h7' })
  })

  it('同一视频的不同分 P 不会共享缓存键', () => {
    const first = selectBilibiliPage({
      bvid: 'BV1GJ411x7h7',
      videos: 2,
      pages,
      page: 1,
      cid: null,
    })
    const second = selectBilibiliPage({
      bvid: 'BV1GJ411x7h7',
      videos: 2,
      pages,
      page: 2,
      cid: null,
    })
    expect(first.cacheKey).not.toBe(second.cacheKey)
  })

  it('两个不同视频的缓存键互不相同', () => {
    const a = selectBilibiliPage({
      bvid: 'BV1GJ411x7h7',
      videos: 1,
      pages: [{ cid: 111, page: 1 }],
      page: 1,
      cid: null,
    })
    const b = selectBilibiliPage({
      bvid: 'BV1xx411c7mD',
      videos: 1,
      pages: [{ cid: 999, page: 1 }],
      page: 1,
      cid: null,
    })
    expect(a.cacheKey).not.toBe(b.cacheKey)
  })

  it('接口没有返回分 P 列表时退回兜底 cid', () => {
    expect(
      selectBilibiliPage({ bvid: 'BV1GJ411x7h7', fallbackCid: 333, page: 1, cid: null }),
    ).toEqual({ cid: 333, page: 1, cacheKey: 'BV1GJ411x7h7' })
  })

  it('拿不到 cid 时抛错，避免用 0 去请求别的视频字幕', () => {
    expect(() =>
      selectBilibiliPage({ bvid: 'BV1GJ411x7h7', page: 1, cid: null }),
    ).toThrow('无法获取视频分 P 信息')
  })
})
