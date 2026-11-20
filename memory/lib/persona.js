'use strict';

/**
 * 人格状态（persona）——记忆模块的“自我”层。
 *
 * 设计要点：
 *   1. 宪法（constitution）不可变：所有写入都汇聚到 commitPersona()，
 *      只要目标宪法与库里现有值不一致就返回 { ok:false, reason:'constitution_immutable' }。
 *   2. traits 固定五个键（curiosity/warmth/directness/playfulness/caution），
 *      取值恒为 0-100 的整数；单次事件最多动 3 点，每天最多 2 次（数 changelog）。
 *   3. autobiography 每条必须挂真实存在的 event_id，最多 15 条。
 *   4. 所有落库都是“新版本 + 一条 changelog”，diff 为最小变更集：
 *      { traits: {k:{from,to}}, autobiography: {added:[], removed:[]} }。
 *      因此 rollback 可以靠反向重放 diff 恢复任意历史版本。
 *   5. render() 是纯函数式的（只读库、顺序固定、不含生成时刻），
 *      同样输入保证逐字节一致，并保证 estimateTokens 结果 ≤ 1500。
 *
 * 时间约定：一律 ISO8601 UTC 字符串；配置/入参里的 now 可为 Date 或可解析字符串。
 */

const { estimateTokens } = require('./budget.js');

// ---------------------------------------------------------------------------
// 常量（导出给调用方与测试用）
// ---------------------------------------------------------------------------

// traits 的键与顺序固定：所有 JSON 序列化、展示、diff 都按这个顺序来，保证可复现
const TRAIT_KEYS = Object.freeze(['curiosity', 'warmth', 'directness', 'playfulness', 'caution']);
const TRAIT_LABELS = Object.freeze({
  curiosity: '好奇心',
  warmth: '温暖',
  directness: '直率',
  playfulness: '顽皮',
  caution: '谨慎',
});
const TRAIT_MIN = 0;
const TRAIT_MAX = 100;
const TRAIT_BASE = 50; // 回归基线

const MAX_EVENT_DELTA = 3; // 单次事件的变动总幅度上限（绝对值和）
const MAX_DAILY_EVENT_CHANGES = 2; // 每天最多 2 次事件微调
const MAX_AUTOBIOGRAPHY = 15;
const MAX_DAILY_DIFF_ENTRIES = 3; // 巩固时每日变更条目上限
const RENDER_MAX_TOKENS = 1500; // 常驻块 token 上限
const HIGH_SALIENCE_MIN = 60; // 巩固只看显著性 ≥60 的事件
const AUTOBIO_TEXT_MAX = 80; // 单条自传正文长度上限（字符）
const CONSOLIDATE_EVENT_SCAN = 50; // 巩固单日最多扫描的事件数
const PERSONA_ID = 1; // persona 单行表，主键恒为 1
const SCOPE = 'persona'; // changelog 的 scope

// 默认宪法：仅在首次初始化时写入，之后永不变更。
// 篇幅刻意保持很短（约 150 token），给常驻块留出余量。
const DEFAULT_CONSTITUTION = [
  '你是「大肥鱼」，一个长期陪伴用户的助手。',
  '1. 诚实优先：不确定就说不确定，不编造事实与来源。',
  '2. 尊重边界：不替用户做不可逆决定，不窥探与任务无关的隐私。',
  '3. 人格稳定：温和、直率、有分寸；会开玩笑，但看场合。',
  '4. 可被纠正：被指正时先接受再改，不辩解、不纠缠。',
  '5. 记忆有据：只把有证据的事写进长期记忆；遗忘请求优先执行。',
].join('\n');

// 事件内容 → trait 方向（规则顺序固定，保证同一事件得到同一组信号）
const SIGNAL_RULES = Object.freeze([
  {
    trait: 'warmth',
    words: ['谢谢', '感谢', '辛苦', '多谢', '感恩', '贴心', '温暖', '拜托', '麻烦你了', '喜欢你', '爱你', '有你真好'],
  },
  {
    trait: 'curiosity',
    words: ['为什么', '怎么', '如何', '疑问', '探索', '好奇', '想知道', '能不能', '是否', '吗', '呢', '?', '？'],
  },
  {
    trait: 'playfulness',
    words: ['哈哈', '玩笑', '开玩笑', '搞笑', '有趣', '好玩', '梗', '嘿嘿', '逗你', '笑死', '233', 'lol', '乐死'],
  },
  {
    trait: 'caution',
    words: ['风险', '警告', '小心', '危险', '注意安全', '当心', '严重', '故障', '崩溃', '禁止', '慎重', '备份'],
  },
  {
    trait: 'directness',
    words: ['指正', '纠正', '不对', '错了', '搞错', '应该是', '直接说', '说实话', '别绕', '说重点', '明确一点'],
  },
]);

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/** 把 Date / 毫秒数 / 可解析字符串统一成 ISO8601 UTC；无法解析时退化为当前时刻。 */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  }
  return new Date().toISOString();
}

