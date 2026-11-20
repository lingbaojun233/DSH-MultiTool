'use strict';

/**
 * registry/lib/loader.js — read_module 加载器（懒加载「怎么用」）。
 *
 * 职责（见 docs/registry-design.md ③）：
 *   1. 白名单：只认 modules/<name>/ 目录名；未知模块返回 UNKNOWN_MODULE + 可用名单（≤10）。
 *   2. 读 modules/<name>/README.md；estimateTokens > maxTokens（默认 600）时
 *      优先在「段落边界」截断（必要时退化到句子/字符边界），并附 warning，
 *      写明原始 token 数与截断后 token 数。
 *   3. 同一 sessionKey 重复读取 → cached:true（内容照常返回，正文不缓存，
 *      由调用方自行去重、不要重复塞进上下文）。
 *   4. 每次成功 read 追加 data/registry/usage.jsonl 一行
 *      {ts, name, sessionKey, tokens, cached}；markUsed 追加
 *      {ts, name, sessionKey, used:true}。
 *   5. stats 汇总读取次数、「读了没用上」清单、会话数。
 *
 * 根目录约定：root 接受三种写法 —— registry 目录、仓库根（自动找
 * <root>/registry），或 modules 目录本身（<registry>/modules）。usage 固定写到
 * registry 的兄弟目录：<registry>/../data/registry/usage.jsonl。
 *
 * 失败（模块目录缺失、README 缺失、参数非法……）一律返回结构化对象
 * {ok:false, code, message, available?}，绝不向调用方抛未捕获异常。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_TOKENS = 600;
const MAX_MAX_TOKENS = 100000; // 防呆上限，避免调用方传 Infinity/天文数字
const AVAILABLE_LIMIT = 10;
const DEFAULT_SESSION = '(default)';

/**
 * 只记「本会话读过哪些模块」，不缓存 README 正文。
 * 类型：Map<sessionKey, Set<moduleName>>。
 */
const sessionReads = new Map();

/* ------------------------------------------------------------------ */
/* token 估算：优先 ../lib/tokens.js，缺失/损坏时用本地同算法兜底        */
/* ------------------------------------------------------------------ */

/**
 * 与 memory/lib/tokens.js、registry/lib/tokens.js 一致的确定性估算：
 * CJK 每字 1.1 token，其余字符每 4 个 1 token，向上取整。
 * 仅在 require('./tokens.js') 不可用时使用。
 */
function fallbackEstimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk * 1.1 + other / 4);
}

/** 从各种导出形态里取出估算函数（兼容 function / {estimateTokens} / default）。 */
function asEstimator(mod) {
  if (typeof mod === 'function') return (text) => mod(text);
  if (!mod || typeof mod !== 'object') return null;
  for (const key of ['estimateTokens', 'estimate', 'countTokens', 'count']) {
    if (typeof mod[key] === 'function') return (text) => mod[key](text);
  }
  if (mod.default) return asEstimator(mod.default);
  return null;
}

/**
 * 每次 read 解析一次估算器：tokens.js 可能是稍后才落地的兄弟实现，
 * 所以这里不做一次性永久缓存；成功解析后由 Node 的 require 缓存兜底。
 * 返回的函数保证是「非负整数」且自身不会抛异常。
 */
function makeEstimator() {
  let impl = null;
  try {
    impl = asEstimator(require('./tokens.js'));
  } catch (err) {
    impl = null; // tokens.js 尚未落地 / 语法错误 → 本地回退，不中断读取
  }
  const base = impl || fallbackEstimateTokens;
  return function estimate(text) {
    try {
      const value = Number(base(text));
      if (Number.isFinite(value) && value >= 0) return Math.ceil(value);
    } catch (err) {
      // 落到本地实现
    }
    return fallbackEstimateTokens(text);
  };
}

