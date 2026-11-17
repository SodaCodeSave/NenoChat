-- 客户端本地镜像库。
-- 所有业务表都以 (server_id, id) 为主键，实现多服务器数据隔离。
-- 不启用外键：tauri-plugin-sql 走连接池，PRAGMA foreign_keys 是连接级的，
-- 一致性由 DAO 的写入顺序与同步顺序保证。

CREATE TABLE IF NOT EXISTS server_instances (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  ws_url            TEXT NOT NULL,
  server_name       TEXT,
  icon_url          TEXT,
  registration_mode TEXT,
  last_user_id      TEXT,
  last_connected_at INTEGER,
  added_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  server_id    TEXT NOT NULL,
  id           TEXT NOT NULL,
  username     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  bio          TEXT,
  last_seen_at INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);

CREATE TABLE IF NOT EXISTS conversations (
  server_id      TEXT NOT NULL,
  id             TEXT NOT NULL,
  type           TEXT NOT NULL,
  name           TEXT,
  avatar_url     TEXT,
  owner_id       TEXT,
  announcement   TEXT,
  ai_persona_id  TEXT,
  last_message_id TEXT,
  last_message_at INTEGER,
  message_count  INTEGER NOT NULL DEFAULT 0,
  dm_key         TEXT,
  partner_id     TEXT,
  partner_name   TEXT,
  partner_avatar_url TEXT,
  pinned_at      INTEGER,
  notification_level TEXT,
  unread_count   INTEGER NOT NULL DEFAULT 0,
  mention_count  INTEGER NOT NULL DEFAULT 0,
  my_last_read_seq INTEGER NOT NULL DEFAULT 0,
  member_count   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX IF NOT EXISTS ix_conv_order ON conversations(server_id, pinned_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS members (
  server_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  nickname        TEXT,
  allow           INTEGER NOT NULL DEFAULT 0,
  deny            INTEGER NOT NULL DEFAULT 0,
  mute_until      INTEGER,
  joined_at       INTEGER NOT NULL,
  left_at         INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  server_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  topic           TEXT,
  kind            TEXT NOT NULL,
  category        TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX IF NOT EXISTS ix_channels_conv ON channels(server_id, conversation_id, category, position);

CREATE TABLE IF NOT EXISTS messages (
  server_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  channel_id      TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_seq ON messages(server_id, conversation_id, seq)
  WHERE local_status = 'synced';
CREATE INDEX IF NOT EXISTS ix_msg_page ON messages(server_id, conversation_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_nonce ON messages(server_id, client_nonce)
  WHERE client_nonce IS NOT NULL;

CREATE TABLE IF NOT EXISTS read_cursors (
  server_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  last_read_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  server_id       TEXT NOT NULL,
  contact_user_id TEXT NOT NULL,
  alias           TEXT,
  relation        TEXT NOT NULL,
  request_message TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, contact_user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  server_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  visibility    TEXT NOT NULL,
  like_count    INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  liked_by_me   INTEGER NOT NULL DEFAULT 0,
  attachments   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX IF NOT EXISTS ix_posts_feed ON posts(server_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_comments (
  server_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  post_id    TEXT NOT NULL,
  author_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  reply_to_comment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX IF NOT EXISTS ix_pc_post ON post_comments(server_id, post_id, created_at);

CREATE TABLE IF NOT EXISTS sticker_packs (
  server_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);

CREATE TABLE IF NOT EXISTS stickers (
  server_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  pack_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  value         TEXT,
  url           TEXT,
  keywords      TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX IF NOT EXISTS ix_stickers_pack ON stickers(server_id, pack_id, position);

CREATE TABLE IF NOT EXISTS ai_providers (
  server_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  model       TEXT NOT NULL,
  key_location TEXT NOT NULL,
  api_key_masked TEXT,
  temperature REAL NOT NULL DEFAULT 0.8,
  max_tokens  INTEGER NOT NULL DEFAULT 2048,
  is_default  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);

CREATE TABLE IF NOT EXISTS ai_personas (
  server_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  system_prompt TEXT NOT NULL,
  greeting      TEXT,
  provider_id   TEXT,
  model_override TEXT,
  reply_style   TEXT NOT NULL DEFAULT 'chatty',
  proactive     TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);

CREATE TABLE IF NOT EXISTS ai_memory_summaries (
  server_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  from_seq        INTEGER NOT NULL,
  to_seq          INTEGER NOT NULL,
  summary         TEXT NOT NULL,
  superseded_by   TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX IF NOT EXISTS ix_summary_conv ON ai_memory_summaries(server_id, conversation_id, to_seq DESC);

CREATE TABLE IF NOT EXISTS ai_memory_facts (
  server_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  subject         TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.7,
  status          TEXT NOT NULL DEFAULT 'active',
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX IF NOT EXISTS ix_facts_conv ON ai_memory_facts(server_id, conversation_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  server_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  conversation_id TEXT,
  message_id      TEXT,
  post_id         TEXT,
  is_read         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  server_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, key)
);

CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL,
  op              TEXT NOT NULL,
  payload         TEXT NOT NULL,
  conversation_id TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_outbox_order ON outbox(server_id, next_attempt_at);

CREATE TABLE IF NOT EXISTS sync_state (
  server_id     TEXT PRIMARY KEY,
  cursor        INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  catchup_done  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS drafts (
  server_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  channel_id      TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (server_id, conversation_id, channel_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  server_id UNINDEXED,
  conversation_id UNINDEXED,
  content,
  tokenize = 'trigram'
);
