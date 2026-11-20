-- 001_init.sql —— 初始结构（与 db/schema.sql 保持一致；schema.sql 是可读参考，本文件是可执行版本）
-- 后续结构变更一律新增 002_*.sql，不要改本文件。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,
  channel      TEXT    NOT NULL,
  group_id     TEXT,
  speaker_id   TEXT,
  speaker_name TEXT,
  kind         TEXT    NOT NULL CHECK (kind IN ('msg','video','action','commitment')),
  content      TEXT    NOT NULL,
  raw_content  TEXT,
  evidence     TEXT    NOT NULL,
  confidence   REAL    NOT NULL DEFAULT 0.8,
  salience     INTEGER NOT NULL DEFAULT 50,
  content_hash TEXT    NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  merged_into  INTEGER REFERENCES events(id),
  merge_count  INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_events_hash ON events(content_hash) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS ix_events_group_ts ON events(group_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_events_speaker ON events(speaker_id);
CREATE INDEX IF NOT EXISTS ix_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS ix_events_salience ON events(salience);

CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK (type IN ('person','group','topic')),
  name       TEXT NOT NULL,
  aliases    TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_entities_type_name ON entities(type, name);
CREATE INDEX IF NOT EXISTS ix_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS event_entities (
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT 'mention' CHECK (role IN ('mention','speaker','subject','object','place')),
  PRIMARY KEY (event_id, entity_id, role)
);

CREATE INDEX IF NOT EXISTS ix_ee_entity ON event_entities(entity_id);

CREATE TABLE IF NOT EXISTS facts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  subject            TEXT    NOT NULL,
  predicate          TEXT    NOT NULL,
  object             TEXT    NOT NULL,
  confidence         REAL    NOT NULL,
  evidence_event_ids TEXT    NOT NULL,
  first_seen         TEXT    NOT NULL,
  last_seen          TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','conflict','retired')),
  salience           INTEGER NOT NULL DEFAULT 50,
  support            INTEGER NOT NULL DEFAULT 1,
  deleted            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_facts_triple ON facts(subject, predicate, object) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_facts_sp ON facts(subject, predicate);
CREATE INDEX IF NOT EXISTS ix_facts_status ON facts(status);

CREATE TABLE IF NOT EXISTS persona (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  constitution       TEXT NOT NULL,
  traits_json        TEXT NOT NULL,
  autobiography_json TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changelog (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL DEFAULT 'persona',
  version    INTEGER NOT NULL,
  diff_json  TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_changelog_scope ON changelog(scope, version DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS tombstones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL,
  undone_at  TEXT,
  snapshot   TEXT
);

CREATE INDEX IF NOT EXISTS ix_tombstones_target ON tombstones(target);
