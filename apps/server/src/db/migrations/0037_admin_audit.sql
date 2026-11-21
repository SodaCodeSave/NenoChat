-- 管理面板审计日志：记录管理员执行的写操作与破坏性操作，便于追溯与回滚判断
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  detail      JSONB,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_log (created_at DESC);
