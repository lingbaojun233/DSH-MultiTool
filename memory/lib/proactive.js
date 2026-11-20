'use strict';

/**
 * 主动回忆（proactive recall）：在合适的时机递一句“回声”，让旧记忆重新进入对话。
 *
 * 设计要点：
 *   - 只产出“候选块”，绝不直接发送。是否开口由调用方决定（本模块不写库、不推送）。
 *   - 三道闸门：黑名单 → 频率闸 → 候选筛选；任一不通过都返回 allowed=false + 明确 reason。
 *   - 频率状态放在模块级 Map（按 sessionId 计数）：每 10 轮最多 1 次、每会话最多 2 次。
 *     拒绝时不消耗额度（只有真正产出了回声才记账）。
 *   - 候选条件：被 cues 命中 + 距今超过 30 天没被提起 + confidence ≥ 0.6。
 *   - 输出受双重上限约束：≤2 条、≤250 token，行格式 `[回声] 时间：内容（证据，置信）`。
 *   - suggestion 一定是疑问句（不以 ？/? 结尾时自动补成疑问句式），把“要不要开口”
 *     交回给调用方/人。
 */

const { estimateTokens, clipToTokens } = require('./budget.js');
const { toMs, clipChars } = require('./maintenance.js');

// ---- 策略参数 ----
const LOOKBACK_DAYS = 30; // 30 天内提过的不算“回声”，避免复读
const MIN_CONFIDENCE = 0.6; // 置信度低于此值不主动提，避免以讹传讹
const MAX_ITEMS = 2; // 回声块最多 2 条
const MAX_TOKENS = 250; // 回声块最多 250 token
const TURN_WINDOW = 10; // 每 10 轮最多主动 1 次
const SESSION_MAX = 2; // 每会话最多主动 2 次
const CONTENT_MAX_CHARS = 80; // 单条回声正文展示上限（超长截断）
const MIN_CUE_LENGTH = 2; // 太短的线索（单字）会命中一切，直接忽略
const ECHO_PREFIX = '[回声]';
const ELLIPSIS = '…';

// ---- 模块级内存状态（进程内有效；重启即清空，属于“宁可少说”的保守选择） ----
/** sessionId -> { count: 已主动次数, lastTurn: 上次主动的轮次 } */
const sessionState = new Map();
/** 黑名单关键词（小写，便于大小写不敏感匹配） */
const blacklist = new Set();

// ---------------------------------------------------------------------------
// 黑名单
// ---------------------------------------------------------------------------

function normalizeWord(word) {
  return String(word == null ? '' : word)
    .trim()
    .toLowerCase();
}

/** 把关键词加入黑名单：命中即拒绝主动回忆。 */
function addToBlacklist(word) {
  const value = normalizeWord(word);
  if (!value) return { ok: false, reason: 'empty_word' };
  blacklist.add(value);
  return { ok: true, word: value, size: blacklist.size };
}

function removeFromBlacklist(word) {
  const value = normalizeWord(word);
  const removed = blacklist.delete(value);
  return { ok: removed, word: value, size: blacklist.size };
}

function clearBlacklist() {
  blacklist.clear();
  return { ok: true, size: 0 };
}

function listBlacklist() {
  return [...blacklist];
}

// ---------------------------------------------------------------------------
// 频率闸
// ---------------------------------------------------------------------------

/** 清空频率状态：不传 sessionId 清全部；传则只清该会话（自测/重置用）。 */
function resetFrequency(sessionId) {
  if (sessionId == null) sessionState.clear();
  else sessionState.delete(String(sessionId));
  return { ok: true };
}

function stateOf(sessionId) {
  return sessionState.get(sessionId) || { count: 0, lastTurn: null };
}

/**
 * 频率判定：
 *   - 会话内已主动 2 次 → 拒绝（session_cap）
 *   - 距上次主动不足 10 轮 → 拒绝（turn_window）
 * 注意：turn 从 1 开始计数时，“第 1 轮主动一次”之后下一次要等到第 11 轮。
 */
function checkFrequency(sessionId, turn) {
  const state = stateOf(sessionId);
  if (state.count >= SESSION_MAX) {
    return { ok: false, detail: `session_cap（本会话已主动 ${state.count} 次，上限 ${SESSION_MAX}）`, state };
  }
  if (state.lastTurn != null && turn - state.lastTurn < TURN_WINDOW) {
    return {
      ok: false,
      detail: `turn_window（距上次主动仅 ${turn - state.lastTurn} 轮，需 ≥ ${TURN_WINDOW} 轮）`,
      state,
    };
  }
  return { ok: true, state };
}

// ---------------------------------------------------------------------------
// 线索归一
// ---------------------------------------------------------------------------

/**
 * cues 既可以是 extractCues() 返回的对象，也可以是字符串数组或单个字符串。
 * 统一拍平成“去重后的字符串列表”，并丢掉过短/空白的噪声线索。
 */
