import {
  findBilibiliInput,
  renderBilibiliContext,
  renderWebSearchContext,
  shouldSearchWeb,
} from '@nenochat/shared'
import type { DB } from '../db'
import * as connectorService from './connector-service'
import * as bilibiliService from './bilibili-service'

export interface ConnectorContextOptions {
  /** B 站总结模型通道：服务端用托管密钥，客户端模式不传（由客户端自己总结） */
  summarize?: bilibiliService.VideoSummarizer
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
): Promise<string | null> {
  const blocks: string[] = []

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

  return blocks.length > 0 ? blocks.join('\n\n') : null
}
