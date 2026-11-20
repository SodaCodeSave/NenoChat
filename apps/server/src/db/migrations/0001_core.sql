-- 用户与鉴权
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  avatar_url        TEXT,
  bio               TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  is_admin          BIGINT NOT NULL DEFAULT 0,
  last_seen_at      BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  updated_by_device TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users(lower(username));

CREATE TABLE IF NOT EXISTS devices (
  id             TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  platform       TEXT NOT NULL,
  app_version    TEXT,
  created_at     BIGINT NOT NULL,
  last_active_at BIGINT,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  family_id   TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,
  created_at  BIGINT NOT NULL,
  revoked_at  BIGINT,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_rt_user ON refresh_tokens(user_id, device_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rt_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  max_uses   BIGINT NOT NULL DEFAULT 1,
  uses       BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT,
  created_at BIGINT NOT NULL
);

-- 服务器级 KV 配置
CREATE TABLE IF NOT EXISTS server_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme         TEXT NOT NULL DEFAULT 'system',
  accent        TEXT NOT NULL DEFAULT 'blue',
  font_scale    REAL NOT NULL DEFAULT 1.0,
  density       TEXT NOT NULL DEFAULT 'cozy',
  send_key      TEXT NOT NULL DEFAULT 'enter',
  locale        TEXT NOT NULL DEFAULT 'zh-CN',
  reduce_motion BIGINT NOT NULL DEFAULT 0,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  desktop_enabled BIGINT NOT NULL DEFAULT 1,
  sound_enabled   BIGINT NOT NULL DEFAULT 1,
  show_preview    BIGINT NOT NULL DEFAULT 1,
  dm_level        TEXT NOT NULL DEFAULT 'all',
  group_level     TEXT NOT NULL DEFAULT 'mentions',
  dnd_enabled     BIGINT NOT NULL DEFAULT 0,
  dnd_start       TEXT DEFAULT '23:00',
  dnd_end         TEXT DEFAULT '08:00',
  timezone        TEXT DEFAULT 'Asia/Shanghai',
  updated_at      BIGINT NOT NULL
);

INSERT INTO server_settings (key, value, updated_at)
VALUES ('server_name', '"NenoChat"', 0)
ON CONFLICT DO NOTHING;
INSERT INTO server_settings (key, value, updated_at)
VALUES ('registration_mode', '"open"', 0)
ON CONFLICT DO NOTHING;
INSERT INTO server_settings (key, value, updated_at)
VALUES ('max_upload_mb', '10', 0)
ON CONFLICT DO NOTHING;
INSERT INTO server_settings (key, value, updated_at)
VALUES ('ai_proactive_enabled', '1', 0)
ON CONFLICT DO NOTHING;
