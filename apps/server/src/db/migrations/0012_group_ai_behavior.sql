-- 群聊 AI 成员：心情/体力、插话与自主开口的配额日志、角色好友关系补齐

-- 每个 (群, 角色) 一行：体力随聊天消耗、随时间恢复，心情由体力推导
CREATE TABLE IF NOT EXISTS ai_group_state (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  persona_id      TEXT NOT NULL,
  energy          REAL NOT NULL DEFAULT 70,
  mood            TEXT NOT NULL DEFAULT '平静',
  last_reply_at   INTEGER,
  last_autonomy_at INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, persona_id)
);

-- 插话与自主开口分开记额度；自主开口靠唯一索引占坑，多实例只有一个能抢到
CREATE TABLE IF NOT EXISTS ai_group_log (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  persona_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id      TEXT,
  -- reply（插话）| autonomy（主动开口）
  kind            TEXT NOT NULL,
  day_key         TEXT NOT NULL,
  slot            INTEGER NOT NULL DEFAULT 0,
  -- pending | dispatched | sent | skipped | failed
  status          TEXT NOT NULL,
  message_id      TEXT,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_aiglog_quota
  ON ai_group_log(conversation_id, persona_id, day_key, status);
CREATE INDEX IF NOT EXISTS ix_aiglog_conv
  ON ai_group_log(conversation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_aiglog_autonomy
  ON ai_group_log(conversation_id, persona_id, day_key, slot) WHERE kind = 'autonomy';

-- 0011 之后、代码开始绑定影子账号之前创建的角色：补一个用户身份，
-- 否则这些角色没法进群、也没法出现在通讯录里
INSERT OR IGNORE INTO users
  (id, username, display_name, password_hash, avatar_url, bio, status, is_admin,
   last_seen_at, created_at, updated_at, updated_by_device, is_bot)
SELECT 'bot-' || p.id, 'ai_bot-' || p.id, p.name, '!', p.avatar_url, NULL, 'active', 0,
       NULL, p.created_at, p.updated_at, NULL, 1
FROM ai_personas p
WHERE p.deleted_at IS NULL AND p.user_id IS NULL;

UPDATE ai_personas
SET user_id = 'bot-' || id
WHERE deleted_at IS NULL AND user_id IS NULL;

-- 角色与主人互为好友：通讯录统一列表里 AI 和真人没有区别
INSERT OR IGNORE INTO contacts
  (owner_id, contact_user_id, alias, relation, request_message, created_at, updated_at)
SELECT p.owner_id, p.user_id, NULL, 'friend', NULL, p.created_at, p.updated_at
FROM ai_personas p
WHERE p.deleted_at IS NULL AND p.user_id IS NOT NULL;