/* ------------------------------------------------------------------ */
/* 路径 / 文件系统小工具                                                */
/* ------------------------------------------------------------------ */

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (err) {
    return false;
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 去掉尾部空白；截断后的正文保持是原文的「前缀」。 */
function trimEnd(text) {
  return String(text).replace(/[ \t\r\n]+$/, '');
}

function normalizeText(raw) {
  return String(raw)
    .replace(/^\uFEFF/, '') // BOM
    .replace(/\r\n?/g, '\n'); // CRLF/CR → LF，token 估算不受换行风格影响
}

/**
 * 解析布局。root 接受三种写法（调用方常常混用）：
 *   1. registry 目录本身（<repo>/registry）
 *   2. 仓库根（<repo>，自动找 <repo>/registry/modules）
 *   3. modules 目录本身（<repo>/registry/modules）
 * @returns {{registryDir: string, modulesDir: string, usageFile: string}|null}
 */
function resolveLayout(root) {
  if (typeof root !== 'string' || !root.trim()) return null;
  const abs = path.resolve(root.trim());
  let registryDir;
  if (path.basename(abs) === 'modules' && isDirectory(abs)) {
    registryDir = path.dirname(abs);
  } else if (isDirectory(path.join(abs, 'modules'))) {
    registryDir = abs;
  } else if (isDirectory(path.join(abs, 'registry', 'modules'))) {
    registryDir = path.join(abs, 'registry');
  } else {
    registryDir = abs; // 让 scanModules 给出 MODULES_DIR_MISSING
  }
  return {
    registryDir,
    modulesDir: path.join(registryDir, 'modules'),
    usageFile: path.resolve(registryDir, '..', 'data', 'registry', 'usage.jsonl'),
  };
}

/**
 * 白名单扫描：modules 下的每个非隐藏目录都算已知模块（目录名即模块名）。
 * @returns {{ok:true, names:string[]}|{ok:false, code:string, message:string}}
 */
function scanModules(layout) {
  let entries;
  try {
    entries = fs.readdirSync(layout.modulesDir, { withFileTypes: true });
  } catch (err) {
    const detail = (err && (err.code || err.message)) || 'ERROR';
    return {
      ok: false,
      code: 'MODULES_DIR_MISSING',
      message: `模块目录不可用：${layout.modulesDir}（${detail}）`,
    };
  }
  const names = [];
  for (const entry of entries) {
    if (!entry || !entry.name || entry.name.startsWith('.')) continue;
    let isDir = entry.isDirectory();
    if (!isDir && typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
      isDir = isDirectory(path.join(layout.modulesDir, entry.name));
    }
    if (isDir) names.push(entry.name);
  }
  names.sort(compareText);
  return { ok: true, names };
}

/** 从 module.yaml 取 title（只做一行正则，不依赖 yaml.js）；缺失时回退为模块名。 */
function readTitle(layout, name) {
  const yamlPath = path.join(layout.modulesDir, name, 'module.yaml');
  try {
    const text = normalizeText(fs.readFileSync(yamlPath, 'utf8'));
    const matched = /^title[ \t]*:[ \t]*(.+)$/m.exec(text);
    if (!matched) return name;
    let title = matched[1].trim();
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1).trim();
    }
    return title || name;
  } catch (err) {
    return name;
  }
}

/* ------------------------------------------------------------------ */
/* 截断：段落边界优先，其次句子，最后字符                                */
/* ------------------------------------------------------------------ */

const BOUNDARY_LABELS = {
  paragraph: '段落边界',
  sentence: '句子边界',
  char: '字符边界',
};

/** 「段落」= 至少一个空行分隔；返回每个段落结尾在原文中的下标。 */
function collectParagraphCuts(text) {
  const cuts = [];
  const re = /\n{2,}/g;
  let matched;
  while ((matched = re.exec(text)) !== null) {
    if (matched.index > 0) cuts.push(matched.index);
  }
  return cuts;
}

