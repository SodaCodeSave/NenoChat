-- 角色日程：每个角色每天一份，items 为 {start,end,activity} 的 JSON 数组
CREATE TABLE IF NOT EXISTS ai_persona_schedules (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES ai_personas(id) ON DELETE CASCADE,
  -- 角色本地日 YYYY-MM-DD
  day_key    TEXT NOT NULL,
  items      TEXT NOT NULL,
  -- ai | manual
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_aips_persona_day
  ON ai_persona_schedules(persona_id, day_key);
CREATE INDEX IF NOT EXISTS ix_aips_owner_day
  ON ai_persona_schedules(owner_id, day_key);
