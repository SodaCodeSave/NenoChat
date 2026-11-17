import type { LinkPreview } from '@nenochat/shared'
import { connectorApi } from '@/api/connectors'

/** 同一链接可能重复出现（历史消息、虚拟滚动重挂载），模块级缓存只请求一次 */
const previewCache = new Map<string, Promise<LinkPreview | null>>()

export function loadLinkPreviewCached(url: string): Promise<LinkPreview | null> {
  const cached = previewCache.get(url)
  if (cached) return cached
  const request = connectorApi
    .linkPreview(url)
    .then((result) => result.preview)
    .catch(() => null)
  previewCache.set(url, request)
  return request
}
