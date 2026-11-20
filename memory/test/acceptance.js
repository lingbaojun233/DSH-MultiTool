#!/usr/bin/env node
'use strict';

/**
 * 验收脚本：把需求 8 的六条指标逐条跑一遍。
 *
 *   node test/acceptance.js            # 完整（10 万条压测）
 *   node test/acceptance.js --quick    # 1 万条，快速自查
 *
 * 设计原则：数据直接构造，不依赖 remember() 的启发式，
 * 这样失败点只可能出现在被测能力本身。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { open } = require('../db/open.js');
const { estimateTokens } = require('../lib/budget.js');

const QUICK = process.argv.includes('--quick');
const N = QUICK ? 10000 : 100000;
const DB = path.join(os.tmpdir(), `mem-accept-${Date.now()}.db`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

const itemText = (item) => item.content || item.text || '';

(async () => {
  const coldStart = Date.now();
  const db = open({ file: DB });
  check('冷启动 < 2s', Date.now() - coldStart < 2000, `${Date.now() - coldStart}ms`);

  const { search } = require('../lib/search.js');
  const { forget, undoForget, nightly } = require('../lib/maintenance.js');

  // ---- 造 10 万条事件（含 FTS）-------------------------------------------
  const seedStart = Date.now();
  const insert = db.prepare(`INSERT INTO events
    (ts, channel, group_id, speaker_id, speaker_name, kind, content, raw_content, evidence, confidence, salience, content_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const fts = db.prepare('INSERT INTO events_fts(rowid, content) VALUES (?, ?)');
  const topics = ['部署', '项目', '服务器', '记忆模块', '面板', '隧道', '数据库', '测试', '人格', '冲突'];
  const people = ['阿鱼', '小林', '老周', '阿May', '大鹏'];

  db.exec('BEGIN');
  for (let i = 0; i < N; i += 1) {
    const topic = topics[i % topics.length];
    const person = people[i % people.length];
    const content = `${person} 在 ${(i % 28) + 1} 号说：${topic} 的第 ${i} 条记录，包含 ${topic} 相关细节与结论 ${(i * 7) % 997}`;
    const ts = new Date(Date.now() - (i % 120) * 86400000).toISOString();
    const info = insert.run(ts, 'chat', `g${i % 50}`, `u${i % 100}`, person, 'msg', content, content,
      `chat:g${i % 50}#m${i}`, 0.8, 30 + (i % 70), `h${i}`, ts);
    fts.run(info.lastInsertRowid, content);
  }
  db.exec('COMMIT');
  console.log(`  seeded ${N} events in ${Date.now() - seedStart}ms`);

  // ---- 1. search p95 ------------------------------------------------------
  for (let i = 0; i < 20; i += 1) search(db, { query: topics[i % topics.length] });
  const timings = [];
  for (let i = 0; i < 100; i += 1) {
    const q = `第 ${i * 3} 条 ${topics[i % topics.length]}`;
    const t0 = process.hrtime.bigint();
    search(db, { query: q });
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  timings.sort((a, b) => a - b);
  check('search p95 < 100ms', pct(timings, 95) < 100, `p95=${pct(timings, 95).toFixed(1)}ms p50=${pct(timings, 50).toFixed(1)}ms n=${N}`);

  // ---- 2. 预算严格 --------------------------------------------------------
  let budgetOk = true;
  let budgetDetail = '';
  for (const budget of [{ maxItems: 3, maxTokens: 150 }, { maxItems: 8, maxTokens: 400 }, { maxItems: 1, maxTokens: 60 }]) {
    const r = search(db, { query: '部署 项目 服务器', budget });
    const sum = r.items.reduce((acc, item) => acc + (item.tokens || estimateTokens(itemText(item))), 0);
    const perItemOk = r.items.every((item) => estimateTokens(itemText(item)) <= 120);
    if (r.items.length > budget.maxItems || sum > budget.maxTokens || !perItemOk) {
      budgetOk = false;
      budgetDetail = `budget=${JSON.stringify(budget)} got ${r.items.length} items / ${sum} tokens`;
      break;
    }
  }
  check('每次返回严格不超预算', budgetOk, budgetDetail || '3 组预算均满足');

  // ---- 3. 事实证据 100% 可回查 -------------------------------------------
  const now = new Date().toISOString();
  const eventIds = db.prepare('SELECT id FROM events WHERE deleted = 0 ORDER BY id LIMIT 50').all().map((r) => r.id);
  const insertFact = db.prepare(`INSERT INTO facts
    (subject, predicate, object, confidence, evidence_event_ids, first_seen, last_seen, status, salience, support, created_at)
    VALUES (?,?,?,?,?,?,?, 'active', 50, 1, ?)`);
  for (let i = 0; i < 50; i += 1) {
    insertFact.run(`subj${i}`, 'is', `obj${i}`, 0.9, JSON.stringify([eventIds[i]]), now, now, now);
  }
  const facts = db.prepare('SELECT id, evidence_event_ids FROM facts WHERE deleted = 0').all();
  let missing = 0;
  for (const fact of facts) {
    let ids = [];
    try { ids = JSON.parse(fact.evidence_event_ids || '[]'); } catch { ids = []; }
    if (!ids.length) { missing += 1; continue; }
    for (const id of ids) {
      if (!db.prepare('SELECT id FROM events WHERE id = ? AND deleted = 0').get(id)) missing += 1;
    }
  }
  check('随事实证据可回查率 100%', missing === 0 && facts.length === 50, `facts=${facts.length} missing=${missing}`);

  // ---- 4. forget 1 秒内不可检索 + undo（用唯一标记，不受排序影响）--------
  const marker = `UNIQUETOKEN${Date.now()}`;
  const victimInfo = insert.run(now, 'chat', 'gtest', 'utest', '测试员', 'msg',
    `${marker} 这条记录只用于验收遗忘`, null, 'chat:gtest#m1', 0.9, 60, `hv-${Date.now()}`, now);
  fts.run(victimInfo.lastInsertRowid, `${marker} 这条记录只用于验收遗忘`);
  const victimId = victimInfo.lastInsertRowid;

  const before = search(db, { query: marker });
  const forgotAt = Date.now();
  const forgotten = forget(db, `event:${victimId}`, 'acceptance');
  const after = search(db, { query: marker });
  const ftsHits = db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?").all(`"${marker}"`);
  const goneImmediately = !after.items.some((i) => i.id === victimId) && ftsHits.length === 0;
  check('forget 后 1 秒内不可检索', goneImmediately && Date.now() - forgotAt < 1000,
    `${Date.now() - forgotAt}ms, before=${before.items.length} after=${after.items.length}`);

  undoForget(db, forgotten.tombstoneId);
  const restored = search(db, { query: marker });
  check('undo 可恢复', restored.items.some((i) => i.id === victimId), `items=${restored.items.length}`);

  // ---- 5. 冲突不被静默合并 ------------------------------------------------
  insertFact.run('用户邮箱', 'is', 'a@example.com', 0.9, JSON.stringify([eventIds[0]]), now, now, now);
  insertFact.run('用户邮箱', 'is', 'b@example.com', 0.9, JSON.stringify([eventIds[1]]), now, now, now);
  nightly(db, {});
  const conflicts = db.prepare("SELECT object, evidence_event_ids FROM facts WHERE subject = '用户邮箱' AND status = 'conflict'").all();
  const bothKept = conflicts.length === 2 && conflicts.every((f) => JSON.parse(f.evidence_event_ids || '[]').length > 0);
  check('冲突不被静默合并', bothKept, `conflict rows=${conflicts.length}`);

  // ---- 汇总 ---------------------------------------------------------------
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB + suffix, { force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('未通过：', failed.map((f) => f.name).join('；'));
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('acceptance crashed:', err);
  process.exitCode = 1;
});
