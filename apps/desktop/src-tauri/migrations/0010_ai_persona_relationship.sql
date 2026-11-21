-- 角色关系系统：与用户的关系（阶段 + 描述），与服务端 0034 对应
ALTER TABLE ai_personas ADD COLUMN relationship_stage TEXT NOT NULL DEFAULT 'stranger';
ALTER TABLE ai_personas ADD COLUMN relationship_description TEXT NOT NULL DEFAULT '';
