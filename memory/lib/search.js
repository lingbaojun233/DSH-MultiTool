'use strict';

/**
 * 检索（search）：三路召回 → 统一打分 → 双预算打包 →（回忆型问句）二次精排。
 *
 * 设计约束（与需求一一对应）：
 *   1. 三路候选：FTS5(trigram) / 实体 / 时间窗，各取 top20，按 event.id 合并去重。
 *   2. 打分：total = relevance × salienceFactor × recencyDecay × confidence × novelty。
 *   3. 用 budget.pack 截断（单条 ≤120 token 由 pack 保证），返回 used / truncated。
 *   4. 无结果就返回 items: []，绝不编造；只有时间窗进来、与 query 毫无关系的近期事件也不充数。
 *   5. 只有 isRecallQuestion(query) 为真才对 top20 精排（实体名 +1.0、时间指代 +0.3），置 reranked=true。
 *   6. debug 带每条候选的分项分数，便于复盘"它为什么被排在这里"。
 *   7. 用户隔离：options.userId 为整数时，三路候选与装载都只取
 *      "该用户 + 共享（user_id IS NULL）"；为 null/缺省时不过滤，保持旧行为。
 *      items 里也带 user_id，方便调用方核对归属。
 *
 * 本文件是纯查询：不 INSERT/UPDATE/DELETE，不改表结构。唯一的可变状态是模块级
 * noveltySeen 表（最近 7 天被检索过的 event.id），只活在进程内存里，重启即清空。
 */

const { normalize, extractCues, isRecallQuestion } = require('./text.js');
const { pack, clampBudget } = require('./budget.js');

// ---------------------------------------------------------------------------
// 常量：全部写死，方便人工复算分数，避免"魔数到处漂"
// ---------------------------------------------------------------------------
const ROUTE_LIMIT = 20; // 每路候选上限（需求 1）
const RECENCY_SCALE_DAYS = 30; // recencyDecay = exp(-ageDays / 30)
const DEFAULT_WINDOW_DAYS = 30; // context 没给时间范围时，取最近 30 天
const FTS_MIN_CHARS = 3; // trigram 少于 3 个字符不生成 token，MATCH 永远空
const NOVELTY_WINDOW_MS = 7 * 86400000; // novelty 记忆窗口：7 天
const NOVELTY_FIRST = 1.0; // 首次被检索
const NOVELTY_REPEAT = 0.8; // 7 天内已经被检索过
const DAY_MS = 86400000;
const MAX_ENTITY_IDS = 40; // 实体路由一次最多展开多少个实体
const MAX_TERMS = 12; // 查询词上限，避免 LIKE / 打分时组合爆炸
const MAX_ENTITY_ROWSCAN = 100; // 单次实体 LIKE 粗筛的扫描上限
const MAX_TS_FALLBACK_DAYS = 365; // ts 解析失败时按"一年前"处理，recency 近似 0

// ---------------------------------------------------------------------------
// novelty：模块级 Map（event.id → 最近一次被检索/返回的时间戳）。
// 需求明确不许改表结构，所以"是否刚检索过"只能放内存：进程重启后视为全新，
// 这是可接受的降级——它只是排序信号，不是数据。
// ---------------------------------------------------------------------------
const noveltySeen = new Map();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 统一时间输入：Date / 毫秒 / 秒 / ISO 字符串 → 毫秒时间戳；无法解析返回 null。 */
function toMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 兼容秒级时间戳（10 位，约 1e9）与毫秒级（约 1.7e12）
    return value < 1e11 ? value * 1000 : value;
  }
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

/** 转义 LIKE 通配符：内容里出现 % _ \ 时不能当通配符用。 */
function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 数值裁剪到固定小数位；非有限值一律按 0 处理，保证 debug 里不出现 NaN。 */
function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

