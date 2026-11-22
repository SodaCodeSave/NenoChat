-- 全服共享 AI 供应商 + 用户余额计费

-- 系统级影子账号：管理面板配置的服务器供应商挂在这个账号名下。
-- is_bot=1 保证它不可登录（login 直接拒绝）、不进用户搜索与管理面板用户列表；
-- 管理员删除用户时也会因 is_bot 被拒，供应商随它常驻。
INSERT INTO users (id, username, display_name, password_hash, is_admin, status, is_bot, created_at, updated_at)
VALUES ('system-ai', 'ai_system', '系统共享AI', '!', 0, 'active', 1, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- 用户余额：NUMERIC 保精度，扣费用 SQL 内运算避免浮点漂移；
-- 行按需创建（充值或首次扣费时 upsert），无行即余额 0。
CREATE TABLE IF NOT EXISTS ai_balances (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance    NUMERIC(14,6) NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);
