'use strict';

/**
 * lint.js — 模块 README 质检器（只报告，绝不改文件）
 *
 * 检查项：
 *   1. README ≤600 token；目录行 `- <name> — <when>` ≤60 token
 *   2. 四段齐全（何时用 / 何时不用 / 输入 / 输出 / 例子）且顺序正确；「何时不用」非空
 *   3. 例子里的参数名必须出现在「输入 / 输出」表里
 *   4. 无禁止词（强大/全面/高效/赋能/一站式/首先/其次/总之）；无四字形容词堆砌
 *   5. 触发条件（when）与其它模块重叠：去标点包含关系，或字符二元组 Jaccard ≥0.6
 *
 * 返回 { ok, issues:[{code, field, message, suggestion}], tokens }
 * 本文件没有任何写文件逻辑。
 *
 * 依赖约定：
 *   - lib/tokens.js 可用时用它的估算；否则本地回退：cjk×1.1 + 其它/4，向上取整
 *   - lib/yaml.js 可用时用它的 parse；否则用本文件的顶层字段扫描（只读 lint 需要的那几个键）
 */

const fs = require('fs');
const path = require('path');

const README_TOKEN_BUDGET = 600;
const CATALOG_TOKEN_BUDGET = 60;
const MAX_SECTION_LINES = 2;
const MAX_EXAMPLE_LINES = 3;
const OVERLAP_JACCARD = 0.6;

/* ================================================================== *
 * 1. token 估算（优先 lib/tokens.js，失败回退）
 * ================================================================== */

const CJK_RANGES = [
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

/** 本地回退：cjk×1.1 + 其它/4，向上取整。 */
function fallbackTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    let isCjk = false;
    for (const [lo, hi] of CJK_RANGES) {
      if (code >= lo && code <= hi) {
        isCjk = true;
        break;
      }
    }
    if (isCjk) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.1 + other / 4);
}

function numberOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['tokens', 'count', 'value', 'total']) {
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key];
    }
  }
  return null;
}

let tokenFn = null;
let tokenResolved = false;
let tokenResolvedWith = 'local-fallback(cjk*1.1+other/4)';

function resolveTokenFn() {
  if (tokenResolved) return tokenFn;
  tokenResolved = true;
  let mod = null;
  try {
    mod = require('./tokens.js');
  } catch (_) {
    return null;
  }
  if (!mod) return null;

  const candidates = [];
  if (typeof mod === 'function') candidates.push([mod, 'module']);
  else if (typeof mod === 'object') {
    for (const name of ['estimate', 'estimateTokens', 'count', 'countTokens', 'tokens', 'calc', 'calcTokens', 'tokenCount', 'countText']) {
      if (typeof mod[name] === 'function') candidates.push([mod[name].bind(mod), name]);
    }
    if (typeof mod.default === 'function') candidates.push([mod.default.bind(mod), 'default']);
  }

  for (const [fn, name] of candidates) {
    let probe;
    try {
      probe = fn('测试abc 123');
    } catch (_) {
      continue;
    }
    if (numberOf(probe) === null || !(numberOf(probe) > 0)) continue;
    tokenFn = (text) => {
      const value = numberOf(fn(String(text)));
      if (value === null) throw new Error('tokens.js 返回了非数字');
      return value;
    };
    tokenResolvedWith = 'lib/tokens.js#' + name;
    return tokenFn;
  }
  return null;
}

function countTokens(text) {
  const fn = resolveTokenFn();
  if (fn) {
    try {
      const value = fn(String(text === undefined || text === null ? '' : text));
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
    } catch (_) {
      /* 回退 */
    }
  }
  return fallbackTokens(text);
}

/** 实际使用的估算来源（诊断用，不进 issues）。 */
function tokenSource() {
  resolveTokenFn();
  return tokenResolvedWith;
}

/* ================================================================== *
 * 2. 常量
 * ================================================================== */

