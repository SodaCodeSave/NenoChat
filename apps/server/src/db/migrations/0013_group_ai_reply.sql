-- 群聊 AI 插话时记录触发它的消息，落库后第一条分条自动挂上引用回复
ALTER TABLE ai_group_log ADD COLUMN reply_to_id TEXT;
