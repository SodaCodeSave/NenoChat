import type { DB } from '../db'
import * as aiRepo from '../db/repo/ai'

/**
 * 各调度器共用的小工具：目前只有记忆摘要的拼装。
 * 输出格式必须保持一致 —— 主动私聊与角色动态都把它塞进提示词的「你记得的事」。
 */

/** 记忆摘要 + 事实，按行拼成提示词里的「你记得的事」段落 */
export function buildMemoryDigest(db: DB, conversationId: string): string {
  const summary = aiRepo.latestSummary(db, conversationId)
  const facts = aiRepo.listFacts(db, conversationId).map(aiRepo.mapFact)
  return [summary?.summary ?? '', ...facts.map((fact) => `${fact.key}: ${fact.value}`)]
    .filter((line) => line.length > 0)
    .join('\n')
}
