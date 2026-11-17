-- 通知：同一用户对同一条消息只保留一条记录，避免 AI 主动消息、群聊接话等多条路径重复写
CREATE INDEX IF NOT EXISTS ix_notif_user_message ON notifications(user_id, message_id);
