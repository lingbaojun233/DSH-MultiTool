#!/usr/bin/env node
'use strict';

/**
 * registry/tests/triggers.js — 模块触发测试集批量评测
 *
 * 用法：
 *   node tests/triggers.js                  dry 模式：本地关键词启发式，不调模型
 *   node tests/triggers.js --live           调真实模型（io.run）逐条判定
 *   node tests/triggers.js --limit 3        只跑前 3 条
 *   node tests/triggers.js --json           机器可读输出（stdout 只有 JSON）
 *   node tests/triggers.js --file <path>    自测用：换一份测试集
 *
 * 指标：
 *   漏触发 = expect≠none 但判定 none / expect≠none
 *   误触发 = expect=none 但判定非 none / expect=none
 *   错配   = expect≠判定且都不是 none / expect≠none
 * 达标线：漏触发 <5%、误触发 <10%（error 用例不进入分母，单独计数）。
 *
 * 目录行来源：优先 registry/lib/catalog.js 的 render()；
 * 该文件不存在或不可用时，回退到本文件内置的最小渲染（按 name 排序，
 * 输出 "- <name> — <when>"），并在输出里标明来源。
 */

const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const REGISTRY_DIR = path.join(TESTS_DIR, '..');
const MODULES_DIR = path.join(REGISTRY_DIR, 'modules');
const DEFAULT_TESTS_FILE = path.join(TESTS_DIR, 'triggers.yaml');
const IO_PATH = path.join(REGISTRY_DIR, '..', 'io', 'io.js');

const KNOWN_MODULES = ['memory', 'deploy', 'panel'];
const EXPECT_VALUES = ['memory', 'deploy', 'panel', 'none'];
const EXPECTED_DISTRIBUTION = { memory: 10, deploy: 8, panel: 5, none: 7 };

const MISS_MAX = 0.05;
const FALSE_MAX = 0.10;
const CASE_TIMEOUT_MS = 60000;
const LIVE_HARD_TIMEOUT_MS = 75000;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function usage() {
  process.stdout.write(
    [
      '模块触发测试集 · 批量评测',
      '',
      '  node tests/triggers.js                  dry 模式（本地关键词，不调模型）',
      '  node tests/triggers.js --live           调真实模型逐条判定',
      '  node tests/triggers.js --limit N        只跑前 N 条',
      '  node tests/triggers.js --json           输出 JSON（stdout 仅 JSON）',
      '  node tests/triggers.js --file <path>    自测用：指定测试集文件',
      '',
      '达标线：漏触发 <5%，误触发 <10%；每条 live 用例限时 60s。',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const opts = { live: false, json: false, limit: null, file: DEFAULT_TESTS_FILE, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') opts.live = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg === '--limit' ? argv[i + 1] : arg.slice('--limit='.length);
      if (arg === '--limit') i += 1;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) errors.push(`--limit 需要正整数，收到：${raw === undefined ? '(空)' : raw}`);
      else opts.limit = n;
    } else if (arg === '--file' || arg.startsWith('--file=')) {
      const raw = arg === '--file' ? argv[i + 1] : arg.slice('--file='.length);
      if (arg === '--file') i += 1;
      if (!raw) errors.push('--file 需要一个路径');
      else opts.file = path.resolve(process.cwd(), raw);
    } else {
      errors.push(`未知参数：${arg}`);
    }
  }
  return { opts, errors };
}

// ---------------------------------------------------------------------------
// 测试集解析（零依赖的最小 YAML 子集解析）
// ---------------------------------------------------------------------------

function cleanScalar(raw) {
  let value = String(raw === undefined ? '' : raw).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
  }
  return value;
}

/** 解析形如 cases: [{id, text, expect}] 的扁平 YAML；不支持嵌套与多行。 */
function parseTriggersYaml(text, file) {
  const cases = [];
  let current = null;
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (/^cases\s*:\s*$/.test(trimmed)) return;

    const item = /^\s*-\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (item) {
      current = {};
      cases.push(current);
      current[item[1]] = cleanScalar(item[2]);
      return;
    }

    const kv = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv && current) {
      current[kv[1]] = cleanScalar(kv[2]);
      return;
    }

    throw new Error(`${path.basename(file)}:${index + 1} 无法解析：${trimmed}`);
  });

  return cases;
}

