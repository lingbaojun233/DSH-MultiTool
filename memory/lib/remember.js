'use strict';

/**
 * 写入管线 remember()：一条外部消息 →（门槛 → 去重 → 链接 → 事实 → 显著性）→ 落库。
 *
 * 分层设计（每层都能单独测）：
 *   1. 证据门槛  没有 evidence 一律拒收（记忆必须可回查）
 *   2. 归一化    normalize() 之后的文本用于哈希/去重/抽取，原文进 raw_content
 *   3. 价值门槛  闲聊 / 不改未来行为的内容不写库
 *   4. 精确去重  content_hash 命中未删行 → duplicate
 *   5. 近似去重  同群同人 7 天内、字符二元组 Jaccard ≥ 0.8 → merged（只加计数）
 *   6. 实体链接  input.entities + extractCues 线索 + 说话人
 *   7. 事实抽取  规则、保守；同 subject+predicate 不同 object → conflict
 *   8. 显著性    0~100
 *   9. 写 events + 手工维护 events_fts
 *  10. 返回结构化结果
 *
 * 事务：第 6~10 步在一个 BEGIN/COMMIT 里，任一步失败 ROLLBACK，返回 reason='error'。
 *
 * 约定：
 *   * 纯 CommonJS，零外部依赖，只用 node:sqlite 的同步 API。
 *   * events.channel 只接受 chat/video/doc/system，kind 只接受 msg/video/action/commitment；
 *     非法值分别回落到 chat / msg（宽松，避免丢数据）。
 *   * 所有时间统一成 ISO8601 UTC 字符串，便于 ts 字典序比较。
 */

const { normalize, contentHash, isChitchat, isWorthRemembering, extractCues } = require('./text.js');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const KINDS = new Set(['msg', 'video', 'action', 'commitment']);
const CHANNELS = new Set(['chat', 'video', 'doc', 'system']);
const ENTITY_TYPES = new Set(['person', 'group', 'topic']);
const ROLES = new Set(['mention', 'speaker', 'subject', 'object', 'place']);

const NEAR_DUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 近似去重窗口：7 天
const NEAR_DUP_THRESHOLD = 0.8; // 字符二元组 Jaccard 阈值
const NEAR_DUP_SCAN_LIMIT = 200; // 单次最多比较的候选行数
const MAX_FACTS_PER_EVENT = 5; // 一条事件最多抽 5 条事实
const MAX_ENTITY_NAME = 40; // 实体名长度上限（超过视为噪声）
const MAX_CLAUSE_LENGTH = 60; // 超过这个长度的子句不做事实抽取（多半是长句/复句）

