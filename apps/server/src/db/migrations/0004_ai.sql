-- AI：服务商、人设、会话扩展、记忆、生成记录、主动消息日志
CREATE TABLE IF NOT EXISTS ai_providers (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  api_key_enc   TEXT,
  key_location  TEXT NOT NULL DEFAULT 'local',
  model         TEXT NOT NULL,
  temperature   REAL NOT NULL DEFAULT 0.8,
  max_tokens    INTEGER NOT NULL DEFAULT 2048,
  extra_headers TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_aiprov_owner ON ai_providers(owner_id, deleted_at);

CREATE TABLE IF NOT EXISTS ai_personas (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  avatar_url        TEXT,
  system_prompt     TEXT NOT NULL,
  greeting          TEXT,
  provider_id       TEXT REFERENCES ai_providers(id),
  model_override    TEXT,
  temperature       REAL,
  reply_style       TEXT NOT NULL DEFAULT 'chatty',
  proactive_enabled INTEGER NOT NULL DEFAULT 0,
  proactive_config  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX IF NOT EXISTS ix_aipers_owner ON ai_personas(owner_id, deleted_at);

CREATE TABLE IF NOT EXISTS ai_sessions (
  conversation_id        TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  persona_id             TEXT NOT NULL REFERENCES ai_personas(id),
  provider_id            TEXT NOT NULL REFERENCES ai_providers(id),
  memory_enabled         INTEGER NOT NULL DEFAULT 1,
  last_compacted_seq     INTEGER NOT NULL DEFAULT 0,
  messages_since_compact INTEGER NOT NULL DEFAULT 0,
  token_estimate         INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_memory_summaries (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_seq        INTEGER NOT NULL,
  to_seq          INTEGER NOT NULL,
  summary         TEXT NOT NULL,
  token_estimate  INTEGER NOT NULL,
  model           TEXT,
  superseded_by   TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aims_conv ON ai_memory_summaries(conversation_id, to_seq DESC);

CREATE TABLE IF NOT EXISTS ai_memory_facts (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.7,
  source_message_id TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  superseded_by     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_aimf_active
  ON ai_memory_facts(conversation_id, subject, key) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ai_generations (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  user_message_id   TEXT,
  provider_id       TEXT NOT NULL,
  persona_id        TEXT NOT NULL,
  run_location      TEXT NOT NULL,
  model             TEXT,
  status            TEXT NOT NULL,
  error             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  message_ids       TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER
);
CREATE INDEX IF NOT EXISTS ix_aig_conv ON ai_generations(conversation_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_proactive_log (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  fired_at        INTEGER NOT NULL,
  status          TEXT NOT NULL,
  message_id      TEXT
);
CREATE INDEX IF NOT EXISTS ix_aip_conv_day ON ai_proactive_log(conversation_id, fired_at DESC);
