-- 识图模型：每个服务商可单独指定一个多模态模型，用来把聊天图片转成文字描述
ALTER TABLE ai_providers ADD COLUMN vision_model TEXT;

-- 图片描述缓存：同一张图（sha256 相同）只识图一次
CREATE TABLE ai_image_descriptions (
  sha256 TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
