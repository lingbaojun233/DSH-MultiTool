-- memory/db/schema.sql
--
-- 记忆模块的数据库结构。设计原则：
--   1. 只追加/软删，不做物理删除（除 purge），历史可回溯。
--   2. 每条事实都必须能回查到事件证据（evidence_event_ids）。
--   3. 检索用 FTS5(trigram)，对中文友好；实体另建倒排，二者合并打分。
--
-- 约定：
--   * 所有时间字段为 ISO8601 UTC 字符串（'2026-11-20T13:30:00.000Z'）。
--   * JSON 字段以 TEXT 存储，读取时 JSON.parse。
--   * deleted=1 表示软删；检索一律过滤 deleted=0。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 迁移记账：记录已应用的迁移版本，migrate.js 据此跳过
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- events：原始事件（"谁在何时说了什么"）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,              -- 发生时间，ISO8601 UTC
  channel      TEXT    NOT NULL,              -- chat / video / doc / system
  group_id     TEXT,                          -- 群/会话/频道 id（可空）
  speaker_id   TEXT,                          -- 说话人稳定 id（如 QQ 号）
  speaker_name TEXT,                          -- 说话人显示名/人称（可随群变化）
  kind         TEXT    NOT NULL CHECK (kind IN ('msg','video','action','commitment')),
  content      TEXT    NOT NULL,              -- 归一化后的正文（检索用）
  raw_content  TEXT,                          -- 原始正文（30 天后可清，保留摘要）
  evidence     TEXT    NOT NULL,              -- 证据定位 'chat:group123#msg456'
  confidence   REAL    NOT NULL DEFAULT 0.8,  -- 该事件可信度 0..1
  salience     INTEGER NOT NULL DEFAULT 50,   -- 显著性 0..100，夜间衰减
  content_hash TEXT    NOT NULL,              -- 精确去重键
  deleted      INTEGER NOT NULL DEFAULT 0,    -- 软删标记
  merged_into  INTEGER REFERENCES events(id), -- 近似重复合并到哪条
  merge_count  INTEGER NOT NULL DEFAULT 1,    -- 被合并的次数
  created_at   TEXT    NOT NULL
);

-- 精确去重：同一内容的未删行只应存在一条
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_hash ON events(content_hash) WHERE deleted = 0;
-- 时间序检索 / 时间窗候选
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS ix_events_group_ts ON events(group_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_events_speaker ON events(speaker_id);
CREATE INDEX IF NOT EXISTS ix_events_kind ON events(kind);
-- 夜间维护：按显著性衰减扫描
CREATE INDEX IF NOT EXISTS ix_events_salience ON events(salience);

-- ---------------------------------------------------------------------------
-- entities：人 / 群 / 话题（把 QQ 号、人称、别名串在一起的表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK (type IN ('person','group','topic')),
  name       TEXT NOT NULL,                   -- 规范名
  aliases    TEXT,                            -- JSON 数组：['小肥','肥鱼', '123456789']
  note       TEXT,                            -- 备注：关系、称呼习惯
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_entities_type_name ON entities(type, name);
CREATE INDEX IF NOT EXISTS ix_entities_type ON entities(type);

-- 事件 ↔ 实体 多对多；role 表示该实体在事件中的角色
CREATE TABLE IF NOT EXISTS event_entities (
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT 'mention' CHECK (role IN ('mention','speaker','subject','object','place')),
  PRIMARY KEY (event_id, entity_id, role)
);

CREATE INDEX IF NOT EXISTS ix_ee_entity ON event_entities(entity_id);

-- ---------------------------------------------------------------------------
-- facts：巩固后的结构化事实（主体-谓词-客体）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  subject           TEXT    NOT NULL,          -- 通常是实体规范名
  predicate         TEXT    NOT NULL,          -- 关系/属性名，如 'lives_in'
  object            TEXT    NOT NULL,          -- 值
  confidence        REAL    NOT NULL,          -- 0..1，由支撑事件与来源计算
  evidence_event_ids TEXT   NOT NULL,          -- JSON 数组：支撑事件 id
  first_seen        TEXT    NOT NULL,
  last_seen         TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','conflict','retired')),
  salience          INTEGER NOT NULL DEFAULT 50,
  support           INTEGER NOT NULL DEFAULT 1,-- 支撑事件条数
  deleted           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_facts_triple
  ON facts(subject, predicate, object) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_facts_sp ON facts(subject, predicate);
CREATE INDEX IF NOT EXISTS ix_facts_status ON facts(status);

-- ---------------------------------------------------------------------------
-- persona：人格状态（单行表，id 恒为 1）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persona (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  constitution       TEXT NOT NULL,            -- 不可变宪法：任何自动更新都拒绝
  traits_json        TEXT NOT NULL,            -- {"curiosity":50,...} 0-100
  autobiography_json TEXT NOT NULL,            -- [{"event_id":12,"text":"..."}] ≤15 条
  version            INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- changelog：人格与事实的变更历史（支持回滚到任意版本）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS changelog (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL DEFAULT 'persona',  -- persona / facts
  version    INTEGER NOT NULL,
  diff_json  TEXT NOT NULL,                    -- 最小变更集
  reason     TEXT,                             -- 触发原因
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_changelog_scope ON changelog(scope, version DESC);

-- ---------------------------------------------------------------------------
-- FTS5：全文检索（trigram 分词，对中文友好）
-- 由应用层显式维护（写入时 INSERT、忘记时 DELETE），
-- 保证 forget 后立刻检索不到，不依赖异步重建。
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content,
  tokenize = 'trigram'
);

-- ---------------------------------------------------------------------------
-- tombstones：遗忘记录（可撤销）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tombstones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT NOT NULL,                    -- 'event:123' / 'fact:45'
  reason     TEXT,
  created_at TEXT NOT NULL,
  undone_at  TEXT,                             -- 非空表示已撤销
  snapshot   TEXT                              -- 被删行的 JSON 快照（undo 用）
);

CREATE INDEX IF NOT EXISTS ix_tombstones_target ON tombstones(target);
