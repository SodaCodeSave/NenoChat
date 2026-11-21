-- 自定义聊天背景：背景图走附件体系（/files/... 相对 URL），主色为客户端从图提取的 hex，
-- 两列均可空（未设置背景时为 NULL）。URL 被引用的附件由 attachment-gc 的 user_settings 扫描保护。
ALTER TABLE user_settings ADD COLUMN chat_bg_url TEXT;
ALTER TABLE user_settings ADD COLUMN chat_bg_accent TEXT;
