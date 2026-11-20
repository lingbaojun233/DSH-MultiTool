'use strict';

/**
 * 迁移执行器：按文件名顺序应用 migrations/*.sql，已应用的记录在 schema_migrations。
 * 幂等：重复运行不会重复执行；每个文件在一个事务里完成。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), file: path.join(MIGRATIONS_DIR, name) }));
}

function appliedVersions(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const rows = db.prepare('SELECT version FROM schema_migrations').all();
  return new Set(rows.map((row) => row.version));
}

function migrate(db, options = {}) {
  const applied = appliedVersions(db);
  const pending = listMigrations().filter((m) => !applied.has(m.version));
  const done = [];

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.file, 'utf8');
    if (options.dryRun) {
      done.push({ version: migration.version, dryRun: true });
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      done.push({ version: migration.version, applied: true });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} failed: ${err.message}`);
    }
  }

  return { pending: pending.length, applied: done };
}

module.exports = { migrate, listMigrations };