/** entities.aliases 存的是 JSON 数组文本；坏了就当没有，不抛错。 */
function parseAliases(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * user_id 归一化：null/undefined/空串 → null（不加过滤，兼容旧行为）；
 * 整数或纯数字字符串 → 整数；其余一律抛 TypeError。
 * 非法值不回落成 null：那样查询方以为自己在看私有记忆，实际看到了全库。
 */
function readUserId(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    throw new TypeError('search(db, options): userId 必须是整数或 null');
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^[+-]?\d+$/.test(text)) {
      const num = Number(text);
      if (Number.isSafeInteger(num)) return num;
    }
  }
  throw new TypeError('search(db, options): userId 必须是整数或 null');
}

/**
 * 可见性 SQL 片段：自己 + 共享（user_id IS NULL）。
 * 参数要追加在各自 SQL 的已有占位符之后，调用方负责 push(userId)。
 * @param {string} alias 事件表的别名（events / e）
 * @param {number|null} userId null 时不加过滤
 */
function userScopeSql(alias, userId) {
  if (userId == null) return '';
  return ` AND (${alias}.user_id = ? OR ${alias}.user_id IS NULL)`;
}

/**
 * 对话对象归一化：空/缺省 → null（不过滤）；其它 → 去空白、压到 60 字符。
 * 与 remember.js 的口径保持一致，否则"写进去的对象"和"检索时的对象"对不上。
 */
function readCounterpart(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, 60);
}

/**
 * 可见性 SQL 片段：这个对话对象的 + 通用的（counterpart IS NULL）。
 * 语义和 userScopeSql 一致 —— 通用记忆任何对话都能召回，专属记忆只回自己的对话。
 */
function counterpartScopeSql(alias, counterpart) {
  if (counterpart == null) return '';
  return ` AND (${alias}.counterpart IS NULL OR ${alias}.counterpart = ?)`;
}

/**
 * 查询词切分：整句 + 按标点/空白切出的词 + CJK 2-gram。
 * 为什么要 2-gram：中文里"小肥鱼今天过生日"和 query"小肥鱼生日"不会连续出现，
 * 整串 LIKE（以及 trigram 短语）都会漏，拆成双字后按命中比例打分才抓得住。
 */
function queryTerms(query) {
  const text = normalize(query).text;
  if (!text) return [];

  const terms = new Set();
  const compact = text.replace(/\s+/g, '');
  if (compact.length >= 2) terms.add(compact); // 整句优先：整句命中比拆词命中更可信

  for (const word of text.split(/[^\p{L}\p{N}_-]+/u)) {
    if (word.length >= 2) terms.add(word);
  }

  for (const run of text.match(/[\u3400-\u9fff]{3,}/g) || []) {
    for (let i = 0; i + 2 <= run.length && terms.size < MAX_TERMS * 2; i += 1) {
      terms.add(run.slice(i, i + 2));
    }
  }

  return [...terms].slice(0, MAX_TERMS);
}

/**
 * 解析 context 里的时间范围。
 * 兼容写法：context.timeRange/range/window/{start,end} 或 context.since/until/from/to…
 * 只给一端时按默认 30 天补齐；两端口径写反了就交换，不让调用方的疏忽变成空结果。
 */
function readRange(context, nowMs) {
  const ctx = context && typeof context === 'object' ? context : {};
  const nested =
    [ctx.timeRange, ctx.range, ctx.window, ctx.time_window, ctx.time].find(
      (value) => value && typeof value === 'object',
    ) || null;

  const pick = (keys) => {
    for (const source of [nested, ctx]) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const ms = toMs(source[key]);
        if (ms != null) return ms;
      }
    }
    return null;
  };

  const since = pick(['since', 'from', 'start', 'after', 'begin', 'startTs', 'fromTs', 'startTime', 'fromTime', 'afterTs', 'minTs']);
  const until = pick(['until', 'to', 'end', 'before', 'endTs', 'toTs', 'endTime', 'toTime', 'beforeTs', 'maxTs']);

  const fallbackSince = nowMs - DEFAULT_WINDOW_DAYS * DAY_MS;
  if (since == null && until == null) {
    return { sinceMs: fallbackSince, untilMs: nowMs };
  }

  let lo = since != null ? since : until - DEFAULT_WINDOW_DAYS * DAY_MS;
  let hi = until != null ? until : nowMs;
  if (lo > hi) [lo, hi] = [hi, lo]; // 容错：范围写反照样能查
  return { sinceMs: lo, untilMs: hi };
}

