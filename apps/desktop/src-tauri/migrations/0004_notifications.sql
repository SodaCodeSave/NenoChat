-- 成员级通知免打扰：与通知实体的既有字段对齐，离线时也能按会话静音
ALTER TABLE members ADD COLUMN notification_level TEXT;

-- 通知中心：按服务器隔离，未读优先、时间倒序分页
CREATE INDEX IF NOT EXISTS ix_notifications_order
  ON notifications(server_id, is_read, created_at DESC);
