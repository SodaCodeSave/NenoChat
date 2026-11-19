-- 角色级表情包授权：NULL / 空 = 跟随全局（各分组的「允许 AI 使用」开关），
-- 非空 = 白名单，该角色只能从列出的分组里挑表情（分组本身仍需打开「允许 AI 使用」）
ALTER TABLE ai_personas ADD COLUMN sticker_pack_ids TEXT;
