'use strict';

/**
 * readme-gen.js — 模块 README（决策卡）生成器
 *
 * 输入：modules/<name>/module.yaml + 可选的入口信息
 * 输出：固定四段、顺序不可变的决策卡
 *
 *   ## 何时用        ≤2 行，取自 when
 *   ## 何时不用      必填，≤2 行，取自 not_when
 *   ## 输入 / 输出   表格，只写字段名 + 类型，不写散文
 *   ## 例子          ≤3 行，参数必须与输入字段一致
 *
 * 禁止词（强大/全面/高效/赋能/一站式/首先/其次/总之）在生成时替换为中性表达；
 * 禁止功能罗列与安装说明。
 * 生成后统计 token（预算 600）：超预算先压缩例子、再压缩措辞，
 * 每步修改都写进 report.trimmed。本文件只生成内容，不写盘。
 *
 * 依赖约定：
 *   - lib/tokens.js 存在且可用时用它的估算；否则本地回退：cjk×1.1 + 其它/4，向上取整
 *   - lib/yaml.js 存在且可解析时用它的 parse；否则用本文件的容错解析（支持列表/行内注释）
 */

const fs = require('fs');
const path = require('path');

const TOKEN_BUDGET = 600;
const MAX_SECTION_LINES = 2;
const MAX_EXAMPLE_LINES = 3;

/* ================================================================== *
 * 1. token 估算（优先 lib/tokens.js，失败回退）
 * ================================================================== */

const CJK_RANGES = [
  [0x3000, 0x303f], // CJK 标点
  [0x3040, 0x30ff], // 日文假名
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本汉字
  [0xac00, 0xd7af], // 谚文
  [0xf900, 0xfaff], // 兼容汉字
  [0xff00, 0xffef], // 全角字符
];

/** 本地回退估算：cjk×1.1 + 其它/4，向上取整。 */
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

let tokenFn = null;
let tokenFnResolved = false;
let tokenSourceName = 'local-fallback(cjk*1.1+other/4)';

function numberOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['tokens', 'count', 'value', 'total']) {
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key];
    }
  }
  return null;
}

/** 探测 lib/tokens.js 暴露的估算函数（兼容多种导出形态）；找不到返回 null。 */
function resolveTokenFn() {
  if (tokenFnResolved) return tokenFn;
  tokenFnResolved = true;

  let mod = null;
  try {
    mod = require('./tokens.js');
  } catch (_) {
    return null;
  }
  if (!mod) return null;

  const candidates = [];
  if (typeof mod === 'function') {
    candidates.push([mod, 'module']);
  } else if (typeof mod === 'object') {
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
    const probeValue = numberOf(probe);
    if (probeValue === null || !(probeValue > 0)) continue;
    tokenFn = (text) => {
      const value = numberOf(fn(String(text)));
      if (value === null) throw new Error('tokens.js 返回了非数字');
      return value;
    };
    tokenSourceName = 'lib/tokens.js#' + name;
    return tokenFn;
  }
  return null;
}

/** 统计 token；外部实现抛错/返回非数字时回退本地算法。 */
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

/** 当前实际使用的估算来源（自测/汇报用）。 */
function tokenSource() {
  resolveTokenFn();
  return tokenSourceName;
}

/* ================================================================== *
 * 2. YAML 读取（优先 lib/yaml.js，失败用本地容错解析）
 * ================================================================== */

function safeRequireYaml() {
  try {
    const mod = require('./yaml.js');
    return mod && typeof mod === 'object' ? mod : null;
  } catch (_) {
    return null;
  }
}

function looksLikeModule(data) {
  return Boolean(data) && typeof data === 'object' && !Array.isArray(data)
    && (typeof data.name === 'string' || typeof data.when === 'string' || typeof data.not_when === 'string'
      || (typeof data.entry === 'object' && data.entry !== null));
}

