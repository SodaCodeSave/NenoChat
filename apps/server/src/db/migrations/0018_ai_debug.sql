-- 调试模式：上游调用的真实 usage 落库、群聊决策记录、模型上下文窗口配置

-- 每次上游 AI 调用一条记录，缓存命中率与 token 消耗从这里聚合
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT,
  persona_id       TEXT,
  provider_id      TEXT,
  -- chat | group_reply | group_autonomy | proactive | moment | summary | vision | title | client_report
  kind             TEXT NOT NULL,
  -- 关联对象：私聊 generationId / 群聊 logId 等
  ref_id           TEXT,
  model            TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_aiusage_conv ON ai_usage_log(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_aiusage_ref ON ai_usage_log(ref_id);
CREATE INDEX IF NOT EXISTS ix_aiusage_owner ON ai_usage_log(owner_id, created_at DESC);

-- 群聊成员的决策过程：规则层判定（无论是否放行）与模型层产出（含 SKIP）
CREATE TABLE IF NOT EXISTS ai_group_decision (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  persona_id         TEXT NOT NULL,
  persona_name       TEXT NOT NULL,
  trigger_message_id TEXT,
  channel_id         TEXT,
  -- reply（插话）| autonomy（自主开口）
  kind               TEXT NOT NULL,
  fired              INTEGER NOT NULL,
  -- rules（规则层判定）| model（模型产出）
  stage              TEXT NOT NULL,
  reason             TEXT,
  energy             REAL,
  mood               TEXT,
  log_id             TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_aigdec_conv ON ai_group_decision(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_aigdec_trigger ON ai_group_decision(trigger_message_id);

-- 模型上下文窗口大小，调试模式算水位用；NULL 表示未配置
ALTER TABLE ai_providers ADD COLUMN context_window INTEGER;

-- 调试模式总开关
ALTER TABLE ai_global_settings ADD COLUMN debug_mode INTEGER NOT NULL DEFAULT 0;
