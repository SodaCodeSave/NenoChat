import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobToDataUrl, resolveImageDataUrl } from '@/platform/image-data-url'

/**
 * 截图光栅化依赖把图片转成 data URL。回归重点：
 * 失败必须返回 null 而不是抛错（交还默认管线降级）、同 URL 只 fetch 一次、
 * fetch 用 cache: 'no-store'（绕过无 CORS 头的陈旧缓存条目，
 * 且旁路缓存写入，不把页面 img 依赖的旧条目作废）。
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

class FakeFileReader {
  result: string | null = null
  onloadend: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob): void {
    void Promise.resolve().then(() => {
      const hook = (globalThis as Record<string, unknown>).__fakeReadAsDataURL as
        | ((blob: Blob) => string)
        | undefined
      const output = hook ? hook(blob) : `data:application/octet-stream;base64,${blob.size}`
      this.result = output
      this.onloadend?.()
    })
  }
}

function okResponse(bytes: number[] | string, contentType = 'image/png'): Response {
  const body = typeof bytes === 'string' ? bytes : new Uint8Array(bytes)
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

describe('image-data-url', () => {
  beforeEach(() => {
    vi.stubGlobal('FileReader', FakeFileReader as unknown as typeof FileReader)
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as Record<string, unknown>).__fakeReadAsDataURL
  })

  it('fetch 成功时返回 data URL，且请求带 cache: no-store', async () => {
    ;(globalThis as Record<string, unknown>).__fakeReadAsDataURL = () => 'data:image/png;base64,AAAA'
    fetchMock.mockResolvedValue(okResponse([1, 2, 3]))

    const cache = new Map<string, string>()
    const result = await resolveImageDataUrl('http://s/files/a.png', cache)

    expect(result).toBe('data:image/png;base64,AAAA')
    expect(fetchMock).toHaveBeenCalledWith('http://s/files/a.png', { cache: 'no-store' })
    expect(cache.get('http://s/files/a.png')).toBe('data:image/png;base64,AAAA')
  })

  it('同一 URL 命中缓存后不再重复 fetch', async () => {
    ;(globalThis as Record<string, unknown>).__fakeReadAsDataURL = () => 'data:image/png;base64,AAAA'
    fetchMock.mockResolvedValue(okResponse([1]))

    const cache = new Map<string, string>()
    await resolveImageDataUrl('http://s/files/a.png', cache)
    await resolveImageDataUrl('http://s/files/a.png', cache)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('非 2xx 与网络失败都返回 null 不抛错', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(resolveImageDataUrl('http://s/files/gone.png')).resolves.toBeNull()
    await expect(resolveImageDataUrl('http://s/files/net-fail.png')).resolves.toBeNull()
  })

  it('blob 为空视为失败', async () => {
    fetchMock.mockResolvedValue(okResponse([]))

    await expect(resolveImageDataUrl('http://s/files/empty.png')).resolves.toBeNull()
  })

  it('blobToDataUrl 对非 data: 结果抛错', async () => {
    ;(globalThis as Record<string, unknown>).__fakeReadAsDataURL = () => ''
    await expect(blobToDataUrl(new Blob([new Uint8Array([1])]))).rejects.toThrow('图片数据读取失败')
  })
})