/** 只做严格解析，解析不了返回 null（用于校验库里/入参里的时间，绝不偷偷替换成 now）。 */
function parseIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

/** options.now 支持 Date / ISO 字符串，缺省取当前时刻。 */
function nowIso(options) {
  return toIso(options && options.now !== undefined ? options.now : undefined);
}

/** 安全 JSON.parse：脏数据不抛错，退化为 fallback。 */
function parseJson(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 统一换行与首尾空白：常驻块要求逐字节稳定，不能受 CRLF 影响。 */
function normalizeBlock(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/\r\n?/g, '\n').trim();
}

/** 压成单行并截断（按码点切，避免切坏中文）。 */
function clipText(value, max) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** trait 取值收敛到 0-100 的整数。 */
function clampTrait(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return TRAIT_BASE;
  return Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, n));
}

/** 补齐五个键、按固定顺序重建对象（顺序即 JSON 键顺序）。 */
function normalizeTraits(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const traits = {};
  for (const key of TRAIT_KEYS) {
    traits[key] = clampTrait(source[key] === undefined ? TRAIT_BASE : source[key]);
  }
  return traits;
}

/** 单条自传的规范化；形状不合法返回 null。 */
function normalizeAutobiographyItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const eventId = Number(raw.event_id);
  if (!Number.isInteger(eventId) || eventId <= 0) return null;
  const text = clipText(raw.text, 400);
  if (!text) return null;
  const ts = parseIso(raw.ts);
  if (!ts) return null;
  return { event_id: eventId, text, ts };
}

/** 自传排序：先按事件时间、再按 event_id，保证任何输入的输出顺序唯一。 */
function sortAutobiography(list) {
  return list.slice().sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (ta !== tb) return ta - tb;
    return a.event_id - b.event_id;
  });
}

/**
 * 规范化整个自传数组：按 event_id 去重、丢弃脏条目、按时间排序。
 * cap=true 时裁到 15 条（保留较新的）；commitPersona 内部用 cap=false 读旧值，
 * 这样"库里曾被写进 20 条"这种情况也能在 diff 里如实体现裁剪。
 */
function normalizeAutobiography(raw, options = {}) {
  const cap = options.cap !== false;
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const items = [];
  for (const entry of list) {
    const item = normalizeAutobiographyItem(entry);
    if (!item || seen.has(item.event_id)) continue;
    seen.add(item.event_id);
    items.push(item);
  }
  const sorted = sortAutobiography(items);
  const kept = cap && sorted.length > MAX_AUTOBIOGRAPHY ? sorted.slice(sorted.length - MAX_AUTOBIOGRAPHY) : sorted;
  return sortAutobiography(kept);
}

