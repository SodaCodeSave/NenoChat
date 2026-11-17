-- B 站视频 AI 总结缓存：按用户 + 视频去重，避免重复调用模型
CREATE TABLE IF NOT EXISTS bilibili_video_summaries (
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- bvid（如 BV1xx411c7mD）；av 号也会先解析成 bvid 再入库
  video_id   TEXT NOT NULL,
  title      TEXT,
  summary    TEXT NOT NULL,
  model      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, video_id)
);

CREATE INDEX IF NOT EXISTS ix_bvs_owner_updated
  ON bilibili_video_summaries(owner_id, updated_at);
