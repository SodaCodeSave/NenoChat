/**
 * 图片地址 → data URL。
 *
 * 截图光栅化（modern-screenshot）要求把图片内嵌为 data URL，但它的默认
 * 管线会踩两类坑：跨域 CORS 拦截、以及 blob URL 序列化进 SVG 后失效。
 * 这里统一先转 data URL；fetch 不带 cache 选项——必须与页面 <img> 的
 * 缓存行为一致：页面能显示的图截图就能拿到，页面拿不到的图不做额外
 * 破坏（尤其不能用 reload 强刷，那会使旧缓存条目失效，把页面上原本
 * 还能靠缓存显示的图片一起弄没）。
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
    const response = await fetch(url)
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