/** 一天的 UTC 起点 / 终点（用于"当天"配额与巩固时间窗）。 */
function utcDayStart(iso) {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

function utcDayEnd(iso) {
  return new Date(Date.parse(utcDayStart(iso)) + 86400000).toISOString();
}

// ---------------------------------------------------------------------------
// diff 相关
// ---------------------------------------------------------------------------

/** 计算 current → next 的最小 diff（traits 只记变了的键；自传只记增删）。 */
function diffPersona(current, next) {
  const traits = {};
  for (const key of TRAIT_KEYS) {
    const from = current.traits[key];
    const to = next.traits[key];
    if (from !== to) traits[key] = { from, to };
  }
  const prevIds = new Set(current.autobiography.map((item) => item.event_id));
  const nextIds = new Set(next.autobiography.map((item) => item.event_id));
  const added = next.autobiography.filter((item) => !prevIds.has(item.event_id));
  const removed = current.autobiography.filter((item) => !nextIds.has(item.event_id));
  return { traits, autobiography: { added, removed } };
}

/** diff 的"变更条目"数：trait 变更数 + 自传增删数。 */
function diffEntryCount(diff) {
  if (!diff) return 0;
  const traitCount = Object.keys(diff.traits || {}).length;
  const added = (diff.autobiography && diff.autobiography.added) || [];
  const removed = (diff.autobiography && diff.autobiography.removed) || [];
  return traitCount + added.length + removed.length;
}

/**
 * 计入"每日 3 条"配额的变更数。
 * 15 条上限本身是硬不变量：当库里已有超限数据（历史遗留 / 外部写入）时，
 * 为恢复不变量而删掉的条目属于修复，不占用语义变更配额；
 * 其余新增、删除与 trait 变更照常计数。
 */
function billableEntries(diff, repair) {
  const removed = ((diff && diff.autobiography) || {}).removed || [];
  const freeRemovals = Math.min(removed.length, Math.max(0, Number(repair) || 0));
  return diffEntryCount(diff) - freeRemovals;
}

/** 把 diff 反向应用回状态（rollback 用）。 */
function applyInverseDiff(state, diff) {
  const traits = { ...state.traits };
  for (const key of TRAIT_KEYS) {
    const change = diff && diff.traits ? diff.traits[key] : null;
    if (change && Number.isInteger(change.from)) traits[key] = clampTrait(change.from);
  }
  const addedIds = new Set((((diff || {}).autobiography || {}).added || []).map((item) => item.event_id));
  const removedItems = (((diff || {}).autobiography || {}).removed || []).slice();
  const kept = state.autobiography.filter((item) => !addedIds.has(item.event_id));
  const byId = new Map(kept.map((item) => [item.event_id, item]));
  for (const item of removedItems) {
    const normalized = normalizeAutobiographyItem(item);
    if (normalized && !byId.has(normalized.event_id)) byId.set(normalized.event_id, normalized);
  }
  return { traits, autobiography: sortAutobiography([...byId.values()]) };
}

// ---------------------------------------------------------------------------
// 读库
// ---------------------------------------------------------------------------

/**
 * 读取 persona 行；不存在返回 null。
 * options.cap=false 时不裁自传（供 commitPersona 精确算 diff）。
 */
function readRow(db, options = {}) {
  const row = db
    .prepare('SELECT constitution, traits_json, autobiography_json, version, updated_at FROM persona WHERE id = ?')
    .get(PERSONA_ID);
  if (!row) return null;
  return {
    constitution: normalizeBlock(row.constitution),
    traits: normalizeTraits(parseJson(row.traits_json, {})),
    autobiography: normalizeAutobiography(parseJson(row.autobiography_json, []), { cap: options.cap !== false }),
    version: Number(row.version) || 1,
    updatedAt: String(row.updated_at || ''),
  };
}

/** 批量校验 event_id 是否真实存在（且未软删）。 */
function loadEventIds(db, ids) {
  const unique = [...new Set((ids || []).filter((id) => Number.isInteger(id) && id > 0))];
  const known = new Set();
  if (!unique.length) return known;
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id FROM events WHERE deleted = 0 AND id IN (${placeholders})`).all(...unique);
  for (const row of rows) known.add(Number(row.id));
  return known;
}

/** 当天已发生的 persona 变更次数（数 changelog，规则 2）。 */
function countDailyChanges(db, iso) {
  const start = utcDayStart(iso);
  const end = utcDayEnd(iso);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM changelog WHERE scope = ? AND created_at >= ? AND created_at < ?`)
    .get(SCOPE, start, end);
  return row ? Number(row.n) || 0 : 0;
}

/** 事件正文 → 命中的 trait 信号（顺序由 SIGNAL_RULES 固定）。 */
function matchSignals(content) {
  const text = String(content === null || content === undefined ? '' : content).toLowerCase();
  const hits = [];
  for (const rule of SIGNAL_RULES) {
    const word = rule.words.find((candidate) => text.includes(candidate.toLowerCase()));
    if (word) hits.push({ trait: rule.trait, word });
  }
  return hits;
}

/** 事件 → 自传候选正文（确定性：只依赖事件自身字段）。 */
function autobiographyText(event) {
  const content = clipText(event.content, AUTOBIO_TEXT_MAX);
  if (!content) return '';
  const speaker = String(event.speaker_name || '').trim();
  return speaker ? `${speaker}：${content}` : content;
}

// ---------------------------------------------------------------------------
// 写库（唯一出口）
// ---------------------------------------------------------------------------

/**
 * 统一写入口：校验宪法 → 归一化 → diff → 同一个事务里更新 persona 并写 changelog。
 * 规则 1/5 只在这里实现一次，任何调用方都无法绕过。
 *
 * @returns {{ok:true, version:number, traits:object, autobiography:object[], diff:object, entries:number}
 *          |{ok:false, reason:string}}
 */