/** 句子边界 = 中文句末标点之后，或任意换行之后。 */
function collectSentenceCuts(text) {
  const set = new Set();
  for (const matched of text.matchAll(/[。！？；!?;]/g)) set.add(matched.index + matched[0].length);
  for (const matched of text.matchAll(/\n/g)) set.add(matched.index + matched[0].length);
  return [...set].sort((a, b) => a - b);
}

/**
 * 在升序 cut 列表里二分找「最大的、前缀 token ≤ maxTokens」的下标。
 * 依赖 estimate 对前缀单调不减；返回 -1 表示第一个 cut 都放不下。
 */
function largestFittingCut(text, cuts, maxTokens, estimate) {
  let lo = 0;
  let hi = cuts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = cuts[mid];
    if (estimate(trimEnd(text.slice(0, cut))) <= maxTokens) {
      best = cut;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** 按码点二分，找最大前缀长度。 */
function largestFittingChars(text, maxTokens, estimate) {
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estimate(chars.slice(0, mid).join('')) <= maxTokens) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** 落刀并复核 token 预算（估算器非单调时自动退化为字符边界）。 */
function finalizeCut(text, cut, maxTokens, estimate, boundary) {
  let index = cut;
  let label = boundary;
  if (index < 0) {
    index = largestFittingChars(text, maxTokens, estimate);
    label = 'char';
  }
  let content = trimEnd(text.slice(0, index));
  let tokens = estimate(content);
  if (tokens > maxTokens) {
    content = trimEnd(text.slice(0, largestFittingChars(text, maxTokens, estimate)));
    tokens = estimate(content);
    label = 'char';
  }
  return { content, tokens, boundary: label };
}

/**
 * 把 text 截到 ≤ maxTokens，返回原文前缀 + 实际 token + 落刀边界类型。
 * @returns {{content:string, tokens:number, boundary:'paragraph'|'sentence'|'char'}}
 */
function truncateToTokens(text, maxTokens, estimate) {
  const paragraphCut = largestFittingCut(text, collectParagraphCuts(text), maxTokens, estimate);
  if (paragraphCut >= 0) return finalizeCut(text, paragraphCut, maxTokens, estimate, 'paragraph');

  const sentenceCut = largestFittingCut(text, collectSentenceCuts(text), maxTokens, estimate);
  if (sentenceCut >= 0) return finalizeCut(text, sentenceCut, maxTokens, estimate, 'sentence');

  return finalizeCut(text, -1, maxTokens, estimate, 'char');
}

/* ------------------------------------------------------------------ */
/* usage.jsonl                                                         */
/* ------------------------------------------------------------------ */

/** 追加一行 JSONL；失败返回错误字符串，成功返回 null（不抛异常）。 */
function appendUsage(layout, record) {
  try {
    fs.mkdirSync(path.dirname(layout.usageFile), { recursive: true });
    fs.appendFileSync(layout.usageFile, `${JSON.stringify(record)}\n`, 'utf8');
    return null;
  } catch (err) {
    return (err && (err.code || err.message)) || 'ERROR';
  }
}

/* ------------------------------------------------------------------ */
/* 参数归一化                                                          */
/* ------------------------------------------------------------------ */

function normalizeMaxTokens(raw) {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(value, MAX_MAX_TOKENS);
}

function normalizeSessionKey(raw) {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return DEFAULT_SESSION;
}

/** markUsed 第三参兼容 `markUsed(root, name, sessionKey)` 与 `{sessionKey}` 两种写法。 */
function normalizeSessionArg(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'sessionKey' in raw) {
    return normalizeSessionKey(raw.sessionKey);
  }
  return normalizeSessionKey(raw);
}

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {});
}

