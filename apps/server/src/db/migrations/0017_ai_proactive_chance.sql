-- 主动消息唯一占位改为部分索引：只有占配额的状态才需要 slot 唯一，
-- chance 模式的掷骰标记（skipped）会复用 slot，不能被全状态唯一索引挡住

DROP INDEX IF EXISTS ux_aip_conv_day_slot;

CREATE UNIQUE INDEX IF NOT EXISTS ux_aip_conv_day_slot
  ON ai_proactive_log(conversation_id, day_key, slot)
  WHERE status IN ('pending', 'dispatched', 'sent');