// 证据定位格式：'chat:g1#m2' / 'video:call1#t35' / 'doc:spec.md#L10'
const EVIDENCE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*:[^\s:#]+#[^\s#]+$/;

// 第一人称主语：有说话人身份时替换成规范人名，否则这条事实跳过
const FIRST_PERSON = new Set(['我', '俺', '本人', '咱', '我们', '咱们']);

// 事实抽取时过滤掉的"假主语"：指示代词与纯时间词
const SUBJECT_STOP = new Set([
  '这', '那', '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里', '这儿', '那儿',
  '今天', '昨天', '明天', '现在', '刚才', '之前', '以后', '后来', '当时', '刚刚',
]);
// 疑问词做宾语说明这句是提问而不是断言
const OBJECT_STOP = new Set(['谁', '什么', '啥', '哪里', '哪儿', '多少', '几', '怎么', '怎样', '如何', '为什么']);

// 句首连接词/语气词：抽事实前剥掉，避免它们混进主语
const FILLER_PREFIX = /^(?:对了|然后|另外|顺便|说起来|其实|所以|但是|不过|而且|还有|就是|那个|这样|嗯+|呃+|诶+|啊+|哦+|额+|总之|话说|同时|以及|再说)+/u;

// 子句切分：中文标点为主，保留空格（空格在主语/宾语里不合法，正好自然过滤）
const CLAUSE_SPLITTER = /[，,。.！!？?；;、\n\r]+/;

// 主语句柄：允许中英文、数字、下划线、@、-（QQ 号/昵称都能进来）。
// 必须用非贪婪：否则 "小肥住在上海" 里的 "住" 会被吞进主语（变成 小肥住 + 在）。
const SUBJ = '([\\u4e00-\\u9fffA-Za-z0-9_@\\-]{1,20}?)';
// 宾语：不含标点与空白
const OBJ = '([^\\s，。！？；、]{1,30})';

/**
 * 事实规则（保守：一条子句最多产出一条事实，按顺序取第一条命中的规则）。
 *   "X 的 Y 是 Z" → subject=X, predicate=Y, object=Z（predicate 直接记属性名）
 *   "X 叫 Y"      → predicate='called'
 *   "X 在 Y"      → predicate='located_at'
 *   "X 是 Y"      → predicate='is'
 */
const FACT_RULES = [
  {
    re: new RegExp(`^${SUBJ}的([\\u4e00-\\u9fffA-Za-z_]{1,12})(?:是|为)${OBJ}$`),
    map: (m) => ({ subject: m[1], predicate: m[2], object: m[3] }),
  },
  {
    re: new RegExp(`^${SUBJ}(?:叫做|叫|名叫|名字是)${OBJ}$`),
    map: (m) => ({ subject: m[1], predicate: 'called', object: m[2] }),
  },
  {
    // 末尾允许带 工作/上班/读书/上学/生活，避免把动词吞进地点里
    re: new RegExp(`^${SUBJ}(住在|工作在|位于|在)([^\\s，。！？；、]{1,28}?)(?:工作|上班|读书|上学|生活)?$`),
    map: (m) => ({ subject: m[1], predicate: 'located_at', object: m[3] }),
  },
  {
    re: new RegExp(`^${SUBJ}是${OBJ}$`),
    map: (m) => ({ subject: m[1], predicate: 'is', object: m[2] }),
  },
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把任意输入转成 ISO8601 UTC 字符串；解析不了就用 now。 */
function toIso(value, now) {
  if (value == null || value === '') return now.toISOString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? now.toISOString() : value.toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? now.toISOString() : new Date(parsed).toISOString();
}

/** confidence 夹到 0..1；非数字用默认值。 */
function clamp01(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

/** id 类字段：空白字符串按 null 处理。 */
function normId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/** 证据门槛：既不能缺，格式也要能定位（source:scope#locator）。 */
function hasValidEvidence(evidence) {
  return typeof evidence === 'string' && EVIDENCE_PATTERN.test(evidence.trim());
}

/** 字符二元组集合（单字符文本退化成单元素集合）。 */
function bigrams(text) {
  const value = String(text || '');
  const set = new Set();
  if (value.length < 2) {
    if (value.length === 1) set.add(value);
    return set;
  }
  for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
  return set;
}

/** 两个二元组集合的 Jaccard 相似度（0..1；空集视为不相似）。 */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** JSON 数组字段安全解析，坏值一律当空数组。 */
function parseJsonArray(raw) {
  if (raw == null) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item) : [];
  } catch {
    return [];
  }
}

/**
 * 事务包装：正常路径用 BEGIN/COMMIT；若调用方已经在事务里，退化成 SAVEPOINT
 * （SQLite 不支持嵌套 BEGIN，直接 BEGIN 会抛 "cannot start a transaction within a transaction"）。
 * 失败一律回滚并向上抛，由 remember 转成 {stored:false, reason:'error'}。
 */
function inTransaction(db, fn) {
  const nested = db.isTransaction === true;
  if (!nested) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败（连接已断）时保留原始错误 */
      }
      throw err;
    }
  }

  const savepoint = `sp_remember_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
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
// 第 6 步：实体链接
// ---------------------------------------------------------------------------

/**
 * 生成"实体计划"（纯函数，不碰数据库）：
 *   说话人 → person（role=speaker）
 *   input.entities → 按给定 type，默认 mention
 *   extractCues 的 mentions / ids / latins → 默认 type=topic（按需求约定）
 * 同 (type,name) 的多条输入在这里先合并 aliases 与 role。
 */
function planEntities(input, cues, speaker) {
  const plan = new Map(); // key: `${type}\u0000${name}`

  const add = (type, rawName, aliases, role) => {
    const name = normalize(rawName).text.trim();
    if (!name || name.length > MAX_ENTITY_NAME) return;
    const kind = ENTITY_TYPES.has(type) ? type : 'topic';
    const roleName = ROLES.has(role) ? role : 'mention';
    const key = `${kind}\u0000${name}`;
    let item = plan.get(key);
    if (!item) {
      item = { type: kind, name, aliases: new Set(), roles: new Set() };
      plan.set(key, item);
    }
    for (const alias of aliases || []) {
      const value = normalize(alias).text.trim();
      if (value && value !== name && value.length <= MAX_ENTITY_NAME) item.aliases.add(value);
    }
    item.roles.add(roleName);
  };

  // 说话人：名字优先，没有就用 id 当规范名，id 进别名（方便按 QQ 号回查）
  if (speaker.id) {
    add('person', speaker.name || speaker.id, speaker.name && speaker.name !== speaker.id ? [speaker.id] : [], 'speaker');
  }

  // 调用方显式给的实体
  const provided = Array.isArray(input.entities) ? input.entities : [];
  for (const entity of provided) {
    if (!entity || typeof entity !== 'object') continue;
    const aliases = Array.isArray(entity.aliases)
      ? entity.aliases
      : typeof entity.aliases === 'string'
        ? [entity.aliases]
        : [];
    add(entity.type, entity.name, aliases, 'mention');
  }

  // 规则线索（默认 topic：@提及、长数字 id、英文标识符）
  for (const mention of cues.mentions || []) add('topic', mention, [], 'mention');
  for (const id of cues.ids || []) add('topic', id, [], 'mention');
  for (const latin of cues.latins || []) add('topic', latin, [], 'mention');

  return [...plan.values()];
}

/** 把 aliases 集合合并进已有 JSON 数组（并集、去重、不含规范名本身）。 */
function mergeAliases(existing, incoming, canonical) {
  const merged = new Set(existing);
  let changed = false;
  for (const alias of incoming) {
    if (alias === canonical || merged.has(alias)) continue;
    merged.add(alias);
    changed = true;
  }
  return { aliases: [...merged], changed };
}

/**
 * 落库实体（第 6 步）：先按 UNIQUE(type,name) 查，存在则合并 aliases，
 * 不存在则插入；然后写 event_entities（同一事件同实体可有多角色）。
 * 返回实体规范名数组（去重、保持出现顺序）。
 */
function linkEntities(db, eventId, plan, nowIso) {
  const findEntity = db.prepare('SELECT id, aliases FROM entities WHERE type = ? AND name = ?');
  const insertEntity = db.prepare(
    'INSERT INTO entities (type, name, aliases, note, created_at) VALUES (?, ?, ?, NULL, ?)',
  );
  const updateAliases = db.prepare('UPDATE entities SET aliases = ? WHERE id = ?');
  const linkEvent = db.prepare(
    'INSERT OR IGNORE INTO event_entities (event_id, entity_id, role) VALUES (?, ?, ?)',
  );

  const names = [];
  for (const item of plan) {
    const existing = findEntity.get(item.type, item.name);
    let entityId;
    if (existing) {
      entityId = Number(existing.id);
      const merged = mergeAliases(parseJsonArray(existing.aliases), item.aliases, item.name);
      if (merged.changed) updateAliases.run(JSON.stringify(merged.aliases), entityId);
    } else {
      const aliases = [...item.aliases].filter((alias) => alias !== item.name);
      const info = insertEntity.run(
        item.type,
        item.name,
        aliases.length ? JSON.stringify(aliases) : null,
        nowIso,
      );
      entityId = Number(info.lastInsertRowid);
    }
    for (const role of item.roles) linkEvent.run(eventId, entityId, role);
    if (!names.includes(item.name)) names.push(item.name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 第 7 步：事实抽取（规则、保守）
// ---------------------------------------------------------------------------

/** 剥掉句首连接词/语气词（最多剥 3 层，避免 "对了然后..." 这种叠用）。 */
function cleanClause(rawClause) {
  let clause = String(rawClause || '').trim();
  for (let round = 0; round < 3; round += 1) {
    const next = clause.replace(FILLER_PREFIX, '').trim();
    if (next === clause) break;
    clause = next;
  }
  return clause;
}

/**
 * 主语/宾语体检：
 *   - 空、同名、指示代词、纯时间词 → 不成立
 *   - 宾语是疑问词，或以 不/没/很/太… 开头（多为评价句）→ 不成立
 *   - 宾语以 的/了/吧/呢/啊/嘛 结尾（从句被截断或语气词）→ 不成立
 */
function isValidFact(subject, object) {
  if (!subject || !object) return false;
  if (subject === object) return false;
  if (SUBJECT_STOP.has(subject)) return false;
  if (OBJECT_STOP.has(object)) return false;
  if (/^(不|没|很|太|挺|非常|特别|真的|有点|比较|还|也)/.test(object)) return false;
  if (/[的了吧呢啊嘛]$/.test(object)) return false;
  return true;
}

/** 第一人称主语 → 说话人规范名；没有说话人身份时返回 null（该事实跳过）。 */
function resolveSubject(subject, speakerName) {
  if (!FIRST_PERSON.has(subject)) return subject;
  return speakerName || null;
}

/**
 * 从归一化文本里抽事实（不写库）。
 * 按子句切分，一条子句最多产出一条事实，总数上限 MAX_FACTS_PER_EVENT。
 */
function extractFacts(text, speakerName) {
  const facts = [];
  const seen = new Set();

  for (const rawClause of String(text || '').split(CLAUSE_SPLITTER)) {
    if (facts.length >= MAX_FACTS_PER_EVENT) break;
    const clause = cleanClause(rawClause);
    if (!clause || clause.length > MAX_CLAUSE_LENGTH) continue;
    if (/[吗呢嘛]$/.test(clause)) continue; // 问句不是断言

    for (const rule of FACT_RULES) {
      const match = clause.match(rule.re);
      if (!match) continue;
      const candidate = rule.map(match);
      const subject = resolveSubject(String(candidate.subject || '').trim(), speakerName);
      const object = String(candidate.object || '').trim();
      if (!subject) break; // 第一人称但不知道是谁：宁缺勿错
      if (!isValidFact(subject, object)) break;
      const key = `${subject}\u0000${candidate.predicate}\u0000${object}`;
      if (seen.has(key)) break;
      seen.add(key);
      facts.push({ subject, predicate: candidate.predicate, object });
      break; // 一条子句只取优先级最高的一条规则
    }
  }
  return facts;
}

/**
 * 写 facts（第 7 步）：
 *   - 同 subject+predicate 已有相同 object：support+1、last_seen 前移、追加证据事件 id，不新增行
 *   - 同 subject+predicate 已有不同 object：新事实 status='conflict'，旧行不动
 *   - 都没有：status='active'
 */
function persistFacts(db, facts, ctx) {
  const findSameSp = db.prepare(
    'SELECT id, object, status, support, evidence_event_ids FROM facts WHERE subject = ? AND predicate = ? AND deleted = 0',
  );
  const insertFact = db.prepare(
    'INSERT INTO facts (subject, predicate, object, confidence, evidence_event_ids, first_seen, last_seen, status, salience, support, deleted, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)',
  );
  const reinforceFact = db.prepare(
    'UPDATE facts SET support = support + 1, last_seen = ?, evidence_event_ids = ?, confidence = MAX(confidence, ?) WHERE id = ?',
  );

  const written = [];
  for (const fact of facts) {
    const rows = findSameSp.all(fact.subject, fact.predicate);
    const same = rows.find((row) => row.object === fact.object);

    if (same) {
      const evidence = parseJsonArray(same.evidence_event_ids);
      if (!evidence.includes(ctx.eventId)) evidence.push(ctx.eventId);
      reinforceFact.run(ctx.ts, JSON.stringify(evidence), ctx.confidence, Number(same.id));
      written.push({
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        status: same.status,
      });
      continue;
    }

    const status = rows.length ? 'conflict' : 'active';
    insertFact.run(
      fact.subject,
      fact.predicate,
      fact.object,
      ctx.confidence,
      JSON.stringify([ctx.eventId]),
      ctx.ts,
      ctx.ts,
      status,
      ctx.salience,
      ctx.nowIso,
    );
    written.push({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      status,
    });
  }
  return written;
}

// ---------------------------------------------------------------------------
// 第 8 步：显著性
// ---------------------------------------------------------------------------

/** 显著性 0~100：基础 40；commitment +25；抽到事实 +15；有情绪词 +10；长度 ≥30 +5。 */
function computeSalience({ kind, textLength, hasFact, emotions }) {
  let score = 40;
  if (kind === 'commitment') score += 25;
  if (hasFact) score += 15;
  if (emotions && emotions.length > 0) score += 10;
  if (textLength >= 30) score += 5;
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 写入一条记忆。
 *
 * @param {import('node:sqlite').DatabaseSync} db  open() 返回的连接（需已迁移）
 * @param {object} input
 * @param {string}  [input.ts]            发生时间（ISO），缺省/非法用当前时间
 * @param {string}  [input.channel]       chat/video/doc/system，默认 chat
 * @param {string}  [input.group_id]      群/会话 id
 * @param {string}  [input.speaker_id]    说话人稳定 id
 * @param {string}  [input.speaker_name]  说话人显示名
 * @param {string}  [input.kind]          msg/video/action/commitment，默认 msg
 * @param {string}  [input.content]       原文（必填，否则会落到 chitchat）
 * @param {string}   input.evidence       证据定位，必填，形如 'chat:g1#m2'
 * @param {number}  [input.confidence]    0..1，默认 0.8
 * @param {Array}   [input.entities]      [{type,name,aliases?}]
 * @returns {{stored:boolean, reason:string, eventId?:number, entities?:string[],
 *            facts?:Array<{subject:string,predicate:string,object:string,status:string}>,
 *            salience?:number, detail?:string}}
 */
function remember(db, input) {
  // ---- 0. 入参与连接校验 -------------------------------------------------
  if (!db || typeof db.prepare !== 'function') {
    return { stored: false, reason: 'error', detail: 'db 无效：需要 db/open.js 打开的 DatabaseSync 连接' };
  }
  const src = input && typeof input === 'object' ? input : {};
  const now = new Date();
  const nowIso = now.toISOString();

  // ---- 1. 证据门槛：没有证据直接拒收，什么都不写 --------------------------
  const evidence = typeof src.evidence === 'string' ? src.evidence.trim() : '';
  if (!hasValidEvidence(evidence)) {
    return {
      stored: false,
      reason: 'no_evidence',
      detail: evidence
        ? `evidence 格式应为 source:scope#locator（如 chat:g1#m2），收到 "${evidence}"`
        : '缺少 evidence：记忆必须可回查',
    };
  }

  // ---- 2. 归一化：后续一切（哈希/去重/抽取）都用归一化文本，原文单独留档 ----
  const rawContent = String(src.content == null ? '' : src.content);
  const normalized = normalize(rawContent);
  const text = normalized.text;

  // ---- 3. 价值门槛 -------------------------------------------------------
  const cues = extractCues(text);
  if (isChitchat(text)) {
    return { stored: false, reason: 'chitchat', detail: '太短或是纯语气词' };
  }
  if (!isWorthRemembering(text, cues)) {
    return { stored: false, reason: 'not_worth', detail: '不改未来行为、无事实线索，不值得长期记忆' };
  }

  // ---- 4. 精确去重：content_hash 命中未删行 -------------------------------
  const hash = contentHash(text);
  const duplicate = db
    .prepare('SELECT id FROM events WHERE content_hash = ? AND deleted = 0 LIMIT 1')
    .get(hash);
  if (duplicate) {
    return { stored: false, reason: 'duplicate', eventId: Number(duplicate.id) };
  }

  // ---- 5. 近似去重：同 group_id + 同 speaker_id，7 天内 Jaccard ≥ 0.8 -----
  const ts = toIso(src.ts, now);
  const tsMs = Date.parse(ts);
  const groupId = normId(src.group_id);
  const speakerId = normId(src.speaker_id);
  const speakerName = normId(src.speaker_name);

  // 两个 id 都缺 = 没有可比较的语境，不做近似合并（避免把无关的话并到一起）
  if (groupId !== null || speakerId !== null) {
    const from = new Date(tsMs - NEAR_DUP_WINDOW_MS).toISOString();
    const to = new Date(tsMs + NEAR_DUP_WINDOW_MS).toISOString();
    const candidates = db
      .prepare(
        `SELECT id, content, ts FROM events
          WHERE deleted = 0 AND group_id IS ? AND speaker_id IS ?
            AND ts >= ? AND ts <= ?
          ORDER BY ts DESC LIMIT ${NEAR_DUP_SCAN_LIMIT}`,
      )
      .all(groupId, speakerId, from, to);

    const grams = bigrams(text);
    let best = null;
    for (const row of candidates) {
      const similarity = jaccard(grams, bigrams(row.content));
      if (similarity >= NEAR_DUP_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { id: Number(row.id), similarity };
      }
    }
    if (best) {
      // 不新增行，只累加合并计数（schema 里 merged_into 属于新行，这里没有新行可挂）
      db.prepare('UPDATE events SET merge_count = merge_count + 1 WHERE id = ?').run(best.id);
      return {
        stored: false,
        reason: 'merged',
        eventId: best.id,
        detail: `近似重复：Jaccard=${best.similarity.toFixed(2)}，已并入事件 ${best.id}`,
      };
    }
  }

  // ---- 6/7/8 的"计划"阶段：只算不写，便于单测和失败前快速退出 ------------
  const kind = KINDS.has(src.kind) ? src.kind : 'msg';
  const channel = CHANNELS.has(String(src.channel || '')) ? String(src.channel) : 'chat';
  const confidence = clamp01(src.confidence, 0.8);

  const speaker = { id: speakerId, name: speakerName };
  const entityPlan = planEntities(src, cues, speaker);
  const factPlan = extractFacts(text, speakerName || speakerId);
  const salience = computeSalience({
    kind,
    textLength: text.length,
    hasFact: factPlan.length > 0,
    emotions: cues.emotions,
  });

  // ---- 6~10. 一个事务：事件 + FTS + 实体 + 事实 ---------------------------
  try {
    const outcome = inTransaction(db, () => {
      // 9a. 先写 events 拿到 id（实体关联与事实证据都要用到）
      const info = db
        .prepare(
          `INSERT INTO events
             (ts, channel, group_id, speaker_id, speaker_name, kind, content, raw_content,
              evidence, confidence, salience, content_hash, deleted, merged_into, merge_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?)`,
        )
        .run(
          ts,
          channel,
          groupId,
          speakerId,
          speakerName,
          kind,
          text,
          rawContent,
          evidence,
          confidence,
          salience,
          hash,
          nowIso,
        );
      const eventId = Number(info.lastInsertRowid);

      // 9b. FTS 手工维护：rowid 对齐 events.id，forget 时同步 DELETE
      db.prepare('INSERT INTO events_fts (rowid, content) VALUES (?, ?)').run(eventId, text);

      // 6. 实体链接
      const entityNames = linkEntities(db, eventId, entityPlan, nowIso);

      // 7. 事实抽取（conflict 判定在 persistFacts 里）
      const facts = persistFacts(db, factPlan, {
        eventId,
        ts,
        nowIso,
        confidence,
        salience,
      });

      return { eventId, entityNames, facts };
    });

    // ---- 10. 返回结构化结果 ----------------------------------------------
    return {
      stored: true,
      reason: 'stored',
      eventId: outcome.eventId,
      entities: outcome.entityNames,
      facts: outcome.facts,
      salience,
    };
  } catch (err) {
    // 事务已回滚：events / FTS / 实体 / 事实都不会留下半成品
    return {
      stored: false,
      reason: 'error',
      detail: err && err.message ? err.message : String(err),
    };
  }
}

module.exports = { remember };
