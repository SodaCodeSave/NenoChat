import type { AiDebugSummary, AiGroupDecision, AiUsageEntry, AiUsageKind } from '@nenochat/shared'
import { ulid } from '@nenochat/shared'
import type { DB } from '../index'
import { now } from '../../util/clock'

/* ------------------------------ usage 落库 ------------------------------ */

export interface InsertUsageInput {
  ownerId: string
  conversationId?: string | null
  personaId?: string | null
  providerId?: string | null
  kind: AiUsageKind
  refId?: string | null
  model?: string | null
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
}

export function insertUsage(db: DB, input: InsertUsageInput): AiUsageEntry {
  const id = ulid()
  const ts = now()
  db.prepare(
    `INSERT INTO ai_usage_log
       (id, owner_id, conversation_id, persona_id, provider_id, kind, ref_id, model,
        prompt_tokens, completion_tokens, cached_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ownerId,
    input.conversationId ?? null,
    input.personaId ?? null,
    input.providerId ?? null,
    input.kind,
    input.refId ?? null,
    input.model ?? null,
    input.promptTokens,
    input.completionTokens,
    input.cachedTokens ?? 0,
    ts,
  )
  return {
    id,
    ownerId: input.ownerId,
    conversationId: input.conversationId ?? null,
    personaId: input.personaId ?? null,
    providerId: input.providerId ?? null,
    kind: input.kind,
    refId: input.refId ?? null,
    model: input.model ?? null,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    cachedTokens: input.cachedTokens ?? 0,
    createdAt: ts,
  }
}

interface UsageRow {
  id: string
  owner_id: string
  conversation_id: string | null
  persona_id: string | null
  provider_id: string | null
  kind: string
  ref_id: string | null
  model: string | null
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  created_at: number
}

function mapUsage(row: UsageRow): AiUsageEntry {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    personaId: row.persona_id,
    providerId: row.provider_id,
    kind: row.kind as AiUsageEntry['kind'],
    refId: row.ref_id,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
    createdAt: row.created_at,
  }
}

/** 按 refId 查最近一条 usage（群聊 logId / 私聊 generationId） */
export function findUsageByRef(db: DB, refId: string): AiUsageEntry | null {
  const row = db
    .prepare('SELECT * FROM ai_usage_log WHERE ref_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(refId) as UsageRow | undefined
  return row ? mapUsage(row) : null
}

/** 按 refId 批量查：每个 ref 取最近一条。ownerId 是硬过滤，只返回主人自己的记录 */
export function findUsageByRefs(
  db: DB,
  ownerId: string,
  refIds: string[],
): Record<string, AiUsageEntry> {
  const output: Record<string, AiUsageEntry> = {}
  const statement = db.prepare(
    'SELECT * FROM ai_usage_log WHERE ref_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1',
  )
  for (const refId of refIds) {
    const row = statement.get(refId, ownerId) as UsageRow | undefined
    if (row) output[refId] = mapUsage(row)
  }
  return output
}

interface UsageAggRow {
  calls: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  last_prompt_tokens: number | null
  last_model: string | null
  last_at: number | null
  last_provider_id: string | null
}

function aggregate(db: DB, whereSql: string, param: string): UsageAggRow {
  const sums = db
    .prepare(
      `SELECT
         COUNT(*) AS calls,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(cached_tokens), 0) AS cached_tokens
       FROM ai_usage_log u
       WHERE ${whereSql}`,
    )
    .get(param) as Pick<UsageAggRow, 'calls' | 'prompt_tokens' | 'completion_tokens' | 'cached_tokens'>

  const last = db
    .prepare(
      `SELECT prompt_tokens, model, created_at, provider_id
       FROM ai_usage_log
       WHERE ${whereSql}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(param) as
    | { prompt_tokens: number; model: string | null; created_at: number; provider_id: string | null }
    | undefined

  return {
    ...sums,
    last_prompt_tokens: last?.prompt_tokens ?? null,
    last_model: last?.model ?? null,
    last_at: last?.created_at ?? null,
    last_provider_id: last?.provider_id ?? null,
  }
}