function commitPersona(db, patch, meta = {}) {
  const now = toIso(meta.now);
  const current = readRow(db, { cap: false });
  if (!current) return { ok: false, reason: 'persona_not_initialized' };

  // 规则 1：宪法不可变。未显式传入就沿用库里的；传了但不同一律拒绝，绝不静默改。
  const nextConstitution =
    patch && patch.constitution !== undefined ? normalizeBlock(patch.constitution) : current.constitution;
  if (nextConstitution !== current.constitution) {
    return { ok: false, reason: 'constitution_immutable' };
  }

  const traits = normalizeTraits(patch && patch.traits ? patch.traits : current.traits);
  const autobiography = normalizeAutobiography(
    patch && patch.autobiography ? patch.autobiography : current.autobiography,
  );
  const diff = diffPersona(current, { traits, autobiography });
  const entries = diffEntryCount(diff);
  if (entries === 0) return { ok: false, reason: 'no_change' };

  const version = current.version + 1;
  const reason = meta.reason === undefined || meta.reason === null ? null : String(meta.reason);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      'UPDATE persona SET traits_json = ?, autobiography_json = ?, version = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(traits), JSON.stringify(autobiography), version, now, PERSONA_ID);
    db.prepare(
      'INSERT INTO changelog (scope, version, diff_json, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(SCOPE, version, JSON.stringify(diff), reason, now);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务可能已自动结束 */
    }
    throw err;
  }

  return { ok: true, version, traits, autobiography, diff, entries };
}

/** 供内部写操作使用：没有 persona 就先初始化。 */
function ensurePersona(db) {
  const row = readRow(db);
  if (row) return row;
  initPersona(db);
  return readRow(db);
}

/**
 * 内部读取：不裁自传。
 * consolidate / rollback 需要看到库里的"全量真实状态"，否则历史遗留的超限条目
 * 会在读取时就被裁掉，diff 反而算不出来。
 */
