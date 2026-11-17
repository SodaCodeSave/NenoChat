-- 消息全文索引。trigram 分词要求查询串至少 3 个字符，短查询在应用层回退到 LIKE。
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  content,
  tokenize = 'trigram'
);
