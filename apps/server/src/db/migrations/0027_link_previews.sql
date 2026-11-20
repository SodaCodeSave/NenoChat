-- 聊天链接卡片元信息缓存：按 URL 哈希去重，过期后重新抓取
CREATE TABLE IF NOT EXISTS link_previews (
  url_hash    TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  -- bilibili | website
  kind        TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  image       TEXT,
  site_name   TEXT,
  author      TEXT,
  video_id    TEXT,
  fetched_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_link_previews_fetched
  ON link_previews(fetched_at);
