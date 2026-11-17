-- 修复 B 站多 P 字幕/总结串号后，旧的视频卡片缓存里存的是 bvid 而非分 P 隔离键。
-- 清空 B 站卡片缓存，让客户端按新的 bvid_c{cid} 键重新抓取；其他网站卡片不受影响。
DELETE FROM link_previews WHERE kind = 'bilibili';
