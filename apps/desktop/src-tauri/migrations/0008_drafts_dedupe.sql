-- 0007 已在部分机器上应用，内容不可再改；这里补齐「草稿按会话确定性合并」的增量。
-- 幂等：无论草稿表已处于合并前还是合并后状态，都只保留每个会话 updated_at 最新的一条，
-- 最终结构与 0007 一致（server_id + conversation_id 主键，不含 channel_id），
-- 因此老库与新库执行完本迁移后形态完全相同。

DROP TABLE IF EXISTS drafts_next;

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
