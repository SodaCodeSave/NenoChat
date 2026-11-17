import { renderWebSearchContext, shouldSearchWeb } from '@nenochat/shared'
import type { DB } from '../db'
import * as connectorService from './connector-service'

/**
 * 为一次 AI 回复准备连接器上下文。
 * 任何一步失败都只跳过该来源，绝不让回复失败；结果只进提示词，不产生可见消息。
 */
export async function buildConnectorContext(
  db: DB,
  ownerId: string,
  text: string,
): Promise<string | null> {
  const blocks: string[] = []

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
