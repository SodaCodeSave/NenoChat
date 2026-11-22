-- MCP 服务器与技能提示词包（设置页「MCP & Skill」分区）
-- 两者都是用户级实体：MCP 凭据走 util/crypto 的 AES-256-GCM 加密后存 secret_enc，接口只回掩码
CREATE TABLE IF NOT EXISTS mcp_servers (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  -- Streamable HTTP 端点（兼容旧 SSE 传输）
  url              TEXT NOT NULL,
  enabled          BIGINT NOT NULL DEFAULT 1,
  -- 非敏感配置 JSON，如 { timeoutMs }
  config           TEXT NOT NULL DEFAULT '{}',
  -- 加密后的敏感配置 JSON，如 { headers: { Authorization: '...' } }
  secret_enc       TEXT,
  last_test_at     BIGINT,
  last_test_ok     BIGINT,
  last_test_message TEXT,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  deleted_at       BIGINT
);

CREATE INDEX IF NOT EXISTS ix_mcp_servers_owner
  ON mcp_servers(owner_id, deleted_at);
CREATE INDEX IF NOT EXISTS ix_mcp_servers_owner_enabled
  ON mcp_servers(owner_id, enabled);

CREATE TABLE IF NOT EXISTS skills (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  -- 目录里给模型看的一句话描述
  description      TEXT NOT NULL DEFAULT '',
  -- Markdown 正文，AI 通过 read_skill 工具按需读取
  content          TEXT NOT NULL DEFAULT '',
  enabled          BIGINT NOT NULL DEFAULT 1,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  deleted_at       BIGINT
);

CREATE INDEX IF NOT EXISTS ix_skills_owner
  ON skills(owner_id, deleted_at);
CREATE INDEX IF NOT EXISTS ix_skills_owner_enabled
  ON skills(owner_id, enabled);
