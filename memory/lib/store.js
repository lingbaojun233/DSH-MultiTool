'use strict';

/**
 * Append-only storage.
 *
 *   data/memory/events/YYYY-MM.jsonl   原始事件，按月分片
 *   data/memory/rejected.jsonl         被证据闸门拒收的写入（含原因）
 *   data/memory/index/inverted.json    索引快照（可随时重建）
 *
 * Everything lives outside the module folder so `push` cannot destroy it.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'memory');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const INDEX_DIR = path.join(DATA_DIR, 'index');
const REJECTED_FILE = path.join(DATA_DIR, 'rejected.jsonl');

function ensureDirs() {
  for (const dir of [DATA_DIR, EVENTS_DIR, INDEX_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function monthKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${safe.getUTCFullYear()}-${String(safe.getUTCMonth() + 1).padStart(2, '0')}`;
}

function eventFile(iso) {
  return path.join(EVENTS_DIR, `${monthKey(iso)}.jsonl`);
}

function appendEvent(event) {
  ensureDirs();
  const file = eventFile(event.ts);
  const line = `${JSON.stringify(event)}\n`;
  fs.appendFileSync(file, line, 'utf8');
  return { file, bytes: Buffer.byteLength(line) };
}

function appendRejected(payload) {
  ensureDirs();
  fs.appendFileSync(REJECTED_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
}

function listEventFiles() {
  ensureDirs();
  return fs
    .readdirSync(EVENTS_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(EVENTS_DIR, name));
}

function readAllEvents() {
  const events = [];
  for (const file of listEventFiles()) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.id) events.push(parsed);
      } catch {
        /* torn line: skip, the audit trail still has the bytes */
      }
    }
  }
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return events;
}

function saveIndex(snapshot) {
  ensureDirs();
  fs.writeFileSync(path.join(INDEX_DIR, 'inverted.json'), JSON.stringify(snapshot), 'utf8');
}

function stats() {
  const events = readAllEvents();
  return {
    events: events.length,
    months: listEventFiles().length,
    dataDir: DATA_DIR,
    oldest: events.length ? events[0].ts : null,
    newest: events.length ? events[events.length - 1].ts : null,
  };
}

module.exports = {
  DATA_DIR,
  EVENTS_DIR,
  INDEX_DIR,
  REJECTED_FILE,
  ensureDirs,
  appendEvent,
  appendRejected,
  readAllEvents,
  saveIndex,
  stats,
};