// ---------------------------------------------------------------------------
// 三路候选（每路 LIMIT 20；SQL 里一律过滤 events.deleted = 0）
// ---------------------------------------------------------------------------

/**
 * a) FTS5 全文：query 用双引号包成短语查询。
 * trigram 分词对 <3 字符的查询不生成 token，这时改用 content LIKE 兜底。
 * FTS 出错（语法/分词异常）也不让整个检索崩掉，同样落回 LIKE。
 * 两路都带 user_id 可见性过滤（userId 为 null 时不加）。
 */
function ftsCandidates(db, query, userId, counterpart) {
  const raw = String(query).trim();
  if (!raw) return [];

  // 多词查询按空格切，单词查询整体当一个词；少于 2 字符的词没有检索价值
  const parts = raw.split(/\s+/).filter(Boolean);
  const terms = [...new Set((parts.length > 1 ? parts : [raw.replace(/\s+/g, '')]).filter((t) => t.length >= 2))];
  if (!terms.length) return [];

  // FTS 用 OR 连接各词：短语查询会把 "项目 部署" 当成连续子串，命中率极低
  const ftsTerms = terms.filter((t) => t.length >= FTS_MIN_CHARS);
  if (ftsTerms.length) {
    try {
      const match = ftsTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      // 参数顺序：MATCH 的短语串在前，user_id 在最后
      const params = [match];
      if (userId != null) params.push(userId);
      if (counterpart != null) params.push(counterpart);
      const rows = db
        .prepare(
          `SELECT events_fts.rowid AS id
             FROM events_fts
             JOIN events ON events.id = events_fts.rowid
            WHERE events_fts MATCH ? AND events.deleted = 0${userScopeSql('events', userId)}${counterpartScopeSql('events', counterpart)}
            LIMIT ${ROUTE_LIMIT}`,
        )
        .all(...params);
      return rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
    } catch {
      /* 落回 LIKE 兜底 */
    }
  }

  // LIKE 兜底：任一词命中即可（OR），避免把 "项目 部署" 拼成不存在的长串
  const where = terms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ');
  const params = terms.map((t) => `%${escapeLike(t)}%`);
  if (userId != null) params.push(userId); // 追加在词参数之后，占位符顺序一致
  if (counterpart != null) params.push(counterpart);
  const rows = db
    .prepare(
      `SELECT id
         FROM events
        WHERE deleted = 0 AND (${where})${userScopeSql('events', userId)}${counterpartScopeSql('events', counterpart)}
        ORDER BY ts DESC
        LIMIT ${ROUTE_LIMIT}`,
    )
    .all(...params);
  return rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}

/**
 * b) 实体命中：entities.name 或 aliases 包含查询词，且该实体出现在 event_entities 中。
 * LIKE 只做粗筛——aliases 是 JSON 文本，还要逐项确认，避免被 JSON 的括号/逗号误命中。
 * 实体表本身不分用户（人名/群名共享），但只召回当前用户可见的事件。
 */
function entityCandidates(db, terms, userId, counterpart) {
  if (!terms.length) return [];

  const entityIds = new Set();
  for (const term of terms) {
    if (entityIds.size >= MAX_ENTITY_IDS) break;
    const pattern = `%${escapeLike(term)}%`;
    const rows = db
      .prepare(
        `SELECT id, name, aliases
           FROM entities
          WHERE name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\'
          LIMIT ${MAX_ENTITY_ROWSCAN}`,
      )
      .all(pattern, pattern);

    const needle = term.toLowerCase();
    for (const row of rows) {
      const names = [row.name, ...parseAliases(row.aliases)];
      if (names.some((name) => String(name || '').toLowerCase().includes(needle))) {
        entityIds.add(Number(row.id));
      }
    }
  }

  if (!entityIds.size) return [];

  const ids = [...entityIds].slice(0, MAX_ENTITY_IDS);
  const placeholders = ids.map(() => '?').join(',');
  // 参数顺序：先实体 id 列表，再 user_id
  const params = [...ids];
  if (userId != null) params.push(userId);
  if (counterpart != null) params.push(counterpart);
  // 一个实体可能挂很多事件，按最近优先取 20 条；GROUP BY 去掉同事件的多角色重复行
  const rows = db
    .prepare(
      `SELECT ee.event_id AS id, MAX(e.ts) AS last_ts
         FROM event_entities ee
         JOIN events e ON e.id = ee.event_id
        WHERE ee.entity_id IN (${placeholders}) AND e.deleted = 0${userScopeSql('e', userId)}${counterpartScopeSql('e', counterpart)}
        GROUP BY ee.event_id
        ORDER BY last_ts DESC
        LIMIT ${ROUTE_LIMIT}`,
    )
    .all(...params);
  return rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}

