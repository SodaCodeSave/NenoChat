-- AI 回复分段：默认按句号、感叹号、问号和换行切分，空行会被清理
-- segment_pattern 存正则源码；SQLite 字符串里的 \n 是字面量，交给 RegExp 解释为换行
ALTER TABLE ai_global_settings ADD COLUMN segment_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_global_settings ADD COLUMN segment_pattern TEXT NOT NULL DEFAULT '[。！？!?\n]';
