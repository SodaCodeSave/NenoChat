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

-- messages.channel_id 带外键，SQLite 不允许直接 DROP COLUMN，只能重建表。
-- 回执表通过外键挂在 messages 上：先备份并摘掉，避免重建 messages 时被级联清空。
CREATE TEMP TABLE message_receipts_backup AS SELECT * FROM message_receipts;
DROP TABLE message_receipts;

DROP INDEX IF EXISTS ix_msg_channel_seq;
DROP INDEX IF EXISTS ux_msg_nonce;
DROP INDEX IF EXISTS ix_msg_conv_seq;
DROP INDEX IF EXISTS ix_msg_generation;

CREATE TABLE messages_next (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        TEXT REFERENCES users(id),
  sender_type      TEXT NOT NULL DEFAULT 'user',
  type             TEXT NOT NULL DEFAULT 'text',
  content          TEXT NOT NULL DEFAULT '',
  meta             TEXT,
  reply_to_id      TEXT,
  seq              INTEGER NOT NULL,
  client_nonce     TEXT,
  ai_generation_id TEXT,
  ai_index         INTEGER,
  pinned_at        INTEGER,
  edited_at        INTEGER,
  deleted_at       INTEGER,
  deleted_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  updated_by_device TEXT,
  UNIQUE (conversation_id, seq)
);

INSERT INTO messages_next
  (id, conversation_id, sender_id, sender_type, type, content, meta, reply_to_id, seq,
   client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at, deleted_by,
   created_at, updated_at, updated_by_device)
SELECT id, conversation_id, sender_id, sender_type, type, content, meta, reply_to_id, seq,
       client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at, deleted_by,
       created_at, updated_at, updated_by_device
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_next RENAME TO messages;

CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_nonce ON messages(sender_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_msg_conv_seq ON messages(conversation_id, seq DESC);
CREATE INDEX IF NOT EXISTS ix_msg_generation ON messages(ai_generation_id)
  WHERE ai_generation_id IS NOT NULL;

CREATE TABLE message_receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
INSERT INTO message_receipts SELECT * FROM message_receipts_backup;
DROP TABLE message_receipts_backup;

-- 群聊 AI 的日志与决策记录不再按频道归属
ALTER TABLE ai_group_log DROP COLUMN channel_id;
ALTER TABLE ai_group_decision DROP COLUMN channel_id;

-- 频道本身与它的增量同步记录一并清理
DROP TABLE IF EXISTS channels;
DELETE FROM sync_change_log WHERE entity = 'channel';
