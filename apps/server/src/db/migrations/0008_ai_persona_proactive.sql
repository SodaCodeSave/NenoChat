-- 角色扩展：兴趣标签、角色卡、通讯录可见性、主动消息节流
-- SQLite 的 ADD COLUMN 不能加 UNIQUE/PRIMARY KEY，NOT NULL 必须带常量默认值

ALTER TABLE ai_personas ADD COLUMN interests TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_personas ADD COLUMN card TEXT;
ALTER TABLE ai_personas ADD COLUMN card_url TEXT;
ALTER TABLE ai_personas ADD COLUMN card_filename TEXT;
ALTER TABLE ai_personas ADD COLUMN in_contacts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_personas ADD COLUMN last_proactive_at INTEGER;

CREATE INDEX IF NOT EXISTS ix_aipers_contacts
  ON ai_personas(owner_id, in_contacts, deleted_at);

-- 主动消息日志：原表建好后全仓零读写，直接重建以补 day_key / slot
DROP TABLE IF EXISTS ai_proactive_log;

CREATE TABLE ai_proactive_log (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id      TEXT NOT NULL,
  -- 服务端时区下的 YYYY-MM-DD，用于「每日上限」与跨实例防重
  day_key         TEXT NOT NULL,
  -- 当日第几条（0 基），配合唯一索引实现多实例互斥
  slot            INTEGER NOT NULL,
  fired_at        INTEGER NOT NULL,
  -- pending（已占位待生成）| dispatched（已派发给客户端）| sent | failed | skipped
  status          TEXT NOT NULL,
  message_id      TEXT,
  reason          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_aip_conv_day_slot
  ON ai_proactive_log(conversation_id, day_key, slot);
CREATE INDEX IF NOT EXISTS ix_aip_user_day
  ON ai_proactive_log(user_id, day_key, status);
