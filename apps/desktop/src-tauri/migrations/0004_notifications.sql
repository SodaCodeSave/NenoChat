-- 通知中心：按服务器隔离，未读优先、时间倒序分页
CREATE INDEX IF NOT EXISTS ix_notifications_order
  ON notifications(server_id, is_read, created_at DESC);
