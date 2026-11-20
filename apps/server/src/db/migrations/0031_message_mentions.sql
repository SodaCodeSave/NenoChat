-- @ 提及写穿表：会话列表的 mention_count 改从这里计数，
-- 替代每次列表请求对 messages.meta 的 LIKE 全扫（且 LIKE 是子串匹配，命中会误报）。
CREATE TABLE IF NOT EXISTS message_mentions (
  conversation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  seq             BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_mm_user ON message_mentions(conversation_id, user_id, seq);

-- 存量回填：meta.mentions 是用户 id 字符串数组（见 packages/shared/src/schemas/message.ts）。
-- 已撤回的消息不回填。meta 由服务端自己写入、正常均为合法 JSON，直接 ::jsonb 转换；
-- mentions 不是数组（含缺失）时 jsonb_array_elements_text 收到 NULL，返回 0 行不展开。
INSERT INTO message_mentions (conversation_id, message_id, user_id, seq)
SELECT m.conversation_id, m.id, e.value, m.seq
FROM messages m
JOIN LATERAL (
  SELECT jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(m.meta::jsonb -> 'mentions') = 'array'
         THEN m.meta::jsonb -> 'mentions'
    END
  ) AS value
) e ON true
WHERE m.deleted_at IS NULL
  AND m.meta IS NOT NULL
  AND m.meta LIKE '%mentions%'
  AND e.value <> ''
ON CONFLICT DO NOTHING;
