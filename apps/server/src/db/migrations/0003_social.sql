-- 通讯录、动态空间
CREATE TABLE IF NOT EXISTS contacts (
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias           TEXT,
  relation        TEXT NOT NULL,
  request_message TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (owner_id, contact_user_id)
);
CREATE INDEX IF NOT EXISTS ix_contacts_rel ON contacts(owner_id, relation);

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL DEFAULT '',
  visibility    TEXT NOT NULL DEFAULT 'friends',
  like_count    BIGINT NOT NULL DEFAULT 0,
  comment_count BIGINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  deleted_at    BIGINT
);
CREATE INDEX IF NOT EXISTS ix_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_posts_author ON posts(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_attachments (
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  position      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id                  TEXT PRIMARY KEY,
  post_id             TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  reply_to_comment_id TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  deleted_at          BIGINT
);
CREATE INDEX IF NOT EXISTS ix_pc_post ON post_comments(post_id, created_at);