/** 尝试外部 yaml 解析器；不可用/抛错/结果不像 module.yaml 时返回 null。 */
function tryExternalYaml(text, filePath) {
  const mod = safeRequireYaml();
  if (!mod) return null;

  const attempts = [];
  if (typeof mod === 'function') attempts.push(() => mod(text));
  const pick = (names, arg) => {
    for (const name of names) {
      if (typeof mod[name] === 'function') attempts.push(() => mod[name](arg));
    }
  };
  if (filePath) pick(['parseFile', 'loadFile', 'readFile', 'readYamlFile'], filePath);
  pick(['parse', 'load', 'parseYaml', 'parseText', 'parseYamlText', 'parseModule', 'read'], text);

  for (const attempt of attempts) {
    let result;
    try {
      result = attempt();
    } catch (_) {
      continue;
    }
    if (looksLikeModule(result)) return result;
  }
  return null;
}

/* --------------------- 本地容错 YAML 子集解析 --------------------- */

function findColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) return i;
  }
  return -1;
}

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

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === '') return '';

  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'");
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\(["\\ntr])/g, (whole, ch) => {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === 'r') return '\r';
        return ch;
      });
    }
  }

  if (value[0] === '[' && value[value.length - 1] === ']') {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => parseScalar(item));
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (/^[+-]?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * 本地容错解析（只在 lib/yaml.js 不可用时兜底）：
 * 支持 1~3 层映射、`- ` 列表（含列表内映射）、行内注释、`|` / `>` 块。
 */
function parseYamlFallback(text) {
  const source = text === undefined || text === null ? '' : String(text);
  const rawLines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const items = [];

  for (let lineNo = 0; lineNo < rawLines.length; lineNo += 1) {
    const raw = rawLines[lineNo];
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue;
    const pad = /^[ \t]*/.exec(raw)[0].replace(/\t/g, '  ');
    items.push({ indent: pad.length, body: raw.slice(/^[ \t]*/.exec(raw)[0].length), lineNo });
  }

  let pos = 0;
  const isList = (item) => item.body === '-' || item.body.startsWith('- ');

  function parseNode(indent) {
    if (pos >= items.length) return '';
    return isList(items[pos]) ? parseList(indent) : parseMap(indent);
  }

  function parseBlockScalar(indent, style) {
    const parts = [];
    while (pos < items.length && items[pos].indent > indent) {
      parts.push(items[pos].body);
      pos += 1;
    }
    return style[0] === '>' ? parts.join(' ') : parts.join('\n');
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < items.length && items[pos].indent === indent && !isList(items[pos])) {
      const item = items[pos];
      const colon = findColon(item.body);
      pos += 1;
      if (colon < 0) continue;
      const key = item.body.slice(0, colon).trim();
      const rest = stripInlineComment(item.body.slice(colon + 1)).trim();
      if (!key) continue;

      if (rest === '') {
        if (pos < items.length && items[pos].indent > indent) {
          obj[key] = parseNode(items[pos].indent);
        } else if (pos < items.length && items[pos].indent === indent && isList(items[pos])) {
          obj[key] = parseList(indent);
        } else {
          obj[key] = '';
        }
      } else if (/^[|>][+-]?$/.test(rest)) {
        obj[key] = parseBlockScalar(indent, rest);
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (pos < items.length && items[pos].indent === indent && isList(items[pos])) {
      const item = items[pos];
      const rest = item.body.replace(/^-\s*/, '');
      pos += 1;

      if (rest === '') {
        if (pos < items.length && items[pos].indent > indent) arr.push(parseNode(items[pos].indent));
        else arr.push('');
        continue;
      }

      const colon = findColon(rest);
      const isMapping = colon > 0 && rest[0] !== '"' && rest[0] !== "'";
      if (isMapping) {
        const entry = {};
        const key = rest.slice(0, colon).trim();
        const value = stripInlineComment(rest.slice(colon + 1)).trim();
        entry[key] = value === '' ? '' : parseScalar(value);
        if (pos < items.length && items[pos].indent > indent) {
          const nested = parseMap(items[pos].indent);
          Object.assign(entry, nested);
        }
        arr.push(entry);
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  return parseNode(0);
}

/** 读取并解析 module.yaml；返回 { file, text, data } 或 null。 */
function readModuleYaml(moduleDir) {
  for (const fileName of ['module.yaml', 'module.yml']) {
    const file = path.join(moduleDir, fileName);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    let data = tryExternalYaml(text, file);
    if (!data) {
      try {
        data = parseYamlFallback(text);
      } catch (_) {
        data = null;
      }
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) return { file, text, data };
    return { file, text, data: null };
  }
  return null;
}

/* ================================================================== *
 * 3. 禁词替换
 * ================================================================== */

/** 禁止词 → 中性表达 */
const BANNED_REPLACEMENTS = [
  ['强大', '够用'],
  ['全面', '完整'],
  ['高效', '直接'],
  ['赋能', '支持'],
  ['一站式', '集中'],
  ['首先', '先'],
  ['其次', '再'],
  ['总之', '合起来看'],
];

const BANNED_WORDS = BANNED_REPLACEMENTS.map((pair) => pair[0]);

/** 把命中禁词的文字换成中性表达；命中记录写入 trimmed。 */
function scrubBanned(text, where, trimmed) {
  let out = String(text === undefined || text === null ? '' : text);
  if (!out) return out;
  for (const [bad, good] of BANNED_REPLACEMENTS) {
    if (!out.includes(bad)) continue;
    out = out.split(bad).join(good);
    trimmed.push(`禁词替换（${where}）：「${bad}」→「${good}」`);
  }
  return out;
}

/* ================================================================== *
 * 4. 字段与例子
 * ================================================================== */

const TYPE_ALIASES = {
  string: 'string', str: 'string', text: 'string', 字符串: 'string',
  int: 'int', integer: 'int', 整数: 'int',
  number: 'number', float: 'number', double: 'number', 数字: 'number',
  bool: 'bool', boolean: 'bool', 布尔: 'bool',
  object: 'object', map: 'object', dict: 'object', 对象: 'object',
  array: 'array', list: 'array', 数组: 'array',
};

function normalizeType(raw) {
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim().toLowerCase();
  return TYPE_ALIASES[key] || null;
}

/** 归一化参数字段列表；保留顺序、去重、类型未知时按 string 并记 warning。 */
function normalizeFields(list, kind, warnings) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    let name = '';
    let typeRaw = '';
    if (typeof raw === 'string') {
      name = raw;
    } else if (raw && typeof raw === 'object') {
      name = raw.name || raw.field || raw.key || '';
      typeRaw = raw.type || raw.kind || '';
    }
    name = String(name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let type = normalizeType(typeRaw);
    if (!type) {
      warnings.push(`${kind}字段「${name}」的类型${typeRaw ? `（${typeRaw}）` : ''}无法识别，已按 string 处理`);
      type = 'string';
    }
    out.push({ name, type });
  }
  return out;
}

function sampleJson(type) {
  switch (type) {
    case 'bool': return 'true';
    case 'int':
    case 'number': return '0';
    case 'array': return '[]';
    case 'object': return '{}';
    default: return '"示例"';
  }
}

function sampleCli(type, powershell) {
  switch (type) {
    case 'bool': return powershell ? '$true' : 'true';
    case 'int':
    case 'number': return '5';
    case 'array': return '[]';
    case 'object': return '{}';
    default: return '"示例"';
  }
}

/**
 * 从 entry 名称 + 字段拼一个 ≤3 行的例子。
 * 命令行工具用 --flag / -Flag 形式，保证参数名与「输入 / 输出」表一致。
 */
function buildExample(entry, params, returns) {
  const entryName = String((entry && entry.name) || '').trim();
  const base = entryName.split(/[\\/]/).pop() || entryName;
  const isPs = /\.ps1$/i.test(base);
  const isCmd = /\.(cmd|bat)$/i.test(base);
  const isScript = /\.(js|mjs|cjs|ts)$/i.test(base);

  let invoke;
  if (isScript) invoke = 'node ' + (entryName || base);
  else if (isPs || isCmd) invoke = '.\\' + base;
  else invoke = entryName || base || 'entry';

  const args = [];
  for (const field of params.slice(0, 3)) {
    const flagName = field.name.replace(/_/g, '-');
    if (isPs) {
      const shown = field.name.charAt(0).toUpperCase() + field.name.slice(1);
      args.push('-' + shown + ' ' + sampleCli(field.type, true));
    } else if (isCmd || isScript) {
      args.push('--' + flagName + ' ' + sampleCli(field.type, false));
    } else {
      args.push(field.name + '=' + sampleCli(field.type, false));
    }
  }

  const lines = [[invoke].concat(args).join(' ')];
  const firstReturn = returns[0];
  lines.push(firstReturn ? `→ {${JSON.stringify(firstReturn.name)}:${sampleJson(firstReturn.type)}}` : '→ ok');
  return lines.slice(0, MAX_EXAMPLE_LINES);
}

/* ================================================================== *
 * 5. 四段渲染
 * ================================================================== */

/** 把 when / not_when 拆成 ≤2 行；多于 2 段时合并到第 2 行，避免丢信息。 */
function toSectionLines(text) {
  const source = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const parts = source
    .split(/[；;。\n]+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length > MAX_SECTION_LINES) {
    return [parts[0], parts.slice(1).join('；')];
  }
  return parts;
}

function renderState(state) {
  const out = [];
  out.push('# ' + state.name, '');
  out.push('## 何时用', '');
  for (const line of state.whenLines) out.push('- ' + line);
  out.push('');
  out.push('## 何时不用', '');
  for (const line of state.notWhenLines) out.push('- ' + line);
  out.push('');
  out.push('## 输入 / 输出', '');
  out.push('| 字段 | 类型 |');
  out.push('| --- | --- |');
  for (const field of state.params) out.push('| ' + field.name + ' | ' + field.type + ' |');
  for (const field of state.returns) out.push('| → ' + field.name + ' | ' + field.type + ' |');
  out.push('');
  out.push('## 例子', '');
  out.push('```text');
  for (const line of state.exampleLines) out.push(line);
  out.push('```');
  out.push('');
  return out.join('\n');
}

/* ------------------------------- 压缩 ------------------------------- */

function truncateSectionLines(state, key, limit) {
  let changed = false;
  state[key] = state[key].map((line) => {
    if (line.length <= limit) return line;
    changed = true;
    return line.slice(0, limit).replace(/[\s，,、；;]+$/, '') + '…';
  });
  return changed;
}

/** 例子命令行超长时按空白截断，避免留下半个 --flag 造成参数名对不上。 */
function truncateExampleLine(state, limit) {
  const line = state.exampleLines[0];
  if (!line || line.length <= limit) return false;
  let cut = line.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  if (space > 0) cut = cut.slice(0, space);
  state.exampleLines[0] = cut.replace(/\s+$/, '') + ' …';
  return true;
}

const COMPRESSION_STEPS = [
  { label: '压缩例子：删掉输出行，只留调用', run: (state) => {
    if (state.exampleLines.length <= 1) return false;
    state.exampleLines = state.exampleLines.slice(0, 1);
    return true;
  } },
  { label: '压缩措辞：何时用截断到 36 字', run: (state) => truncateSectionLines(state, 'whenLines', 36) },
  { label: '压缩措辞：何时不用截断到 36 字', run: (state) => truncateSectionLines(state, 'notWhenLines', 36) },
  { label: '压缩措辞：何时用只保留首条', run: (state) => {
    if (state.whenLines.length <= 1) return false;
    state.whenLines = state.whenLines.slice(0, 1);
    return true;
  } },
  { label: '压缩措辞：何时不用只保留首条', run: (state) => {
    if (state.notWhenLines.length <= 1) return false;
    state.notWhenLines = state.notWhenLines.slice(0, 1);
    return true;
  } },
  { label: '压缩例子：命令行截断到 60 字', run: (state) => truncateExampleLine(state, 60) },
];

/* ================================================================== *
 * 6. 生成入口
 * ================================================================== */

function emptyReport() {
  return { trimmed: [], warnings: [] };
}

function fail(message) {
  const report = emptyReport();
  report.warnings.push(message);
  return { ok: false, content: '', tokens: 0, report };
}

/**
 * 生成模块 README 内容（不写盘）。
 *
 * @param {string} moduleDir 模块目录（含 module.yaml）
 * @param {{entryInfo?: {params?: Array, returns?: Array, inputs?: Array, outputs?: Array}}} [options]
 * @returns {{ok: boolean, content: string, tokens: number,
 *            report: {trimmed: string[], warnings: string[]}}}
 */
function generate(moduleDir, options = {}) {
  const trimmed = [];
  const warnings = [];
  const dir = path.resolve(String(moduleDir || '.'));

  const yaml = readModuleYaml(dir);
  if (!yaml) {
    return fail(`未找到 module.yaml：${dir}`);
  }
  if (!yaml.data) {
    return fail(`module.yaml 解析失败：${yaml.file}`);
  }
  const data = yaml.data;

  const entryRaw = data.entry;
  const entry = typeof entryRaw === 'string'
    ? { type: 'cmd', name: entryRaw }
    : (entryRaw && typeof entryRaw === 'object' ? entryRaw : {});

  let name = String(data.name || path.basename(dir)).trim();
  if (!data.name) warnings.push('module.yaml 缺少 name，已用目录名代替');
  name = scrubBanned(name, 'name', trimmed);

  const whenRaw = data.when === undefined || data.when === null ? '' : String(data.when);
  const notWhenRaw = data.not_when === undefined || data.not_when === null ? '' : String(data.not_when);

  if (!whenRaw.trim()) {
    warnings.push('module.yaml 缺少 when，已用占位触发条件（应补真实触发条件）');
  }
  if (!notWhenRaw.trim()) {
    warnings.push('module.yaml 缺少 not_when，已用中性占位（应补真实排除条件）');
  }

  const whenLines = toSectionLines(scrubBanned(whenRaw, 'when', trimmed));
  if (whenLines.length === 0) {
    whenLines.push('需要调用 ' + (entry.name ? String(entry.name) : name) + ' 时');
  }

  const notWhenLines = toSectionLines(scrubBanned(notWhenRaw, 'not_when', trimmed));
  if (notWhenLines.length === 0) {
    notWhenLines.push('不满足「何时用」中的任一条件时');
  }

  const info = options && typeof options.entryInfo === 'object' && options.entryInfo !== null
    ? options.entryInfo
    : {};
  const pickList = (...values) => values.find((value) => Array.isArray(value));

  let paramsSrc = pickList(info.params, info.inputs, data.params, data.inputs, data.arguments);
  let returnsSrc = pickList(info.returns, info.outputs, data.returns, data.outputs, data.results);

  if (paramsSrc === undefined && returnsSrc === undefined) {
    // 没给入口信息：从 entry 名推一个最小占位
    paramsSrc = [{ name: 'args', type: 'string' }];
    returnsSrc = [{ name: 'ok', type: 'bool' }];
    warnings.push('未提供 entryInfo，按入口名推断占位字段（args:string / ok:bool）；建议传入真实 params/returns');
  }

  let params = normalizeFields(paramsSrc, '参数', warnings);
  let returns = normalizeFields(returnsSrc, '输出', warnings);

  if (params.length === 0 && returns.length === 0) {
    params = [{ name: 'args', type: 'string' }];
    returns = [{ name: 'ok', type: 'bool' }];
    warnings.push('入口字段为空，已用最小占位（args:string / ok:bool），否则「输入 / 输出」表无内容');
  }

  const state = {
    name,
    whenLines,
    notWhenLines,
    params,
    returns,
    exampleLines: buildExample(entry, params, returns),
  };

  let content = renderState(state);
  let tokens = countTokens(content);

  // 最后的兜底：确保渲染结果里没有禁词
  const scrubbed = scrubBanned(content, '全文', trimmed);
  if (scrubbed !== content) {
    content = scrubbed;
    tokens = countTokens(content);
  }

  // 超预算：先压缩例子，再压缩措辞；每步写入 trimmed
  for (const step of COMPRESSION_STEPS) {
    if (tokens <= TOKEN_BUDGET) break;
    const before = tokens;
    let applied = false;
    try {
      applied = step.run(state);
    } catch (_) {
      applied = false;
    }
    if (!applied) continue;
    content = renderState(state);
    const again = scrubBanned(content, '全文', trimmed);
    content = again;
    tokens = countTokens(content);
    trimmed.push(`${step.label}（${before} → ${tokens} token）`);
  }

  if (tokens > TOKEN_BUDGET) {
    warnings.push(`压缩后仍超预算：${tokens} > ${TOKEN_BUDGET} token，需人工精简`);
  }

  return {
    ok: Boolean(content) && tokens <= TOKEN_BUDGET,
    content,
    tokens,
    report: { trimmed, warnings },
  };
}

module.exports = {
  generate,
  countTokens,
  tokenSource,
  BANNED_WORDS,
  TOKEN_BUDGET,
};