/**
 * c) 时间窗：context 给了范围就用范围，否则最近 30 天。
 * 它提供的是"候选池"而不是答案：这些事件是否有相关性，由打分阶段按 query 词命中决定。
 */
function windowCandidates(db, range, userId, counterpart) {
  // 参数顺序：since、until，然后 user_id、counterpart
  const params = [new Date(range.sinceMs).toISOString(), new Date(range.untilMs).toISOString()];
  if (userId != null) params.push(userId);
  if (counterpart != null) params.push(counterpart);
  const rows = db
    .prepare(
      `SELECT id
         FROM events
        WHERE deleted = 0 AND ts >= ? AND ts <= ?${userScopeSql('events', userId)}${counterpartScopeSql('events', counterpart)}
        ORDER BY ts DESC
        LIMIT ${ROUTE_LIMIT}`,
    )
    .all(...params);
  return rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}

// ---------------------------------------------------------------------------
// 候选装载：事件行 + 关联实体名（实体名参与 likeRatio，也供精排用）
// ---------------------------------------------------------------------------

/**
 * 装载事件行：候选已经在各自 SQL 里按 user_id 过滤过，这里再兜一次底，
 * 防止以后新增候选路由时漏了过滤而把别人的事件带出来。
 */
function loadEvents(db, ids, userId) {
  const byId = new Map();
  if (!ids.length) return byId;
  const placeholders = ids.map(() => '?').join(',');
  // 参数顺序：id 列表，然后 user_id
  const params = [...ids];
  if (userId != null) params.push(userId);
  const rows = db
    .prepare(
      `SELECT id, ts, channel, group_id, speaker_id, speaker_name, kind,
              content, evidence, confidence, salience, user_id, counterpart
         FROM events
        WHERE id IN (${placeholders}) AND deleted = 0${userScopeSql('events', userId)}`,
    )
    .all(...params);
  for (const row of rows) byId.set(Number(row.id), row);
  return byId;
}