const BANNED_WORDS = ['强大', '全面', '高效', '赋能', '一站式', '首先', '其次', '总之'];
const BANNED_HINTS = {
  强大: '改成中性描述，例如「够用」',
  全面: '改成中性描述，例如「完整」',
  高效: '改成中性描述，例如「直接」',
  赋能: '改成中性描述，例如「支持」',
  一站式: '改成中性描述，例如「集中」',
  首先: '去掉次序词，直接写条件',
  其次: '去掉次序词，直接写条件',
  总之: '去掉总结词，直接写条件',
};

const SECTION_DEFS = [
  { key: 'when', label: '何时用', aliases: ['何时用'] },
  { key: 'not_when', label: '何时不用', aliases: ['何时不用', '何时不使用', '什么时候不用'] },
  { key: 'io', label: '输入 / 输出', aliases: ['输入/输出', '输入输出', '输入/输出/字段'] },
  { key: 'example', label: '例子', aliases: ['例子', '示例', '用例'] },
];

const SECTION_ORDER_HINT = '固定顺序：## 何时用 → ## 何时不用 → ## 输入 / 输出 → ## 例子';

/** 命令行 flag 里常见但不是业务字段的参数，不参与「例子参数」检查。 */
const FLAG_EXEMPT = new Set([
  'help', 'h', 'version', 'v', 'verbose', 'debug', 'quiet', 'json', 'force', 'f',
  'dry_run', 'dryrun', 'no_color', 'color', 'out', 'input_file', 'config',
]);

/** 通用信封键：输出里常见、且不必逐模块写进字段表。 */
const ENVELOPE_KEYS = new Set([
  'ok', 'error', 'code', 'msg', 'message', 'status', 'success', 'data', 'warnings', 'warning',
]);

/* ================================================================== *
 * 3. 读取 module.yaml
 * ================================================================== */

function stripInlineComment(text) {
  const value = String(text);
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).replace(/\s+$/, '');
  }
  return value.replace(/\s+$/, '');
}

function parseScalarLite(raw) {
  const value = stripInlineComment(String(raw).trim()).trim();
  if (value === '') return '';
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\(["\\ntr])/g, (whole, ch) => {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === 'r') return '\r';
        return ch;
      }).replace(/''/g, "'");
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  return value;
}

/** 只扫顶层键 + 缩进 2 格的 entry 子键，足够 lint 用；不追求完整 YAML。 */
function scanTopLevel(text) {
  const out = {};
  const lines = String(text === undefined || text === null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let section = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const pad = /^[ \t]*/.exec(line)[0];
    const body = line.slice(pad.length);
    const matched = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/.exec(body);
    if (!matched) continue;
    const key = matched[1];
    const value = matched[2].trim();
    const isTop = pad.length === 0;
    const target = isTop ? out : (section && typeof out[section] === 'object' ? out[section] : null);
    if (!target) continue;
    if (value === '') {
      if (isTop) {
        section = key;
        out[key] = {};
      } else {
        target[key] = '';
      }
      continue;
    }
    target[key] = parseScalarLite(value);
    if (isTop) section = null;
  }
  return out;
}

function readYamlLite(dir) {
  for (const fileName of ['module.yaml', 'module.yml']) {
    const file = path.join(dir, fileName);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    let data = null;
    let mod = null;
    try {
      mod = require('./yaml.js');
    } catch (_) {
      mod = null;
    }
    if (mod && typeof mod.parse === 'function') {
      try {
        const parsed = mod.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      } catch (_) {
        data = null;
      }
    }
    if (!data) data = scanTopLevel(text);
    return { file, text, data };
  }
  return null;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/* ================================================================== *
 * 4. README 结构解析
 * ================================================================== */

function normalizeHeading(title) {
  return String(title)
    .replace(/\s+/g, '')
    .replace(/[／]/g, '/')
    .replace(/[「」『』【】[\]]/g, '')
    .toLowerCase();
}

/** 切成 { level, title, lines } 段；代码块里的 # 不算标题。 */
function splitSections(markdown) {
  const lines = String(markdown === undefined || markdown === null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = null;
  let fence = null;

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence && line.trim().startsWith(fence)) fence = null;
      else if (!fence) fence = fenceMatch[1];
    }

    if (!fence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        current = { level: heading[1].length, title: heading[2].trim(), lines: [], key: null };
        sections.push(current);
        continue;
      }
    }
    if (current) current.lines.push(line);
  }

  for (const section of sections) {
    const normalized = normalizeHeading(section.title);
    const def = SECTION_DEFS.find((item) => item.aliases.some((alias) => normalizeHeading(alias) === normalized));
    section.key = def ? def.key : null;
    section.label = def ? def.label : null;
  }
  return sections;
}

