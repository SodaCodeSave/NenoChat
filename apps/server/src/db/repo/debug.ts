import type { AiDebugSummary, AiGroupDecision, AiUsageEntry, AiUsageKind } from '@nenochat/shared'
import { ulid } from '@nenochat/shared'
import { all, one, run, type Executor } from '../index'
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

export async function insertUsage(db: Executor, input: InsertUsageInput): Promise<AiUsageEntry> {
  const id = ulid()
  const ts = now()
  await run(
    db,
    `INSERT INTO ai_usage_log
       (id, owner_id, conversation_id, persona_id, provider_id, kind, ref_id, model,
        prompt_tokens, completion_tokens, cached_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
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
export async function findUsageByRef(db: Executor, refId: string): Promise<AiUsageEntry | null> {
  const row = await one<UsageRow>(
    db,
    'SELECT * FROM ai_usage_log WHERE ref_id = ? ORDER BY created_at DESC LIMIT 1',
    [refId],
  )
  return row ? mapUsage(row) : null
}

/** 按 refId 批量查：每个 ref 取最近一条。ownerId 是硬过滤，只返回主人自己的记录 */
export async function findUsageByRefs(
  db: Executor,
  ownerId: string,
  refIds: string[],
): Promise<Record<string, AiUsageEntry>> {
  const output: Record<string, AiUsageEntry> = {}
  for (const refId of refIds) {
    const row = await one<UsageRow>(
      db,
      'SELECT * FROM ai_usage_log WHERE ref_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1',
      [refId, ownerId],
    )
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

async function aggregate(db: Executor, whereSql: string, param: string): Promise<UsageAggRow> {
  const sums = await one<
    Pick<UsageAggRow, 'calls' | 'prompt_tokens' | 'completion_tokens' | 'cached_tokens'>
  >(
    db,
    `SELECT
       COUNT(*) AS calls,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
       COALESCE(SUM(cached_tokens), 0) AS cached_tokens
     FROM ai_usage_log u
     WHERE ${whereSql}`,
    [param],
  )

  const last = await one<{
    prompt_tokens: number
    model: string | null
    created_at: number
    provider_id: string | null
  }>(
    db,
    `SELECT prompt_tokens, model, created_at, provider_id
     FROM ai_usage_log
     WHERE ${whereSql}
     ORDER BY created_at DESC LIMIT 1`,
    [param],
  )

  return {
    calls: sums?.calls ?? 0,
    prompt_tokens: sums?.prompt_tokens ?? 0,
    completion_tokens: sums?.completion_tokens ?? 0,
    cached_tokens: sums?.cached_tokens ?? 0,
    last_prompt_tokens: last?.prompt_tokens ?? null,
    last_model: last?.model ?? null,
    last_at: last?.created_at ?? null,
    last_provider_id: last?.provider_id ?? null,
  }
}

/** 会话内聚合 usage，并补上上下文水位信息 */
export async function debugSummary(
  db: Executor,
  conversationId: string,
  context: { contextWindow: number | null; lastCompactedSeq: number | null; tokenEstimate: number | null },
): Promise<AiDebugSummary> {
  const row = await aggregate(db, 'u.conversation_id = ?', conversationId)
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

async function mapDecision(db: Executor, row: DecisionRow): Promise<AiGroupDecision> {
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
    usage: row.log_id ? await usageOfDecision(db, row.log_id) : null,
    createdAt: row.created_at,
  }
}

async function usageOfDecision(db: Executor, logId: string): Promise<AiGroupDecision['usage']> {
  const usage = await findUsageByRef(db, logId)
  if (!usage) return null
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
  }
}

export async function insertDecision(db: Executor, input: InsertDecisionInput): Promise<AiGroupDecision> {
  const id = ulid()
  const ts = now()
  await run(
    db,
    `INSERT INTO ai_group_decision
       (id, conversation_id, persona_id, persona_name, trigger_message_id,
        kind, fired, stage, reason, energy, mood, log_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
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
export async function updateDecisionOutcome(db: Executor, logId: string, patch: DecisionOutcomeInput): Promise<AiGroupDecision | null> {
  const row = await one<{ id: string }>(
    db,
    'SELECT id FROM ai_group_decision WHERE log_id = ? AND stage = ? ORDER BY created_at DESC LIMIT 1',
    [logId, 'rules'],
  )
  if (!row) return null
  await run(
    db,
    'UPDATE ai_group_decision SET stage = ?, reason = ?, fired = ? WHERE id = ?',
    ['model', patch.reason, (patch.fired ?? true) ? 1 : 0, row.id],
  )

  const updated = await one<DecisionRow>(db, 'SELECT * FROM ai_group_decision WHERE id = ?', [row.id])
  return updated ? mapDecision(db, updated) : null
}

/** 会话最近的决策记录，新在前 */
export async function listDecisions(db: Executor, conversationId: string, limit: number): Promise<AiGroupDecision[]> {
  const rows = await all<DecisionRow>(
    db,
    `SELECT * FROM ai_group_decision
     WHERE conversation_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [conversationId, limit],
  )
  const decisions: AiGroupDecision[] = []
  for (const row of rows) decisions.push(await mapDecision(db, row))
  return decisions
}
