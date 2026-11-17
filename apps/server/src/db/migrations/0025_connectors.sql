-- 连接器：第三方数据源（网页搜索、B 站视频等）
-- 敏感凭据统一走 util/crypto 的 AES-256-GCM 加密后存 secret_enc，接口只回掩码
CREATE TABLE IF NOT EXISTS connectors (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- deepseek_search | bilibili
  type             TEXT NOT NULL,
  name             TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  -- 非敏感配置 JSON，如 baseUrl / count / maxComments
  config           TEXT NOT NULL DEFAULT '{}',
  -- 加密后的敏感配置 JSON，如 { apiKey } / { cookie }
  secret_enc       TEXT,
  last_test_at     INTEGER,
  last_test_ok     INTEGER,
  last_test_message TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);

CREATE INDEX IF NOT EXISTS ix_connectors_owner
  ON connectors(owner_id, deleted_at);
CREATE INDEX IF NOT EXISTS ix_connectors_owner_type
  ON connectors(owner_id, type, enabled);
