-- 003_counterpart.sql —— 按「对话对象」隔离记忆
-- 约定（与 user_id 同构）：
--   counterpart 为 NULL = 通用记忆，任何对话都能召回；
--   为文本（如 "Venchist"）= 只在跟这个人的对话里召回。
-- 这样 QQ 参谋跟 A 聊的内容不会在跟 B 聊的时候冒出来。
-- 只新增列与索引，不改 001/002；ADD COLUMN 不能带非常量默认值，列一律可空。

ALTER TABLE events ADD COLUMN counterpart TEXT;
ALTER TABLE facts  ADD COLUMN counterpart TEXT;

-- 检索按 counterpart 过滤并要按时间倒排
CREATE INDEX IF NOT EXISTS ix_events_counterpart ON events(counterpart, ts DESC);
CREATE INDEX IF NOT EXISTS ix_facts_counterpart  ON facts(counterpart);