/** 段内的有效行（忽略空行、代码围栏、纯标记行）。 */
function contentLines(sectionLines) {
  const out = [];
  let fence = null;
  for (const line of sectionLines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence && line.trim().startsWith(fence)) fence = null;
      else if (!fence) fence = fenceMatch[1];
      continue;
    }
    if (fence) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '-' || trimmed === '*' || trimmed === '+') continue;
    out.push(trimmed);
  }
  return out;
}

/** 解析「输入 / 输出」表：返回 { rows:[{name,type}], hasHeader, raw }。 */
function parseFieldTable(sectionLines) {
  const rows = [];
  for (const line of sectionLines) {
    const trimmed = line.trim();
    if (!/^\|.*\|\s*$/.test(trimmed)) continue;
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    rows.push(cells);
  }
  if (rows.length === 0) return { rows: [], raw: 0 };

  const isSeparator = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '');

  const fields = [];
  let seenHeader = false;
  for (const cells of rows) {
    if (isSeparator(cells)) {
      seenHeader = true;
      continue;
    }
    if (!seenHeader) {
      // 第一行是表头
      seenHeader = true;
      continue;
    }
    const name = (cells[0] || '').replace(/^→\s*/, '').trim();
    if (!name) continue;
    fields.push({ name, rawName: cells[0], type: (cells[1] || '').trim(), cells });
  }
  return { rows: fields, raw: rows.length };
}

/** 例子段里的内容行（代码块内；没有代码块则取非空行）。 */
function parseExampleLines(sectionLines) {
  const fenced = [];
  const plain = [];
  let fence = null;
  for (const line of sectionLines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence && line.trim().startsWith(fence)) {
        fence = null;
        continue;
      }
      if (!fence) {
        fence = fenceMatch[1];
        continue;
      }
    }
    if (fence) fenced.push(line.replace(/\s+$/, ''));
    else if (line.trim()) plain.push(line.trim());
  }
  const source = fenced.length > 0 ? fenced : plain;
  return source.filter((line, index) => !(index === 0 && !line.trim())).filter((line) => line.trim());
}

/* ================================================================== *
 * 5. 例子参数一致性
 * ================================================================== */