/** 会话内聚合 usage，并补上上下文水位信息 */
export function debugSummary(
  db: DB,
  conversationId: string,
  context: { contextWindow: number | null; lastCompactedSeq: number | null; tokenEstimate: number | null },
): AiDebugSummary {
  const row = aggregate(db, 'u.conversation_id = ?', conversationId)
  const hitRate =
    row.prompt_tokens > 0 ? row.cached_tokens / row.prompt_tokens : null
  const contextLevel =
    context.contextWindow && row.last_prompt_tokens
      ? Math.min(1, row.last_prompt_tokens / context.contextWindow)
      : null
  return {
    calls: row.calls,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
    hitRate,
    lastPromptTokens: row.last_prompt_tokens,
    lastModel: row.last_model,
    lastUsageAt: row.last_at,
    contextWindow: context.contextWindow,
    contextLevel,
    lastCompactedSeq: context.lastCompactedSeq,
    tokenEstimate: context.tokenEstimate,
  }
}

/* ------------------------------ 群聊决策记录 ------------------------------ */

export interface InsertDecisionInput {
  conversationId: string
  personaId: string
  personaName: string
  triggerMessageId?: string | null
  kind: 'reply' | 'autonomy'
  fired: boolean
  stage: 'rules' | 'model'
  reason?: string | null
  energy?: number | null
  mood?: string | null
  logId?: string | null
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number } | null
}

interface DecisionRow {
  id: string
  conversation_id: string
  persona_id: string
  persona_name: string
  trigger_message_id: string | null
  kind: string
  fired: number
  stage: string
  reason: string | null
  energy: number | null
  mood: string | null
  log_id: string | null
  created_at: number
}

function mapDecision(db: DB, row: DecisionRow): AiGroupDecision {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    personaId: row.persona_id,
    personaName: row.persona_name,
    triggerMessageId: row.trigger_message_id,
    kind: row.kind as AiGroupDecision['kind'],
    fired: row.fired === 1,
    stage: row.stage as AiGroupDecision['stage'],
    reason: row.reason,
    energy: row.energy,
    mood: row.mood,
    logId: row.log_id,
    usage: row.log_id ? usageOfDecision(db, row.log_id) : null,
    createdAt: row.created_at,
  }
}

function usageOfDecision(db: DB, logId: string): AiGroupDecision['usage'] {
  const usage = findUsageByRef(db, logId)
  if (!usage) return null
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
  }
}

export function insertDecision(db: DB, input: InsertDecisionInput): AiGroupDecision {
  const id = ulid()
  const ts = now()
  db.prepare(
    `INSERT INTO ai_group_decision
       (id, conversation_id, persona_id, persona_name, trigger_message_id,
        kind, fired, stage, reason, energy, mood, log_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.personaId,
    input.personaName,
    input.triggerMessageId ?? null,
    input.kind,
    input.fired ? 1 : 0,
    input.stage,
    input.reason ?? null,
    input.energy ?? null,
    input.mood ?? null,
    input.logId ?? null,
    ts,
  )
  return {
    id,
    conversationId: input.conversationId,
    personaId: input.personaId,
    personaName: input.personaName,
    triggerMessageId: input.triggerMessageId ?? null,
    kind: input.kind,
    fired: input.fired,
    stage: input.stage,
    reason: input.reason ?? null,
    energy: input.energy ?? null,
    mood: input.mood ?? null,
    logId: input.logId ?? null,
    usage: input.usage ?? null,
    createdAt: ts,
  }
}

export interface DecisionOutcomeInput {
  stage: 'model'
  reason: string | null
  fired?: boolean
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number } | null
}

/** 模型层产出后回填到规则层放行时创建的那条决策记录上，返回回填后的完整记录 */
export function updateDecisionOutcome(db: DB, logId: string, patch: DecisionOutcomeInput): AiGroupDecision | null {
  const row = db
    .prepare(
      'SELECT id FROM ai_group_decision WHERE log_id = ? AND stage = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(logId, 'rules') as { id: string } | undefined
  if (!row) return null
  db.prepare(
    'UPDATE ai_group_decision SET stage = ?, reason = ?, fired = ? WHERE id = ?',
  ).run('model', patch.reason, (patch.fired ?? true) ? 1 : 0, row.id)

  const updated = db.prepare('SELECT * FROM ai_group_decision WHERE id = ?').get(row.id) as
    | DecisionRow
    | undefined
  return updated ? mapDecision(db, updated) : null
}

/** 会话最近的决策记录，新在前 */
export function listDecisions(db: DB, conversationId: string, limit: number): AiGroupDecision[] {
  const rows = db
    .prepare(
      `SELECT * FROM ai_group_decision
       WHERE conversation_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversationId, limit) as DecisionRow[]
  return rows.map((row) => mapDecision(db, row))
}
