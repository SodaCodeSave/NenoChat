-- 角色元信息：兴趣、角色卡、通讯录可见性、主动消息
-- 0001_init.sql 只对首次安装生效，老用户靠这一版增量升级

ALTER TABLE ai_personas ADD COLUMN interests TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_personas ADD COLUMN card TEXT;
ALTER TABLE ai_personas ADD COLUMN card_url TEXT;
ALTER TABLE ai_personas ADD COLUMN card_filename TEXT;
ALTER TABLE ai_personas ADD COLUMN in_contacts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_personas ADD COLUMN proactive_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_personas ADD COLUMN last_proactive_at INTEGER;