function readPersonaFull(db) {
  return readRow(db, { cap: false });
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 幂等初始化：persona 行不存在才插入（version=1、traits 全 50、自传为空）。
 * 已存在时只做宪法一致性检查：与库里不同则返回 { ok:false, reason:'constitution_immutable' }。
 *
 * 注意：初始化不写 changelog（version 1 即基线态，rollback 可回到它），
 * 因此不会占用"每天 2 次事件微调"的配额。
 *
 * @param {object} db DatabaseSync
 * @param {{constitution?:string, traits?:object, autobiography?:object[], now?:Date|string}} [options]
 */
function initPersona(db, options = {}) {
  const row = readRow(db);
  const constitution = options.constitution === undefined ? DEFAULT_CONSTITUTION : normalizeBlock(options.constitution);

  if (row) {
    if (constitution !== row.constitution) {
      return { ok: false, reason: 'constitution_immutable', created: false, version: row.version };
    }
    return { ok: true, created: false, version: row.version, constitution: row.constitution, updatedAt: row.updatedAt };
  }

  const now = nowIso(options);
  const traits = normalizeTraits(options.traits);
  const autobiography = normalizeAutobiography(options.autobiography || []);
  const finalConstitution = constitution || DEFAULT_CONSTITUTION;

  db.prepare(
    'INSERT INTO persona (id, constitution, traits_json, autobiography_json, version, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(PERSONA_ID, finalConstitution, JSON.stringify(traits), JSON.stringify(autobiography), now);

  return { ok: true, created: true, version: 1, constitution: finalConstitution, traits, autobiography, updatedAt: now };
}

/**
 * 读取人格快照（只读，不写库）。
 * 尚未初始化时返回默认值并标 version=0，方便调用方先渲染再初始化。
 *
 * @returns {{constitution:string, traits:object, autobiography:object[], version:number, updatedAt:string}}
 */
function getPersona(db) {
  const row = readRow(db);
  if (!row) {
    return {
      constitution: DEFAULT_CONSTITUTION,
      traits: normalizeTraits({}),
      autobiography: [],
      version: 0,
      updatedAt: '',
    };
  }
  return {
    constitution: row.constitution,
    traits: row.traits,
    autobiography: row.autobiography,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/**
 * 单事件微调 traits（规则 2）。
 *   - 事件必须存在且未软删；
 *   - 方向由内容规则决定（每条信号 +1）；
 *   - 单次事件总幅度 ≤ MAX_EVENT_DELTA(3)，同一 trait 单次只动一次；
 *   - 每天最多 MAX_DAILY_EVENT_CHANGES(2) 次（数 changelog 当天 persona 记录）；
 *   - 全部命中的 trait 都已到 100 时拒绝（trait_at_bound）。
 *
 * @returns {{applied:boolean, reason:string, traits:object, version?:number, deltas?:object, diff?:object}}
 */
function applyEvent(db, eventId, options = {}) {
  const id = Number(eventId);
  const persona = ensurePersona(db);
  if (!persona) return { applied: false, reason: 'persona_not_initialized', traits: normalizeTraits({}) };

  if (!Number.isInteger(id) || id <= 0) {
    return { applied: false, reason: 'invalid_event_id', traits: persona.traits };
  }

  const now = nowIso(options);

  // 规则 2 的每日配额
  const usedToday = countDailyChanges(db, now);
  if (usedToday >= MAX_DAILY_EVENT_CHANGES) {
    return {
      applied: false,
      reason: 'daily_limit_reached',
      traits: persona.traits,
      usedToday,
      limit: MAX_DAILY_EVENT_CHANGES,
    };
  }

  const event = db.prepare('SELECT id, ts, content, salience, deleted FROM events WHERE id = ?').get(id);
  if (!event || Number(event.deleted) === 1) {
    return { applied: false, reason: 'event_not_found', traits: persona.traits };
  }

  const hits = matchSignals(event.content);
  if (!hits.length) {
    return { applied: false, reason: 'no_signal', traits: persona.traits };
  }

  const deltas = {};
  const atBound = [];
  let budget = MAX_EVENT_DELTA;
  for (const hit of hits) {
    if (budget <= 0) break;
    if (deltas[hit.trait]) continue; // 同一 trait 单次事件只动一次
    const from = persona.traits[hit.trait];
    if (from + 1 > TRAIT_MAX) {
      atBound.push(hit.trait);
      continue;
    }
    deltas[hit.trait] = 1;
    budget -= 1;
  }

  if (!Object.keys(deltas).length) {
    return {
      applied: false,
      reason: atBound.length ? 'trait_at_bound' : 'no_signal',
      traits: persona.traits,
      atBound,
    };
  }

  const nextTraits = { ...persona.traits };
  for (const key of Object.keys(deltas)) nextTraits[key] = clampTrait(nextTraits[key] + deltas[key]);

  const signalText = Object.keys(deltas).join(',');
  const write = commitPersona(
    db,
    { traits: nextTraits, autobiography: persona.autobiography },
    { reason: `event:${id};${signalText}`, now },
  );

  if (!write.ok) {
    return { applied: false, reason: write.reason, traits: persona.traits };
  }

  return {
    applied: true,
    reason: `event:${id};${signalText}`,
    traits: write.traits,
    version: write.version,
    deltas,
    diff: write.diff,
  };
}

/**
 * 每周向基线 50 回归 1 点（规则：每个 trait 各动 1 点，0/100 边界夹紧）。
 * 全部已在 50 上时不写库（changed=false）。
 *
 * @param {object} db
 * @param {Date|string} [now] 便于测试的时间点
 */
function weeklyRegression(db, now) {
  const persona = ensurePersona(db);
  if (!persona) return { ok: false, reason: 'persona_not_initialized' };
  const at = nowIso({ now });

  const nextTraits = {};
  const deltas = {};
  for (const key of TRAIT_KEYS) {
    const value = persona.traits[key];
    let target = value;
    if (value > TRAIT_BASE) target = value - 1;
    else if (value < TRAIT_BASE) target = value + 1;
    nextTraits[key] = target;
    if (target !== value) deltas[key] = target - value;
  }

  if (!Object.keys(deltas).length) {
    return {
      ok: true,
      changed: false,
      reason: 'already_at_baseline',
      traits: persona.traits,
      version: persona.version,
    };
  }

  const write = commitPersona(
    db,
    { traits: nextTraits, autobiography: persona.autobiography },
    { reason: `weekly_regression:${at.slice(0, 10)}`, now: at },
  );
  if (!write.ok) return { ok: false, reason: write.reason, traits: persona.traits };

  return {
    ok: true,
    changed: true,
    traits: write.traits,
    version: write.version,
    deltas,
    diff: write.diff,
  };
}

/** 合并现有自传与新增候选，超过 15 条时丢最旧的（保留新故事）。 */
function mergeAutobiography(existing, additions) {
  const byId = new Map();
  for (const item of existing) byId.set(item.event_id, item);
  for (const item of additions) byId.set(item.event_id, item);
  const all = sortAutobiography([...byId.values()]);
  const overflow = Math.max(0, all.length - MAX_AUTOBIOGRAPHY);
  const evicted = overflow ? all.slice(0, overflow).map((item) => ({ event_id: item.event_id, text: item.text })) : [];
  return { items: overflow ? all.slice(overflow) : all, evicted };
}

/** 落库前的最后一道校验（规则 4）。返回问题列表，空数组即通过。 */
function validateDiff(db, diff, current, repair) {
  const problems = [];
  const billable = billableEntries(diff, repair);
  if (billable > MAX_DAILY_DIFF_ENTRIES) {
    problems.push(`计入配额的变更 ${billable} 条，超过每日上限 ${MAX_DAILY_DIFF_ENTRIES} 条`);
  }

  const added = (diff.autobiography && diff.autobiography.added) || [];
  const known = loadEventIds(db, added.map((item) => item.event_id));
  for (const item of added) {
    if (!Number.isInteger(item.event_id) || item.event_id <= 0) {
      problems.push('自传新增条目缺少合法 event_id');
      continue;
    }
    if (!known.has(item.event_id)) problems.push(`自传新增条目引用的 event_id=${item.event_id} 不存在`);
    if (!item.text) problems.push(`自传新增条目 event_id=${item.event_id} 正文为空`);
  }

  for (const key of Object.keys(diff.traits || {})) {
    const to = diff.traits[key].to;
    if (!Number.isInteger(to) || to < TRAIT_MIN || to > TRAIT_MAX) {
      problems.push(`trait ${key} 目标值 ${to} 越界（应为 ${TRAIT_MIN}-${TRAIT_MAX} 的整数）`);
    }
  }

  const removedCount = ((diff.autobiography && diff.autobiography.removed) || []).length;
  const finalCount = current.autobiography.length - removedCount + added.length;
  if (finalCount > MAX_AUTOBIOGRAPHY) {
    problems.push(`自传将达 ${finalCount} 条，超过上限 ${MAX_AUTOBIOGRAPHY} 条`);
  }

  return problems;
}

/**
 * 夜间巩固：从当天高显著事件生成 autobiography 候选与最小 diff。
 *   - 候选必须能回查到 events 表，查不到的丢弃并在 dropped 里说明；
 *   - 超过 15 条时丢最旧的（保留新故事）；
 *   - 语义变更条目 ≤3（新增 + 删除 + trait 变更），超出则少加几条，校验不通过绝不落库；
 *   - dryRun 只返回 diff / 候选，不写库。
 *
 * @param {object} db
 * @param {{dryRun?:boolean, now?:Date|string}} [options]
 */
function consolidate(db, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const now = nowIso(options);
  // 用未裁剪的全量状态做基准，才能如实算出"历史超限条目"的删除 diff
  const persona = readPersonaFull(db);
  if (!persona) {
    return { ok: false, reason: 'persona_not_initialized', dryRun };
  }

  const dayStart = utcDayStart(now);
  const dayEnd = utcDayEnd(now);

  // 1) 当日高显著事件（排序固定，保证同样数据得同样候选）
  const events = db
    .prepare(
      `SELECT id, ts, content, speaker_name, salience FROM events
        WHERE deleted = 0 AND ts >= ? AND ts < ? AND salience >= ?
        ORDER BY salience DESC, ts ASC, id ASC
        LIMIT ?`,
    )
    .all(dayStart, dayEnd, HIGH_SALIENCE_MIN, CONSOLIDATE_EVENT_SCAN);

  // 2) 现有自传里 event_id 已失效的条目要剔除（规则 3 的"真实存在"是持续不变量）
  const dropped = [];
  const knownExisting = loadEventIds(
    db,
    persona.autobiography.map((item) => item.event_id),
  );
  const survivors = [];
  for (const item of persona.autobiography) {
    if (knownExisting.has(item.event_id)) survivors.push(item);
    else dropped.push({ event_id: item.event_id, text: item.text, reason: 'event_missing' });
  }

  // 3) 组装候选，并逐个回查 events 表
  const seen = new Set(survivors.map((item) => item.event_id));
  const candidateIds = events.map((event) => Number(event.id)).filter((id) => !seen.has(id));
  const validIds = loadEventIds(db, candidateIds);
  const candidates = [];
  for (const event of events) {
    const id = Number(event.id);
    if (seen.has(id)) continue;
    if (!validIds.has(id)) {
      dropped.push({ event_id: id, reason: 'event_missing' });
      continue;
    }
    const ts = parseIso(event.ts);
    if (!ts) {
      dropped.push({ event_id: id, reason: 'invalid_ts' });
      continue;
    }
    const text = autobiographyText(event);
    if (!text) {
      dropped.push({ event_id: id, reason: 'empty_text' });
      continue;
    }
    candidates.push({ event_id: id, text, ts });
  }

  // 4) 在"每日变更条目 ≤3"的约束下，选最大的可落库候选集（从多到少试）
  //    repair：库里历史遗留的超限条目，为恢复 15 条上限而删除的部分不占配额。
  const repair = Math.max(0, persona.autobiography.length - MAX_AUTOBIOGRAPHY);
  const maxAdds = Math.min(candidates.length, MAX_DAILY_DIFF_ENTRIES);
  let plan = null;
  for (let take = maxAdds; take >= 0; take -= 1) {
    const merged = mergeAutobiography(survivors, candidates.slice(0, take));
    const diff = diffPersona(persona, { traits: persona.traits, autobiography: merged.items });
    if (billableEntries(diff, repair) <= MAX_DAILY_DIFF_ENTRIES) {
      plan = { additions: take, items: merged.items, evicted: merged.evicted, diff, repair };
      break;
    }
  }

  if (!plan) {
    return {
      ok: false,
      dryRun,
      reason: 'daily_diff_limit',
      limit: MAX_DAILY_DIFF_ENTRIES,
      dropped,
      candidates: candidates.map((item) => item.event_id),
    };
  }

  // 5) 校验闸门：不通过绝不落库
  const problems = validateDiff(db, plan.diff, persona, plan.repair);
  if (problems.length) {
    return { ok: false, dryRun, reason: 'validation_failed', problems, diff: plan.diff, dropped };
  }

  const diffEntries = diffEntryCount(plan.diff);
  const entries = billableEntries(plan.diff, plan.repair);
  const trimmed = Math.max(0, candidates.length - plan.additions);
  const base = {
    ok: true,
    dryRun,
    changed: false, // applied 的别名：调用方（如 server.js 夜间审计）用 changed 判断
    diff: plan.diff,
    entries,
    diffEntries,
    dropped,
    evicted: plan.evicted,
    trimmed,
    considered: events.length,
    candidates: candidates.map((item) => ({ event_id: item.event_id, ts: item.ts, text: item.text })),
  };

  if (diffEntries === 0) {
    return { ...base, applied: false, reason: 'no_change', version: persona.version };
  }

  if (dryRun) {
    return { ...base, applied: false, reason: 'dry_run', version: persona.version, nextVersion: persona.version + 1 };
  }

  const write = commitPersona(
    db,
    { traits: persona.traits, autobiography: plan.items },
    { reason: `consolidate:${dayStart.slice(0, 10)}`, now },
  );
  if (!write.ok) {
    return { ...base, ok: false, applied: false, reason: write.reason };
  }

  return {
    ...base,
    applied: true,
    changed: true,
    reason: 'consolidated',
    version: write.version,
    autobiography: write.autobiography,
  };
}

/**
 * 回滚到指定 changelog 版本（rollback 本身也算一次变更，会产生新版本 + 新 changelog）。
 * 做法：从当前版本逐版反向重放 diff，得到目标版本的状态，再以新版本落库。
 *
 * @param {object} db
 * @param {number} version 目标版本（1 = 初始基线态）
 */
function rollback(db, version, options = {}) {
  const target = Number(version);
  const persona = readPersonaFull(db);
  if (!persona) return { ok: false, reason: 'persona_not_initialized' };
  if (!Number.isInteger(target) || target < 1) {
    return { ok: false, reason: 'invalid_version', currentVersion: persona.version };
  }
  if (target > persona.version) {
    return { ok: false, reason: 'version_in_future', currentVersion: persona.version };
  }
  if (target === persona.version) {
    return { ok: true, changed: false, reason: 'already_at_version', version: persona.version };
  }

  // 需要 (target, current] 的每一版 diff；缺失说明 changelog 被裁过，不能假装能还原
  const rows = db
    .prepare(
      `SELECT version, diff_json FROM changelog
        WHERE scope = ? AND version > ? AND version <= ?
        ORDER BY version DESC`,
    )
    .all(SCOPE, target, persona.version);

  const have = new Set(rows.map((row) => Number(row.version)));
  const missing = [];
  for (let v = persona.version; v > target; v -= 1) {
    if (!have.has(v)) missing.push(v);
  }
  if (missing.length) {
    return { ok: false, reason: 'changelog_incomplete', missing, currentVersion: persona.version };
  }

  let traits = { ...persona.traits };
  let autobiography = persona.autobiography.map((item) => ({ ...item }));
  for (const row of rows) {
    const diff = parseJson(row.diff_json, null);
    if (!diff || typeof diff !== 'object') {
      return { ok: false, reason: 'changelog_corrupt', version: Number(row.version) };
    }
    const restored = applyInverseDiff({ traits, autobiography }, diff);
    traits = restored.traits;
    autobiography = restored.autobiography;
  }

  const diff = diffPersona(persona, { traits, autobiography });
  if (diffEntryCount(diff) === 0) {
    return { ok: true, changed: false, reason: 'already_at_version', version: persona.version };
  }

  const write = commitPersona(
    db,
    { traits, autobiography },
    { reason: `rollback:v${target}`, now: nowIso(options) },
  );
  if (!write.ok) return { ok: false, reason: write.reason, currentVersion: persona.version };

  return {
    ok: true,
    changed: true,
    target,
    fromVersion: persona.version,
    version: write.version,
    diff: write.diff,
    entries: write.entries,
    traits: write.traits,
    autobiography: write.autobiography,
  };
}

// ---------------------------------------------------------------------------
// 常驻块渲染
// ---------------------------------------------------------------------------

function traitLine(traits) {
  return TRAIT_KEYS.map((key) => `${TRAIT_LABELS[key]} ${traits[key]}`).join(' ｜ ');
}

function autobiographyLine(item, index) {
  return `${index + 1}. #${item.event_id} ${item.text}`;
}

/** 拼装常驻块；hidden 为因预算被省略的自传条数。 */
function buildBlock(constitution, traits, items, hidden) {
  const lines = ['【人格宪法】', constitution, '', '【人格数值】', traitLine(traits), '', '【自传】'];
  if (!items.length && hidden === 0) lines.push('（暂无）');
  for (let i = 0; i < items.length; i += 1) lines.push(autobiographyLine(items[i], i));
  if (hidden > 0) lines.push(`…（另有 ${hidden} 条自传因预算省略）`);
  return lines.join('\n');
}

/**
 * 常驻块（≤1500 token）。
 * 输出完全由库内数据决定：固定段落顺序、固定 trait 顺序、自传按 (ts,event_id) 排序、
 * 不含生成时间戳，因此同样的输入两次调用逐字节一致。
 *
 * @returns {string}
 */
function render(db) {
  const persona = getPersona(db);
  const constitution = normalizeBlock(persona.constitution) || '（未设置）';
  const traits = persona.traits;
  const items = sortAutobiography(persona.autobiography);

  // 从全量开始，放不下就逐步丢掉自传尾部（并加省略标记）
  for (let keep = items.length; keep >= 0; keep -= 1) {
    const block = buildBlock(constitution, traits, items.slice(0, keep), items.length - keep);
    if (estimateTokens(block) <= RENDER_MAX_TOKENS) return block;
  }

  // 极端情况：宪法本身就把预算吃光了。二分找能放下的最长宪法前缀。
  const chars = [...constitution];
  let lo = 0;
  let hi = chars.length;
  let best = '';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = mid >= chars.length ? constitution : `${chars.slice(0, mid).join('')}…`;
    const block = buildBlock(candidate, traits, [], items.length);
    if (estimateTokens(block) <= RENDER_MAX_TOKENS) {
      best = block;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;

  // 最后兜底（正常数据走不到）：硬截断整块
  let clipped = '';
  for (const ch of buildBlock(constitution, traits, [], items.length)) {
    if (estimateTokens(clipped + ch) > RENDER_MAX_TOKENS - 1) break;
    clipped += ch;
  }
  return `${clipped}…`;
}

module.exports = {
  // 需求规定的七个导出
  initPersona,
  getPersona,
  applyEvent,
  weeklyRegression,
  consolidate,
  rollback,
  render,
  // 常量（调用方/测试断言用）
  TRAIT_KEYS,
  TRAIT_LABELS,
  TRAIT_BASE,
  TRAIT_MIN,
  TRAIT_MAX,
  MAX_EVENT_DELTA,
  MAX_DAILY_EVENT_CHANGES,
  MAX_AUTOBIOGRAPHY,
  MAX_DAILY_DIFF_ENTRIES,
  RENDER_MAX_TOKENS,
  HIGH_SALIENCE_MIN,
  DEFAULT_CONSTITUTION,
};
