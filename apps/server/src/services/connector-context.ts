import {
  buildPageSummaryPrompt,
  extractUrls,
  findBilibiliInput,
  isBilibiliUrl,
  renderBilibiliContext,
  renderFetchedPagesContext,
  renderWebSearchContext,
  shouldSearchWeb,
  type FetchedPageSummary,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as connectorService from './connector-service'
import * as bilibiliService from './bilibili-service'

export interface ConnectorContextOptions {
  /** 总结模型通道：服务端用托管密钥；客户端模式不传（由客户端自己总结） */
  summarize?: bilibiliService.VideoSummarizer
}

export interface ConnectorContextResult {
  /** B 站视频与网页搜索结果 */
  context: string | null
  /** 用户消息里链接的网页正文摘要，独立 token 预算 */
  fetchContext: string | null
}

/**
 * 为一次 AI 回复准备连接器上下文。
 * 任何一步失败都只跳过该来源，绝不让回复失败；结果只进提示词，不产生可见消息。
 */
export async function buildConnectorContext(
  db: DB,
  ownerId: string,
  text: string,
  options: ConnectorContextOptions = {},
): Promise<ConnectorContextResult> {
  const blocks: string[] = []
  let fetchContext: string | null = null

  const videoInput = findBilibiliInput(text)
  if (videoInput) {
    try {
      const material = await bilibiliService.prepareVideoMaterial(db, ownerId, videoInput)
      if (material) {
        if (options.summarize) {
          await bilibiliService.ensureVideoSummary(db, ownerId, material, options.summarize)
        }
        blocks.push(renderBilibiliContext(material))
      }
    } catch {
      /* 抓取或总结失败不阻断对话 */
    }
  }

  // 只抓当前这条用户消息里的非 B 站链接，最多 3 条；B 站链接走上面的视频流程
  const pageUrls = extractUrls(text)
    .filter((url) => !isBilibiliUrl(url))
    .slice(0, 3)
  if (pageUrls.length > 0 && options.summarize) {
    try {
      const row = connectorService.enabledConnectorOfType(db, ownerId, 'deepseek_search')
      if (row) {
        connectorService.takeRateLimit(`ai-fetch:${ownerId}`, 20, 60_000)
        const summaries: FetchedPageSummary[] = []
        for (const url of pageUrls) {
          try {
            const page = await connectorService.fetchDeepSeekPage(row, url)
            const summarized = await options.summarize(buildPageSummaryPrompt(page))
            summaries.push({
              url: page.url,
              title: page.title,
              summary: summarized.text.trim() || page.content,
            })
          } catch {
            /* 单条抓取/总结失败不影响其他链接 */
          }
        }
        fetchContext = renderFetchedPagesContext(summaries) || null
      }
    } catch {
      /* 连接器不可用或限流时静默跳过 */
    }
  }

  // 明确检索意图：走用户已启用的 DeepSeek 搜索
  if (shouldSearchWeb(text)) {
    try {
      const row = connectorService.enabledConnectorOfType(db, ownerId, 'deepseek_search')
      if (row) {
        connectorService.takeRateLimit(`ai-search:${ownerId}`, 20, 60_000)
        const results = await connectorService.searchDeepSeek(row, text)
        const block = renderWebSearchContext(text, results)
        if (block) blocks.push(block)
      }
    } catch {
      /* 搜索失败降级为不注入 */
    }
  }

  return {
    context: blocks.length > 0 ? blocks.join('\n\n') : null,
    fetchContext,
  }
}