function loadEntityNames(db, ids) {
  const byEvent = new Map();
  if (!ids.length) return byEvent;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ee.event_id AS event_id, en.name AS name, en.aliases AS aliases
         FROM event_entities ee
         JOIN entities en ON en.id = ee.entity_id
        WHERE ee.event_id IN (${placeholders})`,
    )
    .all(...ids);

  for (const row of rows) {
    const eventId = Number(row.event_id);
    const names = byEvent.get(eventId) || [];
    names.push(String(row.name || ''));
    for (const alias of parseAliases(row.aliases)) names.push(alias);
    byEvent.set(eventId, names);
  }
  return byEvent;
}

// ---------------------------------------------------------------------------
// 打分：relevance × salienceFactor × recencyDecay × confidence × novelty
// ---------------------------------------------------------------------------

/** novelty：7 天内被检索过 → 0.8，否则 1.0（首次）。 */
function noveltyOf(id, nowMs) {
  const seenAt = noveltySeen.get(id);
  if (seenAt != null && nowMs - seenAt <= NOVELTY_WINDOW_MS) return NOVELTY_REPEAT;
  return NOVELTY_FIRST;
}

/**
 * @param {object} input {row, ftsHit, terms, haystack, nowMs, novelty}
 * @returns {object} 分项分数 + total
 */
function scoreCandidate({ row, ftsHit, terms, haystack, nowMs, novelty }) {
  // relevance：FTS 命中给 0.7 基底，再叠加 LIKE 命中比例（0~0.3）
  const matched = terms.reduce(
    (count, term) => (haystack.includes(term.toLowerCase()) ? count + 1 : count),
    0,
  );
  const likeRatio = terms.length ? matched / terms.length : 0;
  const relevance = Math.min(1, (ftsHit ? 0.7 : 0) + 0.3 * likeRatio);

  // salienceFactor = 0.5 + salience/200：显著性 0 仍有 0.5，100 给满 1.0，避免把分数压死
  const rawSalience = Number(row.salience);
  const salience = Number.isFinite(rawSalience) ? rawSalience : 50;
  const salienceFactor = 0.5 + salience / 200;

  // recencyDecay = exp(-ageDays/30)：30 天衰减到约 0.37，超过一年近似 0
  const tsMs = Date.parse(String(row.ts));
  const ageDays = Number.isNaN(tsMs) ? MAX_TS_FALLBACK_DAYS : Math.max(0, (nowMs - tsMs) / DAY_MS);
  const recencyDecay = Math.exp(-ageDays / RECENCY_SCALE_DAYS);

  // confidence 直接取库里的值（schema 默认 0.8），越界时夹到 0..1
  const rawConfidence = Number(row.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0.8;

  const total = relevance * salienceFactor * recencyDecay * confidence * novelty;

  return { relevance, likeRatio, salience, salienceFactor, recencyDecay, confidence, novelty, total, tsMs };
}

/** 排序：分数降序 → 时间降序 → id 升序（最后一级只为让结果稳定可复现）。 */
function compareRank(a, b) {
  return b.total - a.total || b.tsMs - a.tsMs || a.id - b.id;
}

// ---------------------------------------------------------------------------
// 二次精排（只在回忆型问句上启用，只作用于 top20）
// ---------------------------------------------------------------------------

/** 用本地日历算"第几天"，跨时区/跨日边界判断时间指代时比 ageDays 更准。 */
function dayIndex(ms) {
  const date = new Date(ms);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** 本地日历月序号，用于"上个月"。 */
function monthIndex(ms) {
  const date = new Date(ms);
  return date.getFullYear() * 12 + date.getMonth();
}

/**
 * 时间指代是否命中该事件：命中的语义是"这条事件就落在 query 说的那段时间里"。
 * 笼统的过去指代（之前/以前/上次/当时/那会儿/后来）只要求早于一天，不做过度推断。
 */
function timeCueHit(cues, tsMs, nowMs) {
  if (!Number.isFinite(tsMs)) return false;
  const diffDays = dayIndex(nowMs) - dayIndex(tsMs); // 正数=过去，负数=未来
  const ageMs = nowMs - tsMs;

  for (const cue of cues) {
    switch (cue) {
      case '今天':
        if (diffDays === 0) return true;
        break;
      case '昨天':
        if (diffDays === 1) return true;
        break;
      case '前天':
        if (diffDays === 2) return true;
        break;
      case '明天':
        if (diffDays === -1) return true;
        break;
      case '刚才':
        if (ageMs >= 0 && ageMs <= 60 * 60 * 1000) return true;
        break;
      case '上周':
        if (diffDays >= 7 && diffDays < 14) return true;
        break;
      case '下周':
        if (diffDays <= -7 && diffDays > -14) return true;
        break;
      case '上个月':
        if (monthIndex(nowMs) - monthIndex(tsMs) === 1) return true;
        break;
      case '去年':
        if (new Date(nowMs).getFullYear() - new Date(tsMs).getFullYear() === 1) return true;
        break;
      case '今年':
        if (new Date(nowMs).getFullYear() === new Date(tsMs).getFullYear()) return true;
        break;
      case '之前':
      case '以前':
      case '上次':
      case '当时':
      case '那会儿':
      case '后来':
        if (ageMs > DAY_MS) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/** 实体名是否"精确出现在 query 里"：中文按子串，拉丁名要求词边界，避免 ds 命中 dsh。 */
function entityNameInQuery(queryText, name) {
  const query = String(queryText || '').toLowerCase();
  const entity = String(name || '').toLowerCase().trim();
  if (!entity || entity.length < 2) return false;
  if (!query.includes(entity)) return false;
  if (/^[a-z0-9_\- ]+$/.test(entity)) {
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(String(queryText || ''));
  }
  return true;
}

/**
 * 对 top20 叠加额外分并重排：
 *   +1.0 query 里精确出现了该事件关联实体的名字（或别名）
 *   +0.3 query 的时间指代命中该事件时间
 * 注意：只动前 20 条，20 名之后的候选保持原序，避免精排把弱候选意外顶上来。
 */
function applyRerank({ ranked, queryText, cues, nowMs, entityNamesById }) {
  const head = ranked.slice(0, ROUTE_LIMIT);
  const tail = ranked.slice(ROUTE_LIMIT);

  for (const candidate of head) {
    const names = entityNamesById.get(candidate.id) || [];
    const entityBonus = names.some((name) => entityNameInQuery(queryText, name)) ? 1.0 : 0;
    const timeBonus = cues.times.length && timeCueHit(cues.times, candidate.tsMs, nowMs) ? 0.3 : 0;
    candidate.rerankBonus = entityBonus + timeBonus;
    candidate.total += candidate.rerankBonus;
  }

  head.sort(compareRank);
  return head.concat(tail);
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/** 统一构造返回值，保证空结果与正常结果的字段形状完全一致（调用方不用判空分支）。 */
function emptyResult(query, budget, reranked) {
  return {
    items: [],
    used: { count: 0, tokens: 0 },
    budget,
    truncated: false,
    query,
    reranked,
    candidates: 0,
    debug: [],
  };
}

/**
 * 检索记忆事件。
 *
 * @param {import('node:sqlite').DatabaseSync} db open() 返回的连接（只读使用）
 * @param {object} [options]
 * @param {string} [options.query]    检索词/问句
 * @param {object} [options.context]  可选时间范围：{since, until} / {timeRange:{start,end}} 等
 * @param {object} [options.budget]   {maxItems, maxTokens}，最终由 budget.clampBudget 夹住
 * @param {number|null} [options.userId] 归属用户：整数 → 只看"自己 + 共享(user_id IS NULL)"；
 *                                   null/缺省 → 不过滤（兼容旧行为）。非法值抛 TypeError。
 * @param {number|string|Date} [options.now] 参考"现在"（便于测试回放历史时间）
 * @returns {object} {items, used, budget, truncated, query, reranked, candidates, debug}
 */
function search(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('search(db, options): db 必须是 open() 返回的 DatabaseSync');
  }

  const userId = readUserId(options.userId);
  // 对话对象：null = 不按对象过滤（面板这类没有具体对象的场景）
  const counterpart = readCounterpart(options.counterpart);
  const rawQuery = typeof options.query === 'string' ? options.query : String(options.query == null ? '' : options.query);
  const nowMs = toMs(options.now) ?? Date.now();
  const normalizedQuery = normalize(rawQuery).text;
  const cues = extractCues(normalizedQuery);
  const recallQuestion = isRecallQuestion(normalizedQuery);
  const budget = clampBudget(options.budget);

  // 清掉超过 7 天的 novelty 记录：窗口外的"检索过"不再影响分数，也避免 Map 无限增长
  for (const [id, seenAt] of noveltySeen) {
    if (!(nowMs - seenAt <= NOVELTY_WINDOW_MS)) noveltySeen.delete(id);
  }

  // 空查询 = 没有检索意图，直接空结果（不拿时间窗里的近期事件凑数）
  if (!normalizedQuery) return emptyResult(rawQuery, budget, false);

  const terms = queryTerms(normalizedQuery);
  const range = readRange(options.context, nowMs);

  // ---- 1) 三路候选：按 event.id 合并去重，只保留"哪几路命中"的标记 -------------
  const pool = new Map();
  const addRoute = (ids, route) => {
    for (const id of ids) {
      if (!Number.isFinite(id)) continue;
      const entry = pool.get(id) || { id, ftsHit: false };
      if (route === 'fts') entry.ftsHit = true;
      pool.set(id, entry);
    }
  };

  addRoute(ftsCandidates(db, normalizedQuery, userId, counterpart), 'fts');
  addRoute(entityCandidates(db, terms, userId, counterpart), 'entity');
  addRoute(windowCandidates(db, range, userId, counterpart), 'window');

  if (!pool.size) return emptyResult(rawQuery, budget, recallQuestion);

  // ---- 2) 装载事件行与关联实体名（deleted / user_id 在这里再兜一次底） ----------
  const rowsById = loadEvents(db, [...pool.keys()], userId);
  const entityNamesById = loadEntityNames(db, [...rowsById.keys()]);

  const scored = [];
  for (const [id, entry] of pool) {
    const row = rowsById.get(id);
    if (!row) continue; // 已被软删或不存在：直接丢弃，绝不返回

    // likeRatio 的比对文本 = 正文 + 关联实体名/别名：
    // 实体命中说明"这条事件是关于该实体的"，它的名字算作这条事件的可检索文本。
    const names = entityNamesById.get(id) || [];
    const haystack = `${String(row.content || '')} ${names.join(' ')}`.toLowerCase();

    const score = scoreCandidate({
      row,
      ftsHit: entry.ftsHit,
      terms,
      haystack,
      nowMs,
      novelty: noveltyOf(id, nowMs),
    });

    // 只靠时间窗进来、和 query 一个词都对不上（relevance=0）的候选不是检索结果，剔除。
    // 这条也保证了"没有命中就返回空数组"，而不是拿最近 20 条事件糊弄调用方。
    if (score.relevance <= 0) continue;

    scored.push({ id, ftsHit: entry.ftsHit, row, ...score });
  }

  if (!scored.length) return emptyResult(rawQuery, budget, recallQuestion);

  // ---- 3) 排序；回忆型问句再对 top20 精排 ---------------------------------------
  scored.sort(compareRank);
  const ranked = recallQuestion
    ? applyRerank({ ranked: scored, queryText: normalizedQuery, cues, nowMs, entityNamesById })
    : scored;

  // ---- 4) 双预算打包（pack 负责单条 ≤120 token，以及 used/truncated） -----------
  const packed = pack(
    ranked.map((candidate) => ({
      id: candidate.id,
      ts: candidate.row.ts,
      channel: candidate.row.channel,
      group_id: candidate.row.group_id,
      speaker_id: candidate.row.speaker_id,
      speaker_name: candidate.row.speaker_name,
      kind: candidate.row.kind,
      content: candidate.row.content, // pack 的 textOf 用它，打包后替换为截断后的 text
      evidence: candidate.row.evidence,
      user_id: candidate.row.user_id == null ? null : Number(candidate.row.user_id),
      score: round(candidate.total, 4),
      confidence: round(candidate.confidence, 4),
      salience: candidate.salience,
    })),
    options.budget,
    (item) => item.content,
  );

  // 去掉临时的 content 字段：对外只给预算内截断后的 text，避免把全文重复返回一遍
  const items = packed.items.map(({ content, ...rest }) => rest);

  // 记录"这次真的返回给调用方"的 id，7 天内的下一次检索 novelty 降为 0.8
  for (const item of items) noveltySeen.set(item.id, nowMs);

  // ---- 5) debug：每条候选的分项明细，便于复算/复盘 -----------------------------
  const debug = ranked.map((candidate) => ({
    id: candidate.id,
    ftsHit: candidate.ftsHit,
    likeRatio: round(candidate.likeRatio, 4),
    salience: candidate.salience,
    recency: round(candidate.recencyDecay, 6),
    confidence: round(candidate.confidence, 4),
    novelty: candidate.novelty,
    total: round(candidate.total, 6),
  }));

  return {
    items,
    used: packed.used,
    budget: packed.budget,
    truncated: packed.truncated,
    query: rawQuery,
    reranked: recallQuestion,
    candidates: ranked.length,
    debug,
  };
}

module.exports = { search };
