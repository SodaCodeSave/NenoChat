-- 消息幂等查询的索引补齐
-- findByNonce(sender_id + client_nonce) 已由 ux_msg_nonce 覆盖；
-- findByNonceInConversation(conversation_id + client_nonce) 此前只能借道 ix_msg_conv_seq
-- 按会话前缀扫描，AI 分段追加每段都要查一次，这里补上专用索引。
CREATE INDEX IF NOT EXISTS ix_msg_conv_nonce ON messages(conversation_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
