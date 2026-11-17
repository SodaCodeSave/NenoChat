-- 服务商余额探测结果缓存
ALTER TABLE ai_providers ADD COLUMN balance TEXT;
ALTER TABLE ai_providers ADD COLUMN balance_currency TEXT;
ALTER TABLE ai_providers ADD COLUMN balance_checked_at INTEGER;
