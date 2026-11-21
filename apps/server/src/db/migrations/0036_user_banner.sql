-- 动态空间头图：走附件体系（/files/... 相对 URL），可空（未设置时前端渲染渐变占位）。
-- URL 被引用的附件由 attachment-gc 的 users 扫描保护。
ALTER TABLE users ADD COLUMN banner_url TEXT;
