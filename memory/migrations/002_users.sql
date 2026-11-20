-- 002_users.sql —— 按用户隔离记忆：events / facts 增加 user_id
-- 约定：user_id 为 NULL = 共享记忆（所有人都能看到）；为整数 = 该用户的私有记忆。
-- 只新增列与索引，不改 001；SQLite 的 ADD COLUMN 不能带非常量默认值，所以列一律可空。
-- 迁移由 db/migrate.js 按 schema_migrations 记录去重，重复执行 open() 不会重复 ALTER。

ALTER TABLE events ADD COLUMN user_id INTEGER;
ALTER TABLE facts  ADD COLUMN user_id INTEGER;

-- 检索时按 user_id 过滤并要按时间倒排，索引带上 ts DESC 才能同时服务过滤与排序
CREATE INDEX IF NOT EXISTS ix_events_user ON events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_facts_user  ON facts(user_id);
