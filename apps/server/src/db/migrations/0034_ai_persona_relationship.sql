-- 角色关系系统：角色与用户的关系（阶段 + 描述），AI 总结记忆时更新，用户也可手动改
ALTER TABLE ai_personas ADD COLUMN relationship_stage TEXT NOT NULL DEFAULT 'stranger';
ALTER TABLE ai_personas ADD COLUMN relationship_description TEXT NOT NULL DEFAULT '';
-- 关系系统总闸；迁移存量用户默认开启
ALTER TABLE ai_global_settings ADD COLUMN relationship_enabled INTEGER NOT NULL DEFAULT 1;
