-- 群聊去掉频道概念：一个群只有一条消息流。
-- 已有群聊里所有频道的消息并入该群唯一消息流，消息内容不丢，只按发送时间重排 seq。

-- 只重排「曾经使用过频道」的会话；私聊与 AI 会话本来就是单流，seq 保持不变。
CREATE TEMP TABLE channel_reseq AS
SELECT m.id AS message_id,
       m.conversation_id AS conversation_id,
       m.seq AS old_seq,
       ROW_NUMBER() OVER (
         PARTITION BY m.conversation_id
         ORDER BY m.created_at, m.seq, m.id
       ) AS new_seq
FROM messages m
WHERE m.conversation_id IN (SELECT DISTINCT conversation_id FROM channels);

-- 先写负值中转，避开 UNIQUE(conversation_id, seq) 在逐行更新时的中间态冲突
UPDATE messages
SET seq = -(
  SELECT r.new_seq FROM channel_reseq r WHERE r.message_id = messages.id
)
WHERE id IN (SELECT message_id FROM channel_reseq);

UPDATE messages
SET seq = -seq
WHERE id IN (SELECT message_id FROM channel_reseq);

-- 已读游标跟随 seq 重排：优先按最后已读消息定位，退化时按旧 seq 映射
UPDATE read_cursors
SET last_read_seq = COALESCE(
  (
    SELECT m.seq FROM messages m
    WHERE m.id = read_cursors.last_read_message_id
      AND m.conversation_id = read_cursors.conversation_id
  ),
  (
    SELECT MAX(m.seq) FROM messages m
    JOIN channel_reseq r ON r.message_id = m.id
    WHERE m.conversation_id = read_cursors.conversation_id
      AND r.old_seq <= read_cursors.last_read_seq
  ),
  0
)
WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM channel_reseq);

-- 会话发号器与重排后的最大 seq 对齐，后续发送不会与存量消息撞号
UPDATE conversations
SET seq_counter = COALESCE(
  (SELECT MAX(m.seq) FROM messages m WHERE m.conversation_id = conversations.id),
  0
)
WHERE id IN (SELECT DISTINCT conversation_id FROM channel_reseq);

DROP TABLE channel_reseq;

-- messages.channel_id 列与依赖它的索引一并删除，消息表主体无需重建
DROP INDEX IF EXISTS ix_msg_channel_seq;
ALTER TABLE messages DROP COLUMN IF EXISTS channel_id;

-- 群聊 AI 的日志与决策记录不再按频道归属
ALTER TABLE ai_group_log DROP COLUMN IF EXISTS channel_id;
ALTER TABLE ai_group_decision DROP COLUMN IF EXISTS channel_id;

-- 频道本身与它的增量同步记录一并清理
DROP TABLE IF EXISTS channels;
DELETE FROM sync_change_log WHERE entity = 'channel';