/* ------------------------------------------------------------------ */
/* 公共 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 读取一个模块的 README（决策卡）。
 * @param {string} root registry 目录或 DSH-MultiTool 仓库根
 * @param {string} name 模块名（modules/<name>/）
 * @param {{sessionKey?: string|number, maxTokens?: number}} [options]
 * @returns {{ok:true, name:string, title:string, content:string, tokens:number,
 *            truncated:boolean, cached:boolean, warning?:string, usageError?:string}
 *          |{ok:false, code:string, message:string, available?:string[]}}
 */
function read(root, name, options) {
  try {
    return readImpl(root, name, options);
  } catch (err) {
    return fail('INTERNAL_ERROR', `读取模块失败：${(err && err.message) || String(err)}`);
  }
}

function readImpl(root, name, options) {
  const layout = resolveLayout(root);
  if (!layout) return fail('INVALID_ARGUMENT', 'root 必须是非空路径字符串（registry 目录或仓库根）');
  if (typeof name !== 'string' || !name.trim()) {
    return fail('INVALID_ARGUMENT', 'name 必须是非空字符串（模块目录名）');
  }
  const moduleName = name.trim();
  const opts = options && typeof options === 'object' ? options : {};
  const maxTokens = normalizeMaxTokens(opts.maxTokens);
  const sessionKey = normalizeSessionKey(opts.sessionKey);

  // 1) 白名单
  const scan = scanModules(layout);
  if (!scan.ok) return fail(scan.code, scan.message);
  if (!scan.names.includes(moduleName)) {
    const available = scan.names.slice(0, AVAILABLE_LIMIT);
    const hint = available.length ? `可用模块（前 ${available.length} 个）：${available.join(', ')}` : '当前没有任何可用模块';
    return fail('UNKNOWN_MODULE', `未知模块「${moduleName}」。${hint}`, { available });
  }

  // 2) 读 README
  const readmePath = path.join(layout.modulesDir, moduleName, 'README.md');
  let raw;
  try {
    raw = fs.readFileSync(readmePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return fail('README_MISSING', `模块「${moduleName}」缺少 README.md：${readmePath}`);
    }
    return fail('README_UNREADABLE', `模块「${moduleName}」的 README.md 读取失败（${(err && (err.code || err.message)) || 'ERROR'}）：${readmePath}`);
  }

  const title = readTitle(layout, moduleName);
  const fullContent = normalizeText(raw);
  const estimate = makeEstimator();
  const fullTokens = estimate(fullContent);

  let content = fullContent;
  let tokens = fullTokens;
  let truncated = false;
  let warning;
  if (fullTokens > maxTokens) {
    const cut = truncateToTokens(fullContent, maxTokens, estimate);
    content = cut.content;
    tokens = cut.tokens;
    truncated = true;
    warning =
      `README 原始 ${fullTokens} token，超过上限 ${maxTokens}，` +
      `已在${BOUNDARY_LABELS[cut.boundary] || '边界'}截断；截断后 ${tokens} token。`;
  }

  // 3) 会话内去重标记（只标记「读过」，不缓存正文）
  const seen = sessionReads.get(sessionKey);
  const cached = Boolean(seen && seen.has(moduleName));

  // 4) 每次成功读取都记一行 usage（cached 读取也记，便于统计真实请求量）
  const usageError = appendUsage(layout, {
    ts: new Date().toISOString(),
    name: moduleName,
    sessionKey,
    tokens,
    cached,
  });

  if (!cached) {
    const names = seen || new Set();
    names.add(moduleName);
    sessionReads.set(sessionKey, names);
  }

  const result = {
    ok: true,
    name: moduleName,
    title,
    content,
    tokens,
    truncated,
    cached,
  };
  if (warning) result.warning = warning;
  if (usageError) result.usageError = usageError;
  return result;
}

/**
 * 记录「读了之后确实用了」。白名单外的模块返回 UNKNOWN_MODULE。
 * @returns {{ok:true, name:string, sessionKey:string}
 *          |{ok:false, code:string, message:string, available?:string[]}}
 */
