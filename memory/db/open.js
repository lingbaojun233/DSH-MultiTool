'use strict';

/**
 * SQLite connection helper built on Node's built-in `node:sqlite`
 * (Node >= 22.5, no external dependency — keeps cold start under 2s).
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('./migrate.js');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'memory');
const DB_FILE = process.env.DSH_MEMORY_DB || path.join(DATA_DIR, 'memory.db');

function open(options = {}) {
  const file = options.file || DB_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  if (options.migrate !== false) migrate(db);

  return db;
}

function close(db) {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

module.exports = { open, close, DB_FILE, DATA_DIR };
