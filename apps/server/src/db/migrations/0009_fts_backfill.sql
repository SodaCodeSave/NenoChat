-- 为已有消息回填全文索引。0007 只建了表，历史数据需要补进来；
-- 新消息由 message-service 在写事务里同步维护。
INSERT INTO message_fts (message_id, conversation_id, content)
SELECT id, conversation_id, content
FROM messages
WHERE deleted_at IS NULL AND trim(content) <> '';