function flattenCues(cues) {
  const out = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text.length < MIN_CUE_LENGTH) return;
    out.push(text);
  };

  if (cues == null) return [];
  if (typeof cues === 'string') {
    push(cues);
  } else if (Array.isArray(cues)) {
    for (const item of cues) push(item);
  } else if (typeof cues === 'object') {
    // extractCues 的结构：{ mentions, ids, latins, topics, times, emotions }
    for (const key of ['mentions', 'ids', 'latins', 'topics', 'times', 'emotions', 'entities']) {
      const value = cues[key];
      if (Array.isArray(value)) for (const item of value) push(item);
      else push(value);
    }
  }

  // 去重（大小写不敏感，保留首次出现的写法）
  const seen = new Set();
  const unique = [];
  for (const text of out) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(text);
  }
  return unique;
}

/** 命中黑名单则返回命中的那个词；否则 null。 */
function findBlacklistHit(cues) {
  if (!cues.length) return null;
  for (const word of blacklist) {
    if (!word) continue;
    for (const cue of cues) {
      if (cue.toLowerCase().includes(word)) return word;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 候选检索
// ---------------------------------------------------------------------------

/**
 * 候选：未删 + ts 早于 30 天前 + confidence ≥ 0.6 + 正文被任一 cue 命中。
 * SQL 负责粗筛（还能吃到 ix_events_ts），JS 再精确统计命中线索数并排序。
 */
function findCandidates(db, cues, nowMs) {
  const cutoff = new Date(nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const lowerCues = cues.map((cue) => cue.toLowerCase());
  const matchClause = lowerCues.map(() => 'instr(lower(content), ?) > 0').join(' OR ');

  const rows = db
    .prepare(
      `SELECT id, ts, content, evidence, confidence, salience, speaker_name, group_id, channel
         FROM events
        WHERE deleted = 0
          AND ts < ?
          AND confidence >= ?
          AND (${matchClause})
        ORDER BY ts DESC
        LIMIT 200`,
    )
    .all(cutoff, MIN_CONFIDENCE, ...lowerCues);

  const enriched = [];
  for (const row of rows) {
    const text = String(row.content == null ? '' : row.content);
    const lowered = text.toLowerCase();
    const matchedCues = cues.filter((cue) => lowered.includes(cue.toLowerCase()));
    if (!matchedCues.length) continue;
    enriched.push({
      id: Number(row.id),
      ts: row.ts,
      content: text,
      evidence: row.evidence == null ? '' : String(row.evidence),
      confidence: Number(row.confidence),
      salience: Number(row.salience) || 0,
      matchedCues,
      matched: matchedCues.length,
    });
  }

  // 命中线索越多越相关；其次显著度、置信度；最后时间新者优先，保证结果可复现
  enriched.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.salience - a.salience ||
      b.confidence - a.confidence ||
      String(b.ts).localeCompare(String(a.ts)),
  );
  return enriched;
}

// ---------------------------------------------------------------------------
// 回声块渲染
// ---------------------------------------------------------------------------

/** 单条回声正文：压空白，超长按码点截断到 80 字 + '…'。 */
function shortContent(text) {
  const chars = Array.from(String(text == null ? '' : text).replace(/\s+/g, ' ').trim());
  if (!chars.length) return '';
  return chars.length > CONTENT_MAX_CHARS ? `${chars.slice(0, CONTENT_MAX_CHARS).join('')}${ELLIPSIS}` : chars.join('');
}

/** 行格式：`[回声] 时间：内容（证据，置信）`。 */
function formatLine(row, content) {
  const date = String(row.ts || '').slice(0, 10) || '未知时间';
  const evidence = !row.evidence ? '无证据' : row.evidence;
  const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence).toFixed(2) : '0.00';
  return `${ECHO_PREFIX} ${date}：${content}（${evidence}，${confidence}）`;
}

/** 按条数 + token 双上限打包回声行。放不下的候选直接跳过，不做半截输出。 */
function buildEcho(candidates, budget) {
  const items = [];
  const lines = [];
  let usedTokens = 0;

  for (const row of candidates) {
    if (items.length >= budget.maxItems) break;

    const bodyFull = shortContent(row.content);
    if (!bodyFull) continue;

    // 先扣掉“固定开销”（前缀/日期/证据/置信/括号），剩余额度才给正文
    const overhead = estimateTokens(formatLine(row, ''));
    const room = budget.maxTokens - usedTokens - overhead - 2;
    if (room < 6) break; // 余量塞不下一句有意义的话

    let body = bodyFull;
    if (estimateTokens(body) > room) body = clipToTokens(body, room);

    let line = formatLine(row, body);
    let cost = estimateTokens(line);

    // 估算误差兜底：继续压缩正文，直到放得下（正文至少保留几个字）
    while (usedTokens + cost > budget.maxTokens && Array.from(body).length > 6) {
      const nextMax = Math.max(6, estimateTokens(body) - 6);
      const clipped = clipToTokens(body, nextMax);
      if (clipped === body) break;
      body = clipped;
      line = formatLine(row, body);
      cost = estimateTokens(line);
    }
    if (usedTokens + cost > budget.maxTokens) break;

    usedTokens += cost;
    lines.push(line);
    items.push({
      id: row.id,
      ts: row.ts,
      content: body,
      line,
      evidence: row.evidence || null,
      confidence: row.confidence,
      salience: row.salience,
      matchedCues: row.matchedCues,
      tokens: cost,
    });
  }

  const block = lines.length ? lines.join('\n') : null;
  return { items, block, tokens: block ? estimateTokens(block) : 0 };
}

// ---------------------------------------------------------------------------
// 措辞：suggestion 必须是疑问句
// ---------------------------------------------------------------------------

/** 结尾不是 ？/? 就补成疑问句式（例如末尾加“要不要说说？”）。 */
function ensureQuestion(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return '要不要说说？';
  if (/[？?]\s*$/.test(value)) return value; // 已经是问句，原样返回
  const trimmed = value.replace(/[。．.!！…，,、；;：:\s]+$/u, '');
  return trimmed ? `${trimmed}，要不要说说？` : '要不要说说？';
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function normalizeTurn(raw, state) {
  const turn = Number(raw);
  if (Number.isFinite(turn) && turn >= 0) return turn;
  // 调用方没给轮次时，按“上一次 + 1”保守推进，避免凭空重置频率闸
  return state && state.lastTurn != null ? state.lastTurn + 1 : 1;
}

function normalizeBudget(raw) {
  const maxItems = Math.min(MAX_ITEMS, Math.max(1, Math.floor(Number(raw && raw.maxItems) || MAX_ITEMS)));
  const maxTokens = Math.min(MAX_TOKENS, Math.max(20, Math.floor(Number(raw && raw.maxTokens) || MAX_TOKENS)));
  return { maxItems, maxTokens };
}

function reject(reason, detail, extra) {
  return {
    allowed: false,
    reason,
    detail,
    block: null,
    items: [],
    suggestion: null,
    used: { count: 0, tokens: 0 },
    ...extra,
  };
}

/**
 * @param {DatabaseSync} db
 * @param {{turn?: number, sessionId?: string, cues?: any, now?: number|string|Date,
 *          budget?: {maxItems?: number, maxTokens?: number}, suggestion?: string}} [options]
 * @returns {{allowed: boolean, reason: string|null, block: string|null, items: object[],
 *            suggestion: string|null, used: {count:number, tokens:number}, detail?: string}}
 */
function proactiveRecall(db, options = {}) {
  const sessionId = options.sessionId == null ? 'default' : String(options.sessionId);
  const nowMs = toMs(options.now);
  const budget = normalizeBudget(options.budget);
  const cues = flattenCues(options.cues);

  const rawState = stateOf(sessionId);
  const turn = normalizeTurn(options.turn, rawState);

  // 闸门 1：黑名单。命中即拒绝，连候选都不查（防止翻出敏感话题）。
  const blacklisted = findBlacklistHit(cues);
  if (blacklisted) {
    return reject('blacklisted', `线索命中黑名单关键词「${blacklisted}」，不主动提及`, {
      budget,
      cues,
      blockedBy: blacklisted,
    });
  }

  // 闸门 2：频率。注意只在真正产出回声后才记账，拒绝不消耗额度。
  const gate = checkFrequency(sessionId, turn);
  if (!gate.ok) {
    return reject('frequency_cap', gate.detail, { budget, cues });
  }

  // 闸门 3：候选。没有线索 / 没有候选 / 候选放不进预算，都不开口。
  if (!cues.length) {
    return reject('no_candidates', '没有可用线索（cues 为空或都短于 2 个字）', { budget, cues });
  }

  const candidates = findCandidates(db, cues, nowMs);
  if (!candidates.length) {
    return reject('no_candidates', `没有满足条件的事件（命中线索、>${LOOKBACK_DAYS} 天未提、置信度 ≥ ${MIN_CONFIDENCE}）`, {
      budget,
      cues,
    });
  }

  const echo = buildEcho(candidates, budget);
  if (!echo.items.length) {
    return reject('no_candidates', '候选内容放不进回声预算（≤2 条 / ≤250 token）', { budget, cues });
  }

  // 记账：只有真的产出回声才占用本会话的 2 次额度
  sessionState.set(sessionId, { count: gate.state.count + 1, lastTurn: turn });

  // 措辞：默认由第一条回声生成一句问话；调用方也可传入自己的 suggestion，同样会被规整成问句
  const first = echo.items[0];
  const base = `上次你提过「${clipChars(first.content, 40)}」`;
  const suggestion = ensureQuestion(options.suggestion == null ? base : options.suggestion);
  return {
    allowed: true,
    reason: null,
    block: echo.block,
    items: echo.items,
    suggestion,
    used: { count: echo.items.length, tokens: echo.tokens },
    budget,
    cues,
    turn,
    sessionId,
  };
}

module.exports = {
  proactiveRecall,
  addToBlacklist,
  removeFromBlacklist,
  clearBlacklist,
  listBlacklist,
  resetFrequency,
  // 常量与工具导出，便于上层展示与自测
  LOOKBACK_DAYS,
  MIN_CONFIDENCE,
  MAX_ITEMS,
  MAX_TOKENS,
  TURN_WINDOW,
  SESSION_MAX,
  ensureQuestion,
  flattenCues,
};
