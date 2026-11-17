import type { LinkPreview } from '@nenochat/shared'
import { connectorApi } from '@/api/connectors'

/** 同一链接可能重复出现（历史消息、虚拟滚动重挂载），模块级缓存只请求一次 */
const previewCache = new Map<string, Promise<LinkPreview | null>>()

/** 缓存上限：Map 按插入序淘汰最老的链接，Promise 本身很轻，防的是长会话无界增长 */
const PREVIEW_CACHE_MAX = 300

export function loadLinkPreviewCached(url: string): Promise<LinkPreview | null> {
  const cached = previewCache.get(url)
  if (cached) return cached
  const request = connectorApi
    .linkPreview(url)
    .then((result) => result.preview)
    .catch(() => null)
  previewCache.set(url, request)
  if (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value
    if (oldest !== undefined) previewCache.delete(oldest)
  }
  return request
}
