-- 群聊去掉频道概念：本地镜像不再保存频道表与 channel_id。
-- 迁移只增不改：历史迁移文件保持原样，这里追加版本完成结构收敛。

DROP INDEX IF EXISTS ix_channels_conv;
DROP TABLE IF EXISTS channels;

-- 消息表重建（SQLite 无法在带唯一索引的情况下安全删列，直接重建最稳）
DROP INDEX IF EXISTS ux_msg_seq;
DROP INDEX IF EXISTS ix_msg_page;
DROP INDEX IF EXISTS ux_msg_nonce;

CREATE TABLE messages_next (
  server_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT,
  sender_type     TEXT NOT NULL,
  type            TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  meta            TEXT,
  reply_to_id     TEXT,
  seq             INTEGER NOT NULL,
  client_nonce    TEXT,
  ai_generation_id TEXT,
  ai_index        INTEGER,
  pinned_at       INTEGER,
  edited_at       INTEGER,
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  local_status    TEXT NOT NULL DEFAULT 'synced',
  local_error     TEXT,
  PRIMARY KEY (server_id, id)
);

INSERT INTO messages_next
  (server_id, id, conversation_id, sender_id, sender_type, type, content, meta,
   reply_to_id, seq, client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at,
   created_at, updated_at, local_status, local_error)
SELECT server_id, id, conversation_id, sender_id, sender_type, type, content, meta,
       reply_to_id, seq, client_nonce, ai_generation_id, ai_index, pinned_at, edited_at, deleted_at,
       created_at, updated_at, local_status, local_error
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_next RENAME TO messages;

CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_seq ON messages(server_id, conversation_id, seq)
  WHERE local_status = 'synced';
CREATE INDEX IF NOT EXISTS ix_msg_page ON messages(server_id, conversation_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_nonce ON messages(server_id, client_nonce)
  WHERE client_nonce IS NOT NULL;

-- 草稿原本按频道区分，合并后同一会话只保留最新一份
CREATE TABLE drafts_next (
  server_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  content         TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, conversation_id)
);

INSERT INTO drafts_next (server_id, conversation_id, content, updated_at)
SELECT server_id, conversation_id, content, updated_at
FROM drafts
WHERE rowid IN (
  SELECT rowid FROM (
    SELECT rowid,
           ROW_NUMBER() OVER (
             PARTITION BY server_id, conversation_id
             ORDER BY updated_at DESC, rowid DESC
           ) AS rn
    FROM drafts
  )
  WHERE rn = 1
);

DROP TABLE drafts;
ALTER TABLE drafts_next RENAME TO drafts;
