-- AI 表情包：用户可逐包授权 AI 使用自己的表情包
ALTER TABLE sticker_packs ADD COLUMN allow_ai INTEGER NOT NULL DEFAULT 0;