function validateCases(cases) {
  const errors = [];
  const seen = new Set();

  cases.forEach((item, index) => {
    const where = `第 ${index + 1} 条${item.id ? `（${item.id}）` : ''}`;
    if (!item.id) errors.push(`${where} 缺少 id`);
    else if (seen.has(item.id)) errors.push(`${where} id 重复：${item.id}`);
    else seen.add(item.id);

    if (!item.text || !String(item.text).trim()) errors.push(`${where} 缺少 text`);
    if (!EXPECT_VALUES.includes(item.expect)) {
      errors.push(`${where} expect 非法：${item.expect || '(空)'}，只能是 ${EXPECT_VALUES.join(' / ')}`);
    }
  });

  return errors;
}

function countDistribution(cases) {
  const counts = {};
  for (const value of EXPECT_VALUES) counts[value] = 0;
  for (const item of cases) {
    if (counts[item.expect] !== undefined) counts[item.expect] += 1;
  }
  return counts;
}

function checkDistribution(cases) {
  const counts = countDistribution(cases);
  const problems = [];
  for (const value of EXPECT_VALUES) {
    const want = EXPECTED_DISTRIBUTION[value];
    const got = counts[value] || 0;
    if (got !== want) problems.push(`${value} 期望 ${want} 条，实际 ${got} 条`);
  }
  return { counts, ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 目录：优先 lib/catalog.js，否则内置最小渲染
// ---------------------------------------------------------------------------

function readModuleMeta(file) {
  const meta = {};
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!match || match[2] === '') continue; // 跳过 entry: 之类的嵌套父键
    meta[match[1]] = cleanScalar(match[2]);
  }
  return meta;
}

/** 内置最小渲染：按 name 排序，每行 "- <name> — <when>"。 */
function renderCatalogBuiltin() {
  const modules = [];
  if (!fs.existsSync(MODULES_DIR)) return modules;

  for (const entry of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const yamlPath = path.join(MODULES_DIR, entry.name, 'module.yaml');
    if (!fs.existsSync(yamlPath)) continue;
    const meta = readModuleMeta(yamlPath);
    const name = meta.name || entry.name;
    const when = meta.when || '';
    modules.push({ name, when, line: `- ${name} — ${when}` });
  }

  modules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return modules;
}

function loadCatalog() {
  const local = renderCatalogBuiltin();
  const libPath = path.join(REGISTRY_DIR, 'lib', 'catalog.js');
  const builtin = {
    source: 'builtin',
    note: fs.existsSync(libPath) ? '' : 'lib/catalog.js 不存在，使用内置最小渲染',
    modules: local,
  };

  if (!local.length) return { ...builtin, note: 'modules/ 下没有可用的 module.yaml' };
  if (!fs.existsSync(libPath)) return builtin;

  try {
    const lib = require(libPath);
    if (!lib || typeof lib.render !== 'function') {
      return { ...builtin, note: 'lib/catalog.js 未导出 render()，回退内置最小渲染' };
    }
    const rendered = lib.render();
    const text = typeof rendered === 'string' ? rendered : (rendered && typeof rendered.text === 'string' ? rendered.text : null);
    if (!text) return { ...builtin, note: 'lib/catalog.js 的 render() 未返回文本，回退内置最小渲染' };

    const lineByName = new Map();
    for (const raw of text.split(/\r?\n/)) {
      const trimmed = raw.trim();
      const match = /^-\s+([A-Za-z0-9_.-]+)\s+[—–-]\s+(.+)$/.exec(trimmed);
      if (match) lineByName.set(match[1], trimmed);
    }

    const merged = local.map((item) => ({ ...item, line: lineByName.get(item.name) || item.line }));
    return { source: 'lib/catalog.js', note: '', modules: merged };
  } catch (err) {
    return { ...builtin, note: `lib/catalog.js 加载失败（${err.message}），回退内置最小渲染` };
  }
}

// ---------------------------------------------------------------------------
// dry 模式：本地关键词启发式
// ---------------------------------------------------------------------------

/**
 * 规则按优先级排列：先面板（"查看历史对话"最具体），再 deploy，最后 memory。
 * 这只是自查用的粗略分类器，live 模式以真实模型为准。
 */
