-- AI 回复流式输出：开启后服务端逐字推送生成进度
ALTER TABLE ai_global_settings ADD COLUMN stream_enabled INTEGER NOT NULL DEFAULT 0;
