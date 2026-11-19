-- 供应商下的 AI 列表：每个模型的开关与预留价格，存 JSON 数组
ALTER TABLE ai_providers ADD COLUMN models_json TEXT;
