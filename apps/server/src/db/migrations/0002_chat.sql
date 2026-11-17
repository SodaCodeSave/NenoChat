-- 会话、成员、频道、消息、已读
CREATE TABLE IF NOT EXISTS conversations (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL,
  name                    TEXT,
  avatar_url              TEXT,
  owner_id                TEXT REFERENCES users(id),
  announcement            TEXT,
  announcement_updated_at INTEGER,
  announcement_updated_by TEXT,
  ai_persona_id           TEXT,
  ai_owner_user_id        TEXT,
  last_message_id         TEXT,
  last_message_at         INTEGER,
  message_count           INTEGER NOT NULL DEFAULT 0,
  seq_counter             INTEGER NOT NULL DEFAULT 0,
  dm_key                  TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  deleted_at              INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conv_dm ON conversations(dm_key) WHERE dm_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_conv_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'member',
  nickname           TEXT,
  allow              INTEGER NOT NULL DEFAULT 0,
  deny               INTEGER NOT NULL DEFAULT 0,
  mute_until         INTEGER,
  pinned_at          INTEGER,
  notification_level TEXT,
  joined_at          INTEGER NOT NULL,
  invited_by         TEXT,
  left_at            INTEGER,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_cm_user ON conversation_members(user_id, left_at);

CREATE TABLE IF NOT EXISTS channels (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  topic           TEXT,
  kind            TEXT NOT NULL DEFAULT 'text',
  category        TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_channels_conv ON channels(conversation_id, category, position);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id       TEXT REFERENCES channels(id) ON DELETE CASCADE,
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_nonce ON messages(sender_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_msg_conv_seq ON messages(conversation_id, seq DESC);
CREATE INDEX IF NOT EXISTS ix_msg_channel_seq ON messages(channel_id, seq DESC)
  WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_msg_generation ON messages(ai_generation_id)
  WHERE ai_generation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS read_cursors (
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq        INTEGER NOT NULL DEFAULT 0,
  last_read_message_id TEXT,
  last_read_at         INTEGER,
  updated_at           INTEGER NOT NULL,
  device_id            TEXT,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT,
  message_id      TEXT,
  kind            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  sha256          TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  thumb_key       TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS ix_att_sha ON attachments(sha256);
CREATE INDEX IF NOT EXISTS ix_att_msg ON attachments(message_id) WHERE message_id IS NOT NULL;