const DRY_RULES = [
  {
    module: 'panel',
    label: '面板/网页/浏览器/界面/渲染/历史对话/对话记录',
    re: /面板|网页|浏览器|界面|渲染|对话记录|历史对话/,
  },
  {
    module: 'deploy',
    label: '部署/上传/传到/服务器/远端/远程/发布/重启/线上/同步到/scp/rsync/nginx',
    re: /部署|上传|传到|服务器|远端|远程|发布|重启|线上|同步到|\bscp\b|\brsync\b|nginx/i,
  },
  {
    module: 'memory',
    label: '记得/回忆/上次/上回/之前/以前/说过/提过/记住/老规矩/偏好/印象',
    re: /记得|记不清|回忆|上次|上回|之前|以前|说过|提过|记住|老规矩|偏好|印象|存过/,
  },
];

function classifyDry(text) {
  const hits = [];
  for (const rule of DRY_RULES) {
    const match = String(text).match(rule.re);
    if (match) hits.push({ module: rule.module, label: rule.label, word: match[0] });
  }
  return { judged: hits.length ? hits[0].module : 'none', hits, answer: null, error: null };
}

// ---------------------------------------------------------------------------
// live 模式：真实模型
// ---------------------------------------------------------------------------

function buildLivePrompt(catalog, text) {
  const names = catalog.modules.map((item) => item.name);
  return [
    '[模块目录]',
    ...catalog.modules.map((item) => item.line),
    '',
    `用户问法：${text}`,
    '',
    `任务：判断这句问法该用哪个模块。只输出一个模块名（${names.join(' / ')}）或 none，不要解释，也不要调用任何工具。`,
    '如果三个模块都不需要，只输出 none。',
  ].join('\n');
}