function fieldAliases(fieldName) {
  const set = new Set();
  const add = (value) => {
    if (!value) return;
    set.add(value);
    set.add(value.replace(/-/g, '_'));
  };
  const norm = String(fieldName).replace(/^→\s*/, '').replace(/[`'"]/g, '').trim().toLowerCase();
  add(norm);
  const noBracket = norm.replace(/\[\]/g, '');
  add(noBracket);
  add(noBracket.split('[')[0].split('.')[0]);
  add(noBracket.split('.').pop());
  return set;
}

function normalizeParamName(raw) {
  return String(raw).trim().toLowerCase().replace(/-/g, '_').replace(/^_+|_+$/g, '');
}

/** 收集例子中顶层的 JSON key（只认对象第一层，避免把嵌套输出字段当参数）。 */
function topLevelJsonKeys(text) {
  const keys = [];
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        j += 1;
      }
      const str = text.slice(i + 1, j);
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (text[k] === ':' && stack.length === 1 && stack[0] === '{') keys.push(str);
      i = j;
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return keys;
}

/** 收集一段文本里的参数候选：CLI flag、JSON 顶层 key、name=value。 */
function collectNames(text, into) {
  const flags = /(^|[\s(（])(--?)([A-Za-z][A-Za-z0-9_-]*)/g;
  let match;
  while ((match = flags.exec(text)) !== null) {
    const name = normalizeParamName(match[3]);
    if (!name || FLAG_EXEMPT.has(name)) continue;
    into.add(name);
  }

  const assign = /(^|[\s,;{])([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  while ((match = assign.exec(text)) !== null) {
    const name = normalizeParamName(match[2]);
    if (!name || FLAG_EXEMPT.has(name)) continue;
    into.add(name);
  }

  for (const key of topLevelJsonKeys(text)) {
    const name = normalizeParamName(key);
    if (name) into.add(name);
  }
}

/**
 * 从例子里抽取参数名候选。
 * 以 `→` 开头的行算输出行：输出字段名同样要能在表里对上（通用信封键除外），
 * 但不把输出当成可传参数去要求。
 */
function extractExampleNames(lines) {
  const arrowIndex = lines.findIndex((line) => /^\s*(→|->|=>|⇒)/.test(line));
  const inputLines = arrowIndex < 0 ? lines : lines.slice(0, arrowIndex);
  const outputLines = arrowIndex < 0 ? [] : lines.slice(arrowIndex);

  const inputNames = new Set();
  collectNames(inputLines.join('\n'), inputNames);

  const outputNames = new Set();
  collectNames(outputLines.join('\n'), outputNames);

  return {
    inputNames: Array.from(inputNames),
    outputNames: Array.from(outputNames).filter((name) => !ENVELOPE_KEYS.has(name)),
    text: lines.join('\n'),
  };
}

/* ================================================================== *
 * 6. 禁止词 / 形容词堆砌
 * ================================================================== */

function findBanned(text) {
  const found = [];
  for (const word of BANNED_WORDS) {
    if (text.includes(word)) found.push(word);
  }
  return found;
}

const PRAISE_CHARS = /[强全优佳稳快高易美智灵省精极超丰完顺轻准牢靠]|卓越|流畅/;

/** 连续 ≥3 个「恰好 4 个汉字」的短语（用 、，/; 分隔）→ 形容词堆砌嫌疑。 */
function findAdjectiveStack(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    // 去掉列表符号、表格竖线、代码反引号，避免把前缀算进短语长度
    const cleaned = line
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/[|`]/g, ' ');
    const parts = cleaned.split(/[、，,／/;；]+/).map((part) => part.trim()).filter(Boolean);
    let run = [];
    const flush = () => {
      if (run.length >= 3) {
        const joined = run.join('');
        if (PRAISE_CHARS.test(joined)) hits.push(run.slice());
      }
      run = [];
    };
    for (const part of parts) {
      if (/^[\u4e00-\u9fff]{4}$/.test(part)) run.push(part);
      else flush();
    }
    flush();
  }
  return hits;
}

/* ================================================================== *
 * 7. 触发条件重叠（与 catalog 同一判据）
 * ================================================================== */

