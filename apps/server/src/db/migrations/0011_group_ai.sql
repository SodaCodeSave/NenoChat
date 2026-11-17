-- 角色以真实成员身份进群：影子账号、好友关系、群内自动互动的额度

-- 影子账号标记：机器人用户不能登录、不会出现在用户搜索里
ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;

-- 角色对应的账号 id，建群/加群/发消息都用它当成员标识
ALTER TABLE ai_personas ADD COLUMN user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_aipers_user
  ON ai_personas(user_id) WHERE user_id IS NOT NULL;

-- 老角色补一个影子账号，id 用 bot- + 角色 id，两侧可以互相推出来
INSERT INTO users
  (id, username, display_name, password_hash, avatar_url, bio, status, is_admin,
   last_seen_at, created_at, updated_at, is_bot)
SELECT 'bot-' || p.id,
       'ai_' || lower(p.id),
       p.name,
       '!',
       p.avatar_url,
       NULL,
       'active',
       0,
       NULL,
       p.created_at,
       p.updated_at,
       1
FROM ai_personas p
LEFT JOIN users u ON u.id = 'bot-' || p.id
WHERE p.deleted_at IS NULL AND u.id IS NULL;

UPDATE ai_personas SET user_id = 'bot-' || id WHERE user_id IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_contacts_contact ON contacts(contact_user_id);

-- 群内自动互动的额度：插话与自主开口分开算
ALTER TABLE ai_global_settings ADD COLUMN group_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_global_settings ADD COLUMN group_replies_per_day INTEGER NOT NULL DEFAULT 12;
ALTER TABLE ai_global_settings ADD COLUMN group_autonomy_per_day INTEGER NOT NULL DEFAULT 1;
