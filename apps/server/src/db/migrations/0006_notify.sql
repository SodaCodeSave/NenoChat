-- 通知
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  conversation_id TEXT,
  message_id      TEXT,
  post_id         TEXT,
  is_read         BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, is_read, created_at DESC);

-- 表情包
CREATE TABLE IF NOT EXISTS sticker_packs (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'image',
  position   BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stickers (
  id            TEXT PRIMARY KEY,
  pack_id       TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  value         TEXT,
  attachment_id TEXT REFERENCES attachments(id),
  keywords      TEXT,
  position      BIGINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stickers_pack ON stickers(pack_id, position);