function normalizeTrigger(text) {
  return String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigramSet(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * 判据（与 catalog 一致）：去标点后互相包含，或字符二元组 Jaccard ≥0.6。
 * @returns {{overlap: boolean, kind: string, score: number}}
 */
function triggersOverlap(a, b) {
  const left = normalizeTrigger(a);
  const right = normalizeTrigger(b);
  if (!left || !right) return { overlap: false, kind: '', score: 0 };

  const leftShort = left.length <= right.length;
  const shortText = leftShort ? left : right;
  const longText = leftShort ? right : left;
  if (shortText.length >= 4 && longText.includes(shortText)) {
    return { overlap: true, kind: '包含关系', score: 1 };
  }

  const score = jaccard(bigramSet(left), bigramSet(right));
  if (score >= OVERLAP_JACCARD) return { overlap: true, kind: '二元组相似', score };
  return { overlap: false, kind: '', score };
}

function siblingModules(dir) {
  const parent = path.dirname(dir);
  const self = path.basename(dir);
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === self) continue;
    const childDir = path.join(parent, entry.name);
    if (!fs.existsSync(path.join(childDir, 'module.yaml')) && !fs.existsSync(path.join(childDir, 'module.yml'))) continue;
    out.push({ name: entry.name, dir: childDir });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/* ================================================================== *
 * 8. lint 入口
 * ================================================================== */

function makeIssue(code, field, message, suggestion) {
  return { code, field, message, suggestion };
}

/**
 * 质检一个模块目录（也接受直接传 README 路径）。
 * @param {string} moduleDir 模块目录，如 registry/modules/memory
 * @returns {{ok: boolean, issues: Array<{code: string, field: string, message: string, suggestion: string}>, tokens: number}}
 */
function lint(moduleDir) {
  const issues = [];
  let target = path.resolve(String(moduleDir === undefined || moduleDir === null ? '.' : moduleDir));

  let readmePath = null;
  try {
    if (/\.(md|markdown)$/i.test(target) && fs.existsSync(target) && fs.statSync(target).isFile()) {
      readmePath = target;
      target = path.dirname(target);
    }
  } catch (_) {
    /* 保持 target 原样 */
  }

  const yaml = readYamlLite(target);
  let yamlText = null;
  if (!yaml) {
    issues.push(makeIssue('MODULE_YAML_MISSING', 'module.yaml',
      '目录下没有 module.yaml，无法核对 name / when / readme',
      '新增 module.yaml（至少包含 name、when、not_when、entry），或确认传入的是模块目录'));
  } else if (!yaml.data || typeof yaml.data !== 'object') {
    issues.push(makeIssue('MODULE_YAML_INVALID', 'module.yaml',
      'module.yaml 无法解析成对象',
      '检查缩进（只支持 0/2 空格）与 key: value 写法'));
  } else {
    yamlText = yaml.text;
  }

  const data = (yaml && yaml.data) || {};
  const moduleName = asText(data.name) || path.basename(target);
  const whenText = asText(data.when);
  const notWhenText = asText(data.not_when);

  const readmeFile = asText(data.readme) || 'README.md';
  if (!readmePath) readmePath = path.join(target, readmeFile);

  if (!fs.existsSync(readmePath)) {
    issues.push(makeIssue('README_MISSING', 'readme',
      `找不到 README：${path.basename(readmePath)}`,
      '按四段结构新建 README.md：何时用 / 何时不用 / 输入 / 输出 / 例子'));
    return { ok: false, issues, tokens: 0 };
  }

  const markdown = fs.readFileSync(readmePath, 'utf8');
  const tokens = countTokens(markdown);

  /* ---------- 1. 预算 ---------- */

  if (tokens > README_TOKEN_BUDGET) {
    issues.push(makeIssue('README_TOO_LONG', 'readme',
      `README 约 ${tokens} token，超过 ${README_TOKEN_BUDGET} 预算`,
      `删到 ${README_TOKEN_BUDGET} token 以内：先砍例子，再砍措辞；功能罗列和安装说明整段删掉`));
  }

  if (yamlText !== null && whenText) {
    const catalogLine = `- ${moduleName} — ${whenText}`;
    const catalogTokens = countTokens(catalogLine);
    if (catalogTokens > CATALOG_TOKEN_BUDGET) {
      issues.push(makeIssue('CATALOG_LINE_TOO_LONG', 'when',
        `目录行约 ${catalogTokens} token，超过 ${CATALOG_TOKEN_BUDGET} 预算：${catalogLine}`,
        '把 when 收窄成一句短语（只留触发条件，去掉举例和修饰）'));
    }
  }

  /* ---------- 2. 四段结构 ---------- */

  const sections = splitSections(markdown);
  const byKey = new Map();
  for (const section of sections) {
    if (!section.key) continue;
    if (!byKey.has(section.key)) byKey.set(section.key, []);
    byKey.get(section.key).push(section);
  }

  const present = [];
  for (const def of SECTION_DEFS) {
    const matches = byKey.get(def.key) || [];
    if (matches.length === 0) {
      issues.push(makeIssue('SECTION_MISSING', def.label,
        `缺少「${def.label}」段`,
        `按固定顺序补上 ${SECTION_ORDER_HINT}`));
      continue;
    }
    if (matches.length > 1) {
      issues.push(makeIssue('SECTION_DUPLICATE', def.label,
        `「${def.label}」出现了 ${matches.length} 次`,
        '合并成一段，避免模型读到互相矛盾的内容'));
    }
    const wrongLevel = matches.filter((section) => section.level !== 2);
    if (wrongLevel.length > 0) {
      issues.push(makeIssue('SECTION_LEVEL', def.label,
        `「${def.label}」的标题层级是 ${'#'.repeat(wrongLevel[0].level)}，应为 ##`,
        '四段标题统一用 ##（二级标题）'));
    }
    present.push({ def, section: matches[0], index: sections.indexOf(matches[0]) });
  }

  const order = present.slice().sort((a, b) => a.index - b.index);
  const expectedOrder = SECTION_DEFS.map((def) => def.label).filter((label) => present.some((item) => item.def.label === label));
  const actualOrder = order.map((item) => item.def.label);
  if (present.length === SECTION_DEFS.length && actualOrder.join('|') !== expectedOrder.join('|')) {
    issues.push(makeIssue('SECTION_ORDER', 'sections',
      `四段顺序错误：实际是「${actualOrder.join(' → ')}」`,
      SECTION_ORDER_HINT));
  }

  /* ---------- 2b. 各段内容 ---------- */

  const sectionOf = (key) => (byKey.get(key) || [])[0] || null;

  const whenSection = sectionOf('when');
  if (whenSection) {
    const lines = contentLines(whenSection.lines);
    if (lines.length === 0) {
      issues.push(makeIssue('SECTION_EMPTY', '何时用', '「何时用」是空的', '写 1~2 条触发条件，与 module.yaml 的 when 一致'));
    } else if (lines.length > MAX_SECTION_LINES) {
      issues.push(makeIssue('SECTION_TOO_LONG', 'when',
        `「何时用」有 ${lines.length} 行，超过 ${MAX_SECTION_LINES} 行`,
        '合并成 1~2 行，只留触发条件'));
    }
  }

  const notWhenSection = sectionOf('not_when');
  if (notWhenSection) {
    const lines = contentLines(notWhenSection.lines);
    if (lines.length === 0) {
      issues.push(makeIssue('NOT_WHEN_EMPTY', 'not_when',
        '「何时不用」是空的（必填）',
        '写 1~2 条排除条件，说明什么情况下不要用这个模块'));
    } else if (lines.length > MAX_SECTION_LINES) {
      issues.push(makeIssue('SECTION_TOO_LONG', 'not_when',
        `「何时不用」有 ${lines.length} 行，超过 ${MAX_SECTION_LINES} 行`,
        '合并成 1~2 行，只留排除条件'));
    }
  }

  /* ---------- 3. 输入 / 输出表 ---------- */

  const ioSection = sectionOf('io');
  const table = ioSection ? parseFieldTable(ioSection.lines) : { rows: [], raw: 0 };
  if (!ioSection) {
    /* 缺段已在上面报过 */
  } else if (table.raw === 0) {
    issues.push(makeIssue('TABLE_MISSING', '输入 / 输出',
      '「输入 / 输出」段里没有表格',
      '补表：| 字段 | 类型 |，一行一个字段，输出字段名前加 →'));
  } else if (table.rows.length === 0) {
    issues.push(makeIssue('TABLE_EMPTY', '输入 / 输出',
      '「输入 / 输出」表只有表头，没有字段行',
      '至少写一行字段：| query | string |'));
  } else {
    const noType = table.rows.filter((row) => !row.type);
    for (const row of noType) {
      issues.push(makeIssue('TABLE_ROW_INVALID', row.name,
        `字段「${row.name}」缺少类型`,
        '补上类型列（string / int / bool / object / array）'));
    }
  }

  /* ---------- 4. 例子 ---------- */

  const exampleSection = sectionOf('example');
  if (exampleSection) {
    const exampleLines = parseExampleLines(exampleSection.lines);
    const nonEmpty = exampleLines.filter((line) => line.trim());
    if (nonEmpty.length === 0) {
      issues.push(makeIssue('EXAMPLE_EMPTY', '例子', '「例子」段没有内容', '放一个 ≤3 行的调用示例，参数名与上表一致'));
    } else if (nonEmpty.length > MAX_EXAMPLE_LINES) {
      issues.push(makeIssue('EXAMPLE_TOO_LONG', '例子',
        `例子有 ${nonEmpty.length} 行，超过 ${MAX_EXAMPLE_LINES} 行`,
        '只留 1 条调用 + 1 行结果，删掉其它变体'));
    }

    if (nonEmpty.length > 0 && table.rows.length > 0) {
      const allowed = new Set();
      for (const row of table.rows) {
        for (const alias of fieldAliases(row.name)) allowed.add(alias);
      }
      const fieldNames = table.rows.map((row) => row.rawName || row.name).join(' / ');
      const { inputNames, outputNames } = extractExampleNames(nonEmpty);
      const isKnown = (name) => allowed.has(name) || allowed.has(name.replace(/^_+|_+$/g, ''));

      for (const name of inputNames) {
        if (isKnown(name)) continue;
        issues.push(makeIssue('EXAMPLE_PARAM_UNKNOWN', '例子',
          `例子里的参数「${name}」不在「输入 / 输出」表里`,
          `改成表中的字段名（${fieldNames}），或把该字段补进表格`));
      }
      for (const name of outputNames) {
        if (isKnown(name)) continue;
        issues.push(makeIssue('EXAMPLE_PARAM_UNKNOWN', '例子',
          `例子里的输出字段「${name}」不在「输入 / 输出」表里`,
          `在表里补一行「→ ${name}」并注明类型，或改成表中已有的输出字段（${fieldNames}）`));
      }
    }
  }

  /* ---------- 5. 禁词 / 形容词堆砌 ---------- */

  const banned = findBanned(markdown);
  for (const word of banned) {
    const section = sections.find((item) => item.key && item.lines.some((line) => line.includes(word)));
    issues.push(makeIssue('BANNED_WORD', section ? section.label : '全文',
      `出现禁用词「${word}」`,
      BANNED_HINTS[word] || '改成中性表达'));
  }

  const stacks = findAdjectiveStack(markdown);
  for (const stack of stacks) {
    issues.push(makeIssue('ADJ_STACK', '全文',
      `疑似形容词堆砌：${stack.join('、')}`,
      '删掉修饰，只保留可验证的动作和字段'));
  }

  /* ---------- 6. 触发条件重叠 ---------- */

  if (whenText) {
    const siblings = siblingModules(target);
    for (const sibling of siblings) {
      const otherYaml = readYamlLite(sibling.dir);
      const otherWhen = otherYaml && otherYaml.data ? asText(otherYaml.data.when) : '';
      if (!otherWhen) continue;
      const result = triggersOverlap(whenText, otherWhen);
      if (!result.overlap) continue;
      issues.push(makeIssue('TRIGGER_OVERLAP', 'when',
        `触发条件与模块「${sibling.name}」重叠（${result.kind}，相似度 ${result.score.toFixed(2)}）`,
        `把本模块 when 收窄到独有场景，或与「${sibling.name}」的触发条件明确区分（不自动合并）`));
    }
  }

  return { ok: issues.length === 0, issues, tokens };
}

module.exports = {
  lint,
  triggersOverlap,
  countTokens,
  tokenSource,
  README_TOKEN_BUDGET,
  CATALOG_TOKEN_BUDGET,
  BANNED_WORDS,
};
