-- 角色级表情包授权白名单：NULL = 跟随全局，JSON 数组 = 该角色只能用列出的分组
ALTER TABLE ai_personas ADD COLUMN sticker_pack_ids TEXT;