/** 从模型回答里取第一个出现的模块名；取不到就记 none。 */
function parseModuleAnswer(answer, moduleNames) {
  const text = String(answer || '').toLowerCase();
  let best = null;
  for (const name of moduleNames) {
    const re = new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`);
    const match = re.exec(text);
    if (!match) continue;
    const index = match.index + match[1].length;
    if (!best || index < best.index) best = { index, name };
  }
  return best ? best.name : 'none';
}

function withHardTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function classifyLive(io, catalog, item) {
  const startedAt = Date.now();
  const prompt = buildLivePrompt(catalog, item.text);
  const moduleNames = catalog.modules.map((entry) => entry.name);

  try {
    const res = await withHardTimeout(
      io.run(prompt, {
        memory: false,
        persona: false,
        timeoutMs: CASE_TIMEOUT_MS,
        cwd: path.join(REGISTRY_DIR, '..'),
      }),
      LIVE_HARD_TIMEOUT_MS,
      `单条硬超时 ${LIVE_HARD_TIMEOUT_MS}ms`,
    );

    const answer = String((res && res.answer) || '').trim();
    const ms = Date.now() - startedAt;

    if (!res || !res.ok) {
      // 有回答（哪怕退出码非 0）就按回答判定；完全没回答才算 error。
      if (!answer) {
        const code = (res && res.code) || 'LIVE_FAILED';
        const detail = (res && (res.error || res.reason)) || '模型调用失败';
        return { judged: null, hits: [], answer, error: `${code}: ${detail}`, ms };
      }
    }

    return { judged: parseModuleAnswer(answer, moduleNames), hits: [], answer, error: null, ms };
  } catch (err) {
    return { judged: null, hits: [], answer: '', error: err.message, ms: Date.now() - startedAt };
  }
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

function summarize(results) {  const counts = { miss: 0, falseTrigger: 0, mismatch: 0, errors: 0 };
  let shouldTrigger = 0;
  let shouldNot = 0;

  for (const item of results) {
    if (item.error || !item.judged) {
      counts.errors += 1;
      continue;
    }
    if (item.expect === 'none') {
      shouldNot += 1;
      if (item.judged !== 'none') counts.falseTrigger += 1;
    } else {
      shouldTrigger += 1;
      if (item.judged === 'none') counts.miss += 1;
      else if (item.judged !== item.expect) counts.mismatch += 1;
    }
  }

  const missRate = shouldTrigger ? counts.miss / shouldTrigger : 0;
  const falseRate = shouldNot ? counts.falseTrigger / shouldNot : 0;
  const mismatchRate = shouldTrigger ? counts.mismatch / shouldTrigger : 0;

  return {
    counts,
    denominators: { shouldTrigger, shouldNot },
    rates: {
      miss: { num: counts.miss, den: shouldTrigger, rate: missRate, threshold: MISS_MAX },
      falseTrigger: { num: counts.falseTrigger, den: shouldNot, rate: falseRate, threshold: FALSE_MAX },
      mismatch: { num: counts.mismatch, den: shouldTrigger, rate: mismatchRate },
    },
    pass: missRate < MISS_MAX && falseRate < FALSE_MAX && counts.errors === 0,
  };
}

function categorize(item) {
  if (item.error || !item.judged) return null;
  if (item.expect !== 'none' && item.judged === 'none') return { rank: 0, label: '该用没用' };
  if (item.expect === 'none' && item.judged !== 'none') return { rank: 1, label: '不该用却用' };
  if (item.expect !== item.judged) return { rank: 2, label: '用错模块' };
  return null;
}

function pickSuspicious(results, catalog, limit = 5) {
  const lineByName = new Map(catalog.modules.map((item) => [item.name, item.line]));
  const picked = [];

  for (const item of results) {
    const category = categorize(item);
    if (!category) continue;

    const hitLines = [];
    for (const hit of item.hits) {
      const line = lineByName.get(hit.module);
      if (line && !hitLines.includes(line)) hitLines.push(line);
    }
    const expectedLine = item.expect !== 'none' ? lineByName.get(item.expect) || null : null;

    picked.push({
      id: item.id,
      text: item.text,
      expect: item.expect,
      judged: item.judged,
      category: category.label,
      rank: category.rank,
      hitLines,
      expectedLine,
      hits: item.hits,
      answer: item.answer || null,
      ms: item.ms || 0,
    });
  }

  picked.sort((a, b) => a.rank - b.rank || b.hitLines.length - a.hitLines.length || a.id.localeCompare(b.id));
  return picked.slice(0, limit);
}

/** 给每条结果补上"命中的目录行"，供 JSON 消费方与失败报告使用。 */
function attachHitLines(results, catalog) {
  const lineByName = new Map(catalog.modules.map((item) => [item.name, item.line]));
  for (const item of results) {
    item.hitLines = [];
    for (const hit of item.hits) {
      const line = lineByName.get(hit.module);
      if (line && !item.hitLines.includes(line)) item.hitLines.push(line);
    }
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

function printCatalog(catalog) {
  const source = catalog.source === 'lib/catalog.js' ? 'lib/catalog.js' : '内置最小渲染';
  process.stdout.write(`[模块目录]（来源：${source}）\n`);
  for (const item of catalog.modules) process.stdout.write(`${item.line}\n`);
  if (catalog.note) process.stdout.write(`注：${catalog.note}\n`);
  process.stdout.write('\n');
}

function printCaseLine(item) {
  const mark = item.error ? 'ERROR' : (item.judged === item.expect ? '✓' : '✗');
  const detail = item.error ? `  ${item.error}` : (item.hits && item.hits.length ? `  命中：${item.hits.map((hit) => hit.word).join(',')}` : '');
  process.stdout.write(`  ${item.id.padEnd(4)} 期望=${item.expect.padEnd(6)} 判定=${String(item.judged || '-').padEnd(6)} ${mark}${detail}\n`);
}

function printSummary(summary, distribution, distributionChecked, opts, catalog, results, suspicious, elapsedMs) {
  process.stdout.write('\n');
  process.stdout.write(
    `共 ${results.length} 条` + (opts.limit ? `（--limit ${opts.limit}）` : '') +
      ` | 分布：memory ${distribution.counts.memory} / deploy ${distribution.counts.deploy} / panel ${distribution.counts.panel} / none ${distribution.counts.none}\n`,
  );
  if (!distributionChecked) {
    process.stdout.write('分布：已启用 --limit，跳过完整性检查（应按全量 30 条检查）\n');
  } else if (distribution.ok) {
    process.stdout.write('分布：符合要求（memory 10 / deploy 8 / panel 5 / none 7）\n');
  } else {
    process.stdout.write(`分布：!! 不符 —— ${distribution.problems.join('；')}\n`);
  }

  const { rates, counts } = summary;
  process.stdout.write('\n');
  const rateLine = (label, entry, thresholdText, limitValue) => {
    if (!entry.den) return `${label}：无有效样本（0 条可判定），不参与达标判定\n`;
    return `${label}：${entry.num}/${entry.den} = ${pct(entry.rate)}  ${thresholdText}  ${entry.rate < limitValue ? '通过' : '未通过'}\n`;
  };
  process.stdout.write(rateLine('漏触发', rates.miss, '目标 <5% ', MISS_MAX));
  process.stdout.write(rateLine('误触发', rates.falseTrigger, '目标 <10%', FALSE_MAX));
  process.stdout.write(rates.mismatch.den ? `错配：  ${rates.mismatch.num}/${rates.mismatch.den} = ${pct(rates.mismatch.rate)}\n` : '错配：  无有效样本\n');
  process.stdout.write(`error： ${counts.errors} 条（不进入三率分母）\n`);
  process.stdout.write(`耗时：  ${(elapsedMs / 1000).toFixed(2)}s\n`);
  process.stdout.write('\n');

  const datasetPass = !distributionChecked || distribution.ok;
  const passed = summary.pass && datasetPass;
  if (passed) {
    process.stdout.write('结论：达标\n');
  } else if (!summary.pass) {
    process.stdout.write('结论：未达标' + (counts.errors ? `（有 ${counts.errors} 条 error，需先修通调用链）` : '') + '\n');
  } else {
    process.stdout.write('结论：未达标（数据集分布不符合要求）\n');
  }

  const errors = results.filter((item) => item.error);
  if (errors.length) {
    process.stdout.write('\nerror 用例：\n');
    for (const item of errors.slice(0, 10)) process.stdout.write(`  ${item.id}: ${item.error}\n`);
    if (errors.length > 10) process.stdout.write(`  ... 还有 ${errors.length - 10} 条\n`);
  }

  if (suspicious.length) {
    process.stdout.write('\n最可疑 5 条（该用没用 / 不该用却用 优先）：\n');
    suspicious.forEach((item, index) => {
      process.stdout.write(`\n  ${index + 1}. [${item.category}] ${item.id}  期望=${item.expect} 判定=${item.judged}\n`);
      process.stdout.write(`     问法：${item.text}\n`);
      if (item.hitLines.length) {
        for (const line of item.hitLines) process.stdout.write(`     命中目录行：${line}\n`);
      } else if (item.expectedLine) {
        process.stdout.write(`     命中目录行：（无关键词命中）\n     期望模块目录行：${item.expectedLine}\n`);
      } else {
        process.stdout.write('     命中目录行：（无）\n');
      }
      if (item.answer) process.stdout.write(`     模型回答：${item.answer.replace(/\s+/g, ' ').slice(0, 200)}\n`);
      if (opts.live) process.stdout.write(`     耗时：${item.ms}ms\n`);
    });
  }

  process.stdout.write(`\n结论速览：${passed ? 'PASS' : 'FAIL'}\n`);
  return passed;
}

function buildJson({ opts, catalog, distribution, distributionChecked, results, summary, suspicious, elapsedMs }) {
  return {
    mode: opts.live ? 'live' : 'dry',
    file: opts.file,
    limit: opts.limit,
    generatedAt: new Date().toISOString(),
    catalog: {
      source: catalog.source,
      note: catalog.note || '',
      modules: catalog.modules.map((item) => ({ name: item.name, when: item.when, line: item.line })),
    },
    distribution: {
      checked: distributionChecked,
      expected: EXPECTED_DISTRIBUTION,
      counts: distribution.counts,
      ok: distribution.ok,
      problems: distribution.problems,
    },
    totals: {
      cases: results.length,
      shouldTrigger: summary.denominators.shouldTrigger,
      shouldNot: summary.denominators.shouldNot,
      errors: summary.counts.errors,
    },
    rates: summary.rates,
    pass: summary.pass,
    datasetOk: !distributionChecked || distribution.ok,
    elapsedMs,
    suspicious,
    results: results.map((item) => ({
      id: item.id,
      text: item.text,
      expect: item.expect,
      judged: item.judged,
      ok: !item.error && item.judged === item.expect,
      hits: item.hits,
      hitLines: item.hitLines || [],
      error: item.error || null,
      answer: item.answer || null,
      ms: item.ms || 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv) {
  const { opts, errors: argErrors } = parseArgs(argv);
  if (opts.help) {
    usage();
    return 0;
  }
  if (argErrors.length) {
    for (const message of argErrors) process.stderr.write(`参数错误：${message}\n`);
    usage();
    return 2;
  }
  if (!fs.existsSync(opts.file)) {
    process.stderr.write(`找不到测试集：${opts.file}\n`);
    return 2;
  }

  let cases;
  try {
    cases = parseTriggersYaml(fs.readFileSync(opts.file, 'utf8'), opts.file);
  } catch (err) {
    process.stderr.write(`解析测试集失败：${err.message}\n`);
    return 2;
  }

  const caseErrors = validateCases(cases);
  if (caseErrors.length) {
    process.stderr.write('测试集校验失败：\n');
    for (const message of caseErrors) process.stderr.write(`  - ${message}\n`);
    return 2;
  }
  if (!cases.length) {
    process.stderr.write(`测试集为空：${opts.file}\n`);
    return 2;
  }

  if (opts.limit) cases = cases.slice(0, opts.limit);
  const distributionChecked = !opts.limit;
  const distribution = checkDistribution(cases);

  const catalog = loadCatalog();
  if (!catalog.modules.length) {
    process.stderr.write(`找不到模块目录：${MODULES_DIR}\n`);
    return 2;
  }

  const moduleNames = catalog.modules.map((item) => item.name);
  const unknownExpect = [...new Set(cases.map((item) => item.expect).filter((value) => value !== 'none' && !moduleNames.includes(value)))];
  if (unknownExpect.length) {
    process.stderr.write(`测试集里的 expect 模块不在目录中：${unknownExpect.join(', ')}\n`);
    return 2;
  }

  let io = null;
  if (opts.live) {
    if (!fs.existsSync(IO_PATH)) {
      process.stderr.write(`找不到 io/io.js：${IO_PATH}，无法跑 --live\n`);
      return 2;
    }
    try {
      io = require(IO_PATH);
    } catch (err) {
      process.stderr.write(`加载 io/io.js 失败：${err.message}\n`);
      return 2;
    }
    if (!io || typeof io.run !== 'function') {
      process.stderr.write('io/io.js 未导出 run()，无法跑 --live\n');
      return 2;
    }
  }

  if (!opts.json) {
    process.stdout.write(`触发测试集 · ${opts.live ? 'live 模式（调用真实模型）' : 'dry 模式（本地关键词，不调模型）'}\n\n`);
    printCatalog(catalog);
  }

  const startedAt = Date.now();
  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    let verdict;
    if (opts.live) verdict = await classifyLive(io, catalog, item);
    else verdict = classifyDry(item.text);

    const result = {
      id: item.id,
      text: item.text,
      expect: item.expect,
      judged: verdict.judged,
      hits: verdict.hits || [],
      hitLines: [],
      error: verdict.error || null,
      answer: verdict.answer || null,
      ms: verdict.ms || 0,
    };
    results.push(result);

    if (!opts.json) {
      if (opts.live) {
        process.stdout.write(`[${index + 1}/${cases.length}] `);
        printCaseLine(result);
      } else {
        printCaseLine(result);
      }
    }
  }

  const summary = summarize(results);
  attachHitLines(results, catalog);
  const suspicious = pickSuspicious(results, catalog);
  const elapsedMs = Date.now() - startedAt;
  const passed = summary.pass && (!distributionChecked || distribution.ok);

  if (opts.json) {
    process.stdout.write(JSON.stringify(buildJson({ opts, catalog, distribution, distributionChecked, results, summary, suspicious, elapsedMs }), null, 2) + '\n');
  } else {
    printSummary(summary, distribution, distributionChecked, opts, catalog, results, suspicious, elapsedMs);
  }

  if (!passed) process.exitCode = 1;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== 0) process.exitCode = code; },
    (err) => { process.stderr.write(`triggers: ${err && err.stack ? err.stack : err}\n`); process.exitCode = 2; },
  );
}

module.exports = {
  parseTriggersYaml,
  validateCases,
  checkDistribution,
  renderCatalogBuiltin,
  loadCatalog,
  classifyDry,
  classifyLive,
  parseModuleAnswer,
  summarize,
  buildLivePrompt,
};
