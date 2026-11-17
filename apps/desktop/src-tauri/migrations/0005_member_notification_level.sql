-- 成员级通知免打扰：与通知实体的既有字段对齐，离线时也能按会话静音
ALTER TABLE members ADD COLUMN notification_level TEXT;
