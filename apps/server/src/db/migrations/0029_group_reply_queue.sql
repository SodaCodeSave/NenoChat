-- 群接话排队：一条群消息最多允许几个角色排队接话
ALTER TABLE ai_global_settings ADD COLUMN group_replies_per_message BIGINT NOT NULL DEFAULT 2;
