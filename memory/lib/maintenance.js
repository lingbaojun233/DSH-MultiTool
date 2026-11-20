'use strict';

/**
 * 记忆维护：夜间巩固（nightly）+ 遗忘（forget）+ 撤销遗忘（undoForget）。
 *
 * 设计约束：
 *   - 零外部依赖，只用 node:sqlite 的同步 API；调用方传入已迁移的 DatabaseSync。
 *   - 所有写库操作都封装在事务里。nightly 的 dryRun 用 SAVEPOINT + ROLLBACK 实现：
 *     走完全相同的代码路径，但一行都不落库（因此 dryRun 的计数与真实执行一致）。
 *   - events_fts 由应用层手工维护（schema 里刻意没有触发器），所以任何改动 content
 *     的地方都必须同步 FTS，否则会留下“改了内容还搜得到旧词”的脏索引。
 *   - 遗忘是软删：deleted=1 + 删 FTS + 写 tombstones 快照，undo 可完整恢复。
 *     删除与 FTS 清理在同一个事务里，所以 forget 返回后立即检索不到，不依赖异步重建。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- 可调策略参数（集中放置，便于按需调参 / 自测断言） ----
const DECAY_AFTER_DAYS = 30; // 超过 30 天的事件开始衰减显著性
const DECAY_FACTOR = 0.9; // 每晚 salience × 0.9（四舍五入）
const SALIENCE_FLOOR = 5; // 衰减 / 降权的下限
const LOW_SALIENCE_THRESHOLD = 10; // salience 低于该值且无引用 → 只降权到 5，不删
const RAW_RETENTION_DAYS = 30; // raw_content 只保留 30 天
const CONTENT_MAX_CHARS = 120; // 归档时 content 超长则截断到 120 字 + '…'
const ELLIPSIS = '…';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把 now（Date / 毫秒 / ISO 字符串）统一成毫秒时间戳；非法值退回当前时间。 */
function toMs(value, fallback = Date.now()) {
  if (value == null) return fallback;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? fallback : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? fallback : t;
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

/** 距今 days 天前的 ISO 时间点，SQL 里直接用字符串比较（全库统一 ISO8601 UTC）。 */
function cutoffIso(nowMs, days) {
  return isoOf(nowMs - days * DAY_MS);
}

/** 解析 facts.evidence_event_ids（JSON 数组字符串）；坏数据一律当空数组，不抛错。 */
function parseEvidenceIds(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  if (raw == null || raw === '') return [];
  try {
    const value = JSON.parse(String(raw));
    if (!Array.isArray(value)) return [];
    return value.map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

/** 去重并保持首次出现的顺序（合并证据时用）。 */
function dedupeIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 按 Unicode 码点截断（中文按“字”算，避免把 emoji / 代理对切坏）。 */
function clipChars(text, maxChars) {
  const chars = Array.from(String(text == null ? '' : text));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}${ELLIPSIS}`;
}

/** 真实执行：外层有事务就交给外层，否则自己开一个（BEGIN IMMEDIATE 防并发写竞争）。 */
function withTransaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

/** dryRun：在 SAVEPOINT 里跑同一套逻辑，跑完回滚，保证“只统计不写库”。 */
function withRollbackOnly(db, fn) {
  const savepoint = `sp_dry_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1) 合并重复事实
//
// 同一 subject+predicate+object 且都未删 → 保留“最早一条”（first_seen 最小，其次 id 最小），
// 合并 evidence_event_ids（并集去重）、support（求和）、last_seen（取最大），其余软删。
// 注意：正常 schema 上有 ux_facts_triple 部分唯一索引，理论上不会有重复；
// 这里仍然实现，是为了兼容历史库 / 索引缺失 / 迁移前的脏数据。
// ---------------------------------------------------------------------------

function mergeDuplicateFacts(db, counts) {
  const groups = db
    .prepare(
      `SELECT subject, predicate, object, COUNT(*) AS n
         FROM facts
        WHERE deleted = 0
        GROUP BY subject, predicate, object
       HAVING n > 1`,
    )
    .all();

  const selectRows = db.prepare(
    `SELECT id, evidence_event_ids, first_seen, last_seen, support
       FROM facts
      WHERE deleted = 0 AND subject = ? AND predicate = ? AND object = ?
      ORDER BY first_seen ASC, id ASC`,
  );
  const updateKeeper = db.prepare(
    `UPDATE facts
        SET evidence_event_ids = ?, support = ?, last_seen = ?
      WHERE id = ?`,
  );
  const softDelete = db.prepare('UPDATE facts SET deleted = 1 WHERE id = ?');

  for (const group of groups) {
    const rows = selectRows.all(group.subject, group.predicate, group.object);
    if (rows.length < 2) continue;

    const keeper = rows[0]; // 最早的一条
    // 证据：所有重复行的并集（keeper 自己原有的也保留，顺序稳定）
    const mergedEvidence = dedupeIds(rows.flatMap((row) => parseEvidenceIds(row.evidence_event_ids)));
    const support = rows.reduce((sum, row) => sum + (Number(row.support) || 0), 0);
    // last_seen 取最晚的；ISO8601 字符串可直接比较字典序
    const lastSeen =
      rows
        .map((row) => row.last_seen)
        .filter((value) => value != null && value !== '')
        .sort()
        .pop() || keeper.last_seen;

    updateKeeper.run(JSON.stringify(mergedEvidence), support, lastSeen, keeper.id);
    for (const row of rows.slice(1)) softDelete.run(row.id);
    counts.factsMerged += rows.length - 1;
  }
}

// ---------------------------------------------------------------------------
// 2) 冲突检测
//
// 同一 subject+predicate 但 object 不同 → 双方都标 conflict。
// 关键：不选一个赢，不动 evidence_event_ids / support / confidence —— 证据全部保留，
// 交给上层（人）裁决。下一晚这些行不再是 active，所以不会被重复处理。
//
// 两种情形都覆盖：
//   a) 双方都还是 active（本模块产生的历史数据）；
//   b) 写入方（remember）已经先把“后写的那条”标成 conflict，旧的那条还是 active ——
//      如果不补标，旧值就成了事实上的静默胜出，违背“不静默取舍”。
// ---------------------------------------------------------------------------

function markConflicts(db, counts) {
  const groups = db
    .prepare(
      `SELECT subject, predicate, COUNT(DISTINCT object) AS distinct_objects
         FROM facts
        WHERE deleted = 0 AND status IN ('active', 'conflict')
        GROUP BY subject, predicate
       HAVING distinct_objects > 1`,
    )
    .all();

  const selectSiblings = db.prepare(
    `SELECT id, status FROM facts
      WHERE deleted = 0 AND status IN ('active', 'conflict') AND subject = ? AND predicate = ?`,
  );
  // 只改 active 的行：已 conflict 的不重复计数
  const markConflict = db.prepare("UPDATE facts SET status = 'conflict' WHERE id = ? AND status = 'active'");

  for (const group of groups) {
    const siblings = selectSiblings.all(group.subject, group.predicate);
    if (siblings.length < 2) continue;

    let marked = 0;
    for (const row of siblings) {
      if (row.status !== 'active') continue;
      markConflict.run(row.id);
      marked += 1;
    }
    if (!marked) continue; // 已经全部是 conflict，无事可做
    counts.conflictGroups += 1;
    counts.conflicts += marked;
  }
}

// ---------------------------------------------------------------------------
// 3) 显著性衰减
//
// events 表没有 last_seen 列，事件用 ts 作为“最后一次被提起”的时间近似。
// 超过 30 天：salience = round(salience × 0.9)，最低 5；已经到 5 的不再写库、不计数。
// ---------------------------------------------------------------------------

function decaySalience(db, nowMs, counts) {
  const cutoff = cutoffIso(nowMs, DECAY_AFTER_DAYS);
  const rows = db.prepare('SELECT id, salience FROM events WHERE deleted = 0 AND ts < ?').all(cutoff);
  const update = db.prepare('UPDATE events SET salience = ? WHERE id = ?');

  for (const row of rows) {
    const current = Number(row.salience);
    if (!Number.isFinite(current)) continue;
    const next = Math.max(SALIENCE_FLOOR, Math.round(current * DECAY_FACTOR));
    if (next === current) continue; // 已在下限，无需写库
    update.run(next, row.id);
    counts.eventsDecayed += 1;
  }
}

// ---------------------------------------------------------------------------
// 4) 低显著且无引用：只降权，不删
//
// 判定“没有任何 facts.evidence_event_ids 引用它”。这里把已软删的事实也算进去：
// 事实被 forget 掉并不代表它引用的历史事件突然“没用了”，否则会误伤证据链。
// salinity < 10 且无引用 → salience 置 5（不 physical delete，也不动 FTS）。
// ---------------------------------------------------------------------------

function downgradeLowSalience(db, counts) {
  const referenced = new Set();
  for (const row of db.prepare('SELECT evidence_event_ids FROM facts').all()) {
    for (const id of parseEvidenceIds(row.evidence_event_ids)) referenced.add(id);
  }

  const rows = db
    .prepare('SELECT id, salience FROM events WHERE deleted = 0 AND salience < ?')
    .all(LOW_SALIENCE_THRESHOLD);
  const update = db.prepare('UPDATE events SET salience = ? WHERE id = ?');

  for (const row of rows) {
    if (referenced.has(Number(row.id))) continue; // 仍被事实引用，保留原显著度
    if (Number(row.salience) === SALIENCE_FLOOR) continue; // 已经是 5，无需写库
    update.run(SALIENCE_FLOOR, row.id);
    counts.eventsDowngraded += 1;
  }
}

// ---------------------------------------------------------------------------
// 5) 原始转写归档
//
// 超过 30 天：raw_content 置 NULL（省空间 + 降泄露风险），content 保留。
// 只有 content 超过 120 字时才截断到 120 字 + '…'，并同步 events_fts（先删后插）。
// ---------------------------------------------------------------------------

function archiveRawContent(db, nowMs, counts) {
  const cutoff = cutoffIso(nowMs, RAW_RETENTION_DAYS);
  const rows = db
    .prepare('SELECT id, content, raw_content FROM events WHERE deleted = 0 AND raw_content IS NOT NULL AND ts < ?')
    .all(cutoff);

  const updateEvent = db.prepare('UPDATE events SET raw_content = NULL, content = ? WHERE id = ?');
  const clearFts = db.prepare('DELETE FROM events_fts WHERE rowid = ?');
  const writeFts = db.prepare('INSERT INTO events_fts(rowid, content) VALUES (?, ?)');

  for (const row of rows) {
    const original = String(row.content == null ? '' : row.content);
    // clipChars 在超长时返回“前 120 字 + …”，否则原样返回
    const next = clipChars(original, CONTENT_MAX_CHARS);
    const truncated = next !== original;

    updateEvent.run(next, row.id);
    counts.rawArchived += 1;

    if (truncated) {
      clearFts.run(row.id);
      writeFts.run(row.id, next);
      counts.contentTruncated += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// nightly：按固定顺序跑 5 个阶段
//
//   1. 合并重复事实（先合并，冲突检测才不会把重复行误判成冲突）
//   2. 冲突标记
//   3. 显著性衰减（会先把 salience 拉低，可能让第 4 步命中）
//   4. 低显著无引用降权
//   5. 原始转写归档
//
// @param {DatabaseSync} db
// @param {{now?: number|string|Date, dryRun?: boolean}} [options]
// @returns {{ok: true, counts: object, dryRun: boolean}}
// ---------------------------------------------------------------------------

function nightly(db, options = {}) {
  const dryRun = !!options.dryRun;
  const nowMs = toMs(options.now);

  const counts = {
    factsMerged: 0, // 被合并掉的重复事实条数（不含保留的那条）
    conflicts: 0, // 本次被新标为 conflict 的活跃事实行数（已是 conflict 的不重复计）
    conflictGroups: 0, // 本次发生冲突标记的 (subject,predicate) 组数
    eventsDecayed: 0, // 实际被衰减（值有变化）的事件数
    eventsDowngraded: 0, // 低显著无引用、被降到 5 的事件数
    rawArchived: 0, // raw_content 被归档（置 NULL）的事件数
    contentTruncated: 0, // 归档时 content 被截断的事件数
  };

  const run = () => {
    mergeDuplicateFacts(db, counts);
    markConflicts(db, counts);
    decaySalience(db, nowMs, counts);
    downgradeLowSalience(db, counts);
    archiveRawContent(db, nowMs, counts);
  };

  if (dryRun) {
    withRollbackOnly(db, run);
  } else {
    withTransaction(db, run);
  }

  return { ok: true, counts, dryRun };
}

// ---------------------------------------------------------------------------
// forget：软删事件 + 删 FTS + 写 tombstone（快照可用于 undo）
//
// targetId 接受 'event:123' 或纯数字 123（也容忍 '123' 字符串）。
// 删除、FTS 清理、墓碑写入在同一个事务里 → 返回后立即检索不到。
// ---------------------------------------------------------------------------

/**
 * 解析遗忘目标，失败返回 null（不抛错，保持 forget 统一的 { ok, reason } 契约）。
 * 接受 'event:123' / '123' / 123；'fact:45' 目前不支持（facts 走软删，不走墓碑）。
 */
function normalizeEventTarget(targetId) {
  const raw = String(targetId == null ? '' : targetId).trim();
  if (!raw) return null;
  const match = /^(?:event\s*:\s*)?(\d+)$/i.exec(raw);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { id, target: `event:${id}` };
}

function forget(db, targetId, reason) {
  const parsed = normalizeEventTarget(targetId);
  if (!parsed) {
    return { ok: false, reason: 'invalid_target', target: String(targetId == null ? '' : targetId), tombstoneId: null };
  }
  const { id, target } = parsed;
  const reasonText = reason == null ? null : String(reason);

  return withTransaction(db, () => {
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!row) return { ok: false, reason: 'not_found', target, tombstoneId: null };
    if (Number(row.deleted) === 1) {
      return { ok: false, reason: 'already_deleted', target, tombstoneId: null };
    }

    const createdAt = new Date().toISOString();
    db.prepare('UPDATE events SET deleted = 1 WHERE id = ?').run(id);
    db.prepare('DELETE FROM events_fts WHERE rowid = ?').run(id);

    const info = db
      .prepare('INSERT INTO tombstones (target, reason, created_at, snapshot) VALUES (?, ?, ?, ?)')
      .run(target, reasonText, createdAt, JSON.stringify(row));

    return { ok: true, tombstoneId: Number(info.lastInsertRowid), target };
  });
}

// ---------------------------------------------------------------------------
// undoForget：按墓碑恢复
//
//   - deleted=0
//   - 重新写 events_fts（先删后插，容忍 FTS 里残留）
//   - tombstones.undone_at 置当前时间（已撤销的墓碑不能重复撤销）
//   - content_hash 唯一索引只约束 deleted=0 的行：若期间已有同内容新事件，
//     恢复会撞唯一索引，这里提前检查并返回 hash_conflict，而不是把库写坏。
// ---------------------------------------------------------------------------

function undoForget(db, tombstoneId) {
  const id = Number(tombstoneId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, reason: 'invalid_tombstone', target: null };
  }

  return withTransaction(db, () => {
    const tombstone = db.prepare('SELECT * FROM tombstones WHERE id = ?').get(id);
    if (!tombstone) return { ok: false, reason: 'not_found', target: null };
    if (tombstone.undone_at) {
      return { ok: false, reason: 'already_undone', target: tombstone.target };
    }

    const match = /^event:(\d+)$/.exec(String(tombstone.target || ''));
    if (!match) {
      return { ok: false, reason: 'unsupported_target', target: tombstone.target };
    }
    const eventId = Number(match[1]);

    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!row) return { ok: false, reason: 'missing_event', target: tombstone.target };

    const clash = db
      .prepare('SELECT id FROM events WHERE content_hash = ? AND deleted = 0 AND id <> ?')
      .get(row.content_hash, eventId);
    if (clash) {
      return {
        ok: false,
        reason: 'hash_conflict',
        target: tombstone.target,
        conflictEventId: Number(clash.id),
      };
    }

    db.prepare('UPDATE events SET deleted = 0 WHERE id = ?').run(eventId);
    db.prepare('DELETE FROM events_fts WHERE rowid = ?').run(eventId);
    db.prepare('INSERT INTO events_fts(rowid, content) VALUES (?, ?)').run(
      eventId,
      String(row.content == null ? '' : row.content),
    );
    db.prepare('UPDATE tombstones SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), id);

    return { ok: true, target: tombstone.target, tombstoneId: id };
  });
}

module.exports = {
  nightly,
  forget,
  undoForget,
  // 策略常量对外暴露，方便上层展示与自测断言
  DECAY_AFTER_DAYS,
  DECAY_FACTOR,
  SALIENCE_FLOOR,
  LOW_SALIENCE_THRESHOLD,
  RAW_RETENTION_DAYS,
  CONTENT_MAX_CHARS,
  // 内部小工具也导出，proactive 复用同一套时间解析
  toMs,
  clipChars,
  parseEvidenceIds,
};
