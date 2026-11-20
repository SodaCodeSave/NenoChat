-- 群接话的可调参数：固定概率与分钟级冷却
ALTER TABLE ai_global_settings ADD COLUMN group_reply_probability BIGINT;
ALTER TABLE ai_global_settings ADD COLUMN group_reply_cooldown_minutes BIGINT;
