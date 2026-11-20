-- 增量同步变更日志：所有可同步实体的写入都在同事务内追加一条
CREATE TABLE IF NOT EXISTS sync_change_log (
  seq             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity          TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  op              TEXT NOT NULL,
  conversation_id TEXT,
  user_id         TEXT,
  payload         TEXT NOT NULL,
  actor_id        TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cl_conv ON sync_change_log(conversation_id, seq);
CREATE INDEX IF NOT EXISTS ix_cl_user ON sync_change_log(user_id, seq);
CREATE INDEX IF NOT EXISTS ix_cl_entity ON sync_change_log(entity, entity_id, seq);
