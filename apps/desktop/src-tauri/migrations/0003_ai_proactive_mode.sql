-- 角色主动消息来源：跟随全局还是单独配置
ALTER TABLE ai_personas ADD COLUMN proactive_mode TEXT NOT NULL DEFAULT 'global';
