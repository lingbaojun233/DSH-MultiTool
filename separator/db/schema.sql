-- separator/db/schema.sql
-- 分隔模块：用户身份与每人一份的「相处档案」。
-- 大肥鱼本体（宪法、traits、自传）在 memory 里共享；这里只存「对不同人的差别」。

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,          -- 登录名，全小写
  display_name  TEXT NOT NULL,                 -- 希望被怎么称呼（会进人格提示词）
  password_hash TEXT NOT NULL,                 -- scrypt: salt$hash（hex）
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,               -- sha256(token)，原文不落库
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- 每人对大肥鱼的态度差异：关系阶段、称呼、语气补充、traits 覆盖
CREATE TABLE IF NOT EXISTS user_traits (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  relationship  TEXT NOT NULL DEFAULT 'friend', -- girlfriend / friend / colleague / stranger
  call_me       TEXT,                           -- 大肥鱼怎么称呼他；空则用 display_name
  tone_note     TEXT,                           -- 一句话语气补充
  traits_json   TEXT NOT NULL DEFAULT '{}',     -- 只写要覆盖的键，如 {"warmth":95}
  updated_at    TEXT NOT NULL
);
