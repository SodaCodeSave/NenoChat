-- 消息全文检索：pg_trgm GIN 索引加速 LIKE，trigram 分词对中文同样有效
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_msg_content_trgm ON messages USING gin (content gin_trgm_ops);
