-- 通知中心下线：系统弹窗改由客户端根据消息事件直接触发，不再保存通知记录
DROP TABLE IF EXISTS notifications;