function markUsed(root, name, sessionKey) {
  try {
    return markUsedImpl(root, name, sessionKey);
  } catch (err) {
    return fail('INTERNAL_ERROR', `记录模块使用失败：${(err && err.message) || String(err)}`);
  }
}

function markUsedImpl(root, name, sessionKey) {
  const layout = resolveLayout(root);
  if (!layout) return fail('INVALID_ARGUMENT', 'root 必须是非空路径字符串（registry 目录或仓库根）');
  if (typeof name !== 'string' || !name.trim()) {
    return fail('INVALID_ARGUMENT', 'name 必须是非空字符串（模块目录名）');
  }
  const moduleName = name.trim();
  const scan = scanModules(layout);
  if (!scan.ok) return fail(scan.code, scan.message);
  if (!scan.names.includes(moduleName)) {
    const available = scan.names.slice(0, AVAILABLE_LIMIT);
    return fail('UNKNOWN_MODULE', `未知模块「${moduleName}」。`, { available });
  }

  const key = normalizeSessionArg(sessionKey);
  const usageError = appendUsage(layout, {
    ts: new Date().toISOString(),
    name: moduleName,
    sessionKey: key,
    used: true,
  });
  if (usageError) {
    return fail('USAGE_WRITE_FAILED', `无法写入 ${layout.usageFile}（${usageError}）`);
  }
  return { ok: true, name: moduleName, sessionKey: key };
}

/**
 * 汇总 usage.jsonl：
 *   reads   [{name, count}] 按 count 降序、name 升序
 *   unused  有读取记录但从未 markUsed 的（现存）模块名，升序
 *   sessions 出现过的 sessionKey 去重数量（含 markUsed 记录）
 * usage 文件不存在时返回空统计，不视为错误。
 * @returns {{reads:Array<{name:string,count:number}>, unused:string[], sessions:number}
 *          |{ok:false, code:string, message:string}}
 */
function stats(root) {
  try {
    return statsImpl(root);
  } catch (err) {
    return fail('INTERNAL_ERROR', `统计模块使用失败：${(err && err.message) || String(err)}`);
  }
}

function statsImpl(root) {
  const layout = resolveLayout(root);
  if (!layout) return fail('INVALID_ARGUMENT', 'root 必须是非空路径字符串（registry 目录或仓库根）');

  let text = '';
  try {
    text = fs.readFileSync(layout.usageFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      text = '';
    } else {
      return fail('USAGE_READ_FAILED', `无法读取 ${layout.usageFile}（${(err && (err.code || err.message)) || 'ERROR'}）`);
    }
  }

  const counts = new Map(); // name -> 读取次数
  const used = new Set();
  const sessions = new Set();
  for (const line of normalizeText(text).split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      continue; // 坏行（并发写/手工编辑）跳过，不影响统计
    }
    if (!record || typeof record !== 'object') continue;
    const recordedName = typeof record.name === 'string' ? record.name : '';
    if (record.sessionKey !== undefined && record.sessionKey !== null) {
      sessions.add(String(record.sessionKey));
    }
    if (!recordedName) continue;
    if (record.used === true) {
      used.add(recordedName);
      continue;
    }
    if (typeof record.tokens === 'number' || typeof record.cached === 'boolean') {
      counts.set(recordedName, (counts.get(recordedName) || 0) + 1);
    }
  }

  const reads = [...counts.entries()]
    .map(([recordedName, count]) => ({ name: recordedName, count }))
    .sort((a, b) => b.count - a.count || compareText(a.name, b.name));

  // unused 只针对「当前仍存在的模块」；模块目录不可用时退回 usage 里出现过的名字。
  const scan = scanModules(layout);
  const candidates = scan.ok ? scan.names : [...counts.keys()].sort(compareText);
  const unused = candidates.filter((candidate) => counts.has(candidate) && !used.has(candidate));

  return {
    reads,
    unused,
    sessions: sessions.size,
  };
}

module.exports = { read, markUsed, stats };
