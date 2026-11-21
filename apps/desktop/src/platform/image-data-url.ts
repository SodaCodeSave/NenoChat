/**
 * 图片地址 → data URL。
 *
 * 截图光栅化（modern-screenshot）要求把图片内嵌为 data URL，但它的默认
 * 管线会踩两类坑：跨域 CORS 拦截、以及 blob URL 序列化进 SVG 后失效。
 * 这里统一先转 data URL。fetch 用 cache: 'no-store'：
 * - 绕过 HTTP 缓存里可能残留的无 CORS 头陈旧条目（默认模式会一直命中失败）；
 * - 完全旁路缓存写入，不会像 reload 那样把旧条目作废——页面 <img> 靠
 *   旧缓存条目显示的图片不会被这次请求弄没。
 */

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = String(reader.result ?? '')
      if (result.startsWith('data:')) resolve(result)
      else reject(new Error('图片数据读取失败'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('图片数据读取失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 把图片地址转成 data URL；同一 URL 只转换一次（结果写入传入的缓存）。
 * 请求失败、非 2xx、空内容一律返回 null，由调用方决定降级方式。
 */
export async function resolveImageDataUrl(
  url: string,
  cache: Map<string, string> = new Map(),
): Promise<string | null> {
  const cached = cache.get(url)
  if (cached) return cached
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) return null
    const blob = await response.blob()
    if (blob.size === 0) return null
    const dataUrl = await blobToDataUrl(blob)
    cache.set(url, dataUrl)
    return dataUrl
  } catch {
    return null
  }
}
