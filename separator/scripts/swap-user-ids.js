'use strict';
// 一次性迁移：交换用户主键
//   lingbaojun233: 3 -> 1
//   aming:         1 -> 3
// 涉及 separator(users/sessions/user_traits) 与 memory(events/facts)。
// 用临时 id 9001 中转，避免 1<->3 直接对撞。

const { DatabaseSync } = require('node:sqlite');

const SEP = process.env.DSH_SEPARATOR_DB || 'C:/Apps/DSH-MultiTool/data/separator/separator.db';
const MEM = process.env.DSH_MEMORY_DB || 'C:/Apps/DSH-MultiTool/data/memory/memory.db';

const FROM_LING = 3; // 现在是 3
const TO_LING = 1; // 改成 1
const TEMP = 9001;

function swap(dbFile, targets, label) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000');
  // 主键互换必然短暂破坏引用，先关外键、事务内完成、再校验
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of targets) {
      // 1) 把"将变成 1"的那一方（3）先腾到临时位
      db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.col} = ?`).run(TEMP, FROM_LING);
      // 2) 原来的 1 直接改成 3
      db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.col} = ?`).run(FROM_LING, TO_LING);
      // 3) 临时位落到 1
      db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.col} = ?`).run(TO_LING, TEMP);
    }
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad && bad.length) throw new Error(label + ' FK violations: ' + JSON.stringify(bad));
    db.exec('COMMIT');
    console.log(label + ': swapped');
  } catch (err) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw err;
  } finally {
    db.close();
  }
}

swap(SEP, [
  { table: 'users', col: 'id' },
  { table: 'sessions', col: 'user_id' },
  { table: 'user_traits', col: 'user_id' },
], 'separator');

swap(MEM, [
  { table: 'events', col: 'user_id' },
  { table: 'facts', col: 'user_id' },
], 'memory');

// 校验
const sep = new DatabaseSync(SEP);
console.log('users:', JSON.stringify(sep.prepare('SELECT id, username, role FROM users ORDER BY id').all()));
console.log('sessions/user:', JSON.stringify(sep.prepare('SELECT user_id, COUNT(*) c FROM sessions GROUP BY user_id').all()));
sep.close();

const mem = new DatabaseSync(MEM);
console.log('events/user:', JSON.stringify(mem.prepare('SELECT user_id, COUNT(*) c FROM events WHERE deleted = 0 GROUP BY user_id').all()));
mem.close();
