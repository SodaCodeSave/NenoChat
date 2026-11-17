-- @ 提及写穿表：会话列表的 mention_count 改从这里计数，
-- 替代每次列表请求对 messages.meta 的双重 LIKE 全扫（且 LIKE 是子串匹配，命中会误报）。
CREATE TABLE IF NOT EXISTS message_mentions (
  conversation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_mm_user ON message_mentions(conversation_id, user_id, seq);

-- 存量回填：meta.mentions 是用户 id 字符串数组（见 packages/shared/src/schemas/message.ts）。
-- 已撤回的消息不回填。json_type / json_each 遇到非法 JSON 会直接报错，且 WHERE 里
-- 对 json_each 输出列套 json_type 会被推进虚拟表扫描同样炸掉，所以：
-- 1) 先用 json_valid（对任何输入都不抛错）筛出候选行进临时表；
-- 2) 元素类型用 json_each 自带的 type 列判断，不调用 json_type(j.value)。
CREATE TEMP TABLE mention_backfill AS
SELECT id, conversation_id, seq, meta
FROM messages
WHERE deleted_at IS NULL
  AND meta IS NOT NULL
  AND json_valid(meta);

INSERT OR IGNORE INTO message_mentions (conversation_id, message_id, user_id, seq)
SELECT m.conversation_id, m.id, j.value, m.seq
FROM mention_backfill m
JOIN json_each(m.meta, '$.mentions') j
WHERE json_type(m.meta, '$.mentions') = 'array'
  AND j.type = 'text'
  AND j.value <> '';

DROP TABLE mention_backfill;
