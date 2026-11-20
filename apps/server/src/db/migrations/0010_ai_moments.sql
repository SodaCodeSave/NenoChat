-- 角色在动态广场的活动：署名、互动去重、AI 自动互动全局设置

-- 主动消息配置来源：global 跟随全局，custom 用角色自己那份
ALTER TABLE ai_personas ADD COLUMN proactive_mode TEXT NOT NULL DEFAULT 'global';

-- 迁移前就已经单独开过主动消息的角色保持原行为，不被全局默认关掉
UPDATE ai_personas SET proactive_mode = 'custom' WHERE proactive_enabled = 1;

-- 动态与评论的实际署名角色；author_id 仍是主人，删除权限与归属不受影响
ALTER TABLE posts ADD COLUMN persona_id TEXT;
ALTER TABLE post_comments ADD COLUMN persona_id TEXT;

CREATE INDEX IF NOT EXISTS ix_posts_persona ON posts(persona_id, created_at);
CREATE INDEX IF NOT EXISTS ix_pc_persona ON post_comments(persona_id, created_at);

-- 点赞要区分「用户点的」与「角色点的」：原主键 (post_id, user_id) 一个用户只能一条，
-- 同一用户自己的两个角色就无法都点赞，改为加上 persona_id 的联合主键。
ALTER TABLE post_likes ADD COLUMN persona_id TEXT NOT NULL DEFAULT '';
ALTER TABLE post_likes DROP CONSTRAINT post_likes_pkey;
ALTER TABLE post_likes ADD CONSTRAINT post_likes_pkey
  PRIMARY KEY (post_id, user_id, persona_id);

-- 每个用户的 AI 自动互动总闸，主动私聊与动态互动共用一条记录
CREATE TABLE IF NOT EXISTS ai_global_settings (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  proactive_enabled        BIGINT NOT NULL DEFAULT 0,
  -- { minIdleHours, maxPerDay, windowStart, windowEnd }
  proactive_config         TEXT NOT NULL DEFAULT '{}',
  moments_enabled          BIGINT NOT NULL DEFAULT 0,
  moments_posts_per_day    BIGINT NOT NULL DEFAULT 1,
  moments_comments_per_day BIGINT NOT NULL DEFAULT 3,
  moments_likes_per_day    BIGINT NOT NULL DEFAULT 3,
  updated_at               BIGINT NOT NULL
);

-- 角色对动态做过的动作：既是每日配额计数，也是「同一条不重复评论/点赞」的依据
CREATE TABLE IF NOT EXISTS ai_moment_actions (
  id         TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  -- 发动态时为空串
  post_id    TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  -- 服务端时区下的 YYYY-MM-DD
  day_key    TEXT NOT NULL,
  -- pending（已占位待生成）| done | skipped | failed
  status     TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ama_persona_post_kind
  ON ai_moment_actions(persona_id, post_id, kind)
  WHERE post_id <> '' AND kind IN ('comment', 'like');

CREATE INDEX IF NOT EXISTS ix_ama_persona_day
  ON ai_moment_actions(persona_id, day_key, kind, status);
