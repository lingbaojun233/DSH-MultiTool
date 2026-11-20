'use strict';

/**
 * 模块目录渲染：扫描 registry/modules/*\/module.yaml → 稳定文本 + token 预算 + 触发条件冲突。
 *
 * 硬约束（docs/registry-design.md）：
 *   - 每行 `- <name> — <when>`，≤ tokenBudgetPerModule（默认 60）token
 *   - text 逐字节稳定：按 name 字典序、无时间戳、无随机、排序不依赖 locale
 *   - "已激活" 单独作为 activeLine 返回，绝不拼进 text
 */

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const { estimateTokens } = require('./tokens');
const { resolveRoots } = require('./validate');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TOKEN_BUDGET_PER_MODULE = 60;
const ACTIVE_LINE = '已激活：无';
const CONFLICT_JACCARD = 0.6;
const LINE_ISSUES_MAX = 3;

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch (err) {
    return false;
  }
}

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

/** 冲突检测用归一化：小写、去标点/符号/空白。 */
function normalizeTrigger(text) {
  return String(text || '').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

function bigrams(normalized) {
  const out = new Set();
  if (normalized.length < 2) {
    if (normalized.length === 1) out.add(normalized);
    return out;
  }
  for (let i = 0; i < normalized.length - 1; i += 1) out.add(normalized.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / union.size;
}

/**
 * 扫描模块；解析失败/缺 yaml 的目录不会中断渲染，记入 errors。
 * @returns {{modules: Array<{name: string, when: string, dir: string}>, errors: object[]}}
 */
function scanModules(registryRoot) {
  const modulesDir = path.join(registryRoot, 'modules');
  if (!isDirectory(modulesDir)) {
    return {
      modules: [],
      errors: [{ dir: '', code: 'E_MODULES_DIR_MISSING', message: `模块目录不存在：${modulesDir}` }],
    };
  }

  const dirNames = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareText);

  const modules = [];
  const errors = [];

  for (const dirName of dirNames) {
    const moduleDir = path.join(modulesDir, dirName);
    const yamlPath = path.join(moduleDir, 'module.yaml');
    if (!isFile(yamlPath)) {
      errors.push({ dir: dirName, code: 'E_MODULE_YAML_MISSING', message: `缺少 module.yaml：${yamlPath}` });
      continue;
    }
    let raw;
    try {
      raw = yaml.parse(fs.readFileSync(yamlPath, 'utf8'));
    } catch (err) {
      errors.push({ dir: dirName, code: 'E_YAML_PARSE', message: err && err.message ? err.message : String(err) });
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ dir: dirName, code: 'E_YAML_PARSE', message: 'module.yaml 解析结果不是对象' });
      continue;
    }
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : dirName;
    const when = typeof raw.when === 'string' ? raw.when.trim() : '';
    modules.push({ name, when, dir: dirName });
  }

  // 字典序（按 name，同名再按目录）——跨进程稳定
  modules.sort((a, b) => compareText(a.name, b.name) || compareText(a.dir, b.dir));
  return { modules, errors };
}

/** when 语义重叠：去标点后一方包含另一方，或字符二元组 Jaccard ≥ 0.6。 */
function detectConflicts(modules) {
  const conflicts = [];
  for (let i = 0; i < modules.length; i += 1) {
    for (let j = i + 1; j < modules.length; j += 1) {
      const left = modules[i];
      const right = modules[j];
      const leftNorm = normalizeTrigger(left.when);
      const rightNorm = normalizeTrigger(right.when);
      if (!leftNorm || !rightNorm) continue;

      const shorter = leftNorm.length <= rightNorm.length ? leftNorm : rightNorm;
      if (shorter.length >= 2 && (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm))) {
        conflicts.push({ a: left.name, b: right.name, reason: 'when 去标点后存在包含关系' });
        continue;
      }
      const score = jaccard(bigrams(leftNorm), bigrams(rightNorm));
      if (score >= CONFLICT_JACCARD) {
        conflicts.push({
          a: left.name,
          b: right.name,
          reason: `when 字符二元组 Jaccard=${score.toFixed(2)} ≥ ${CONFLICT_JACCARD}`,
        });
      }
    }
  }
  return conflicts;
}

/**
 * @param {{root?: string, tokenBudgetPerModule?: number}} [options]
 * @returns {{text: string, tokens: number, modules: object[], conflicts: object[],
 *   activeLine: string, overBudget: boolean, lineIssues: object[], errors: object[]}}
 */
function render(options) {
  const opts = options || {};
  const roots = resolveRoots(opts.root === undefined || opts.root === null ? DEFAULT_ROOT : opts.root);
  const budgetRaw = Number(opts.tokenBudgetPerModule);
  const budget = Number.isFinite(budgetRaw) ? budgetRaw : DEFAULT_TOKEN_BUDGET_PER_MODULE;

  const { modules, errors } = scanModules(roots.registryRoot);

  const rows = modules.map((mod) => {
    const line = mod.when ? `- ${mod.name} — ${mod.when}` : `- ${mod.name} —`;
    return { name: mod.name, when: mod.when, line, tokens: estimateTokens(line) };
  });

  const text = rows.map((row) => row.line).join('\n');

  const offenders = rows
    .filter((row) => row.tokens > budget)
    .sort((a, b) => (b.tokens - a.tokens) || compareText(a.name, b.name));

  const lineIssues = offenders.slice(0, LINE_ISSUES_MAX).map((row) => ({
    name: row.name,
    line: row.line,
    tokens: row.tokens,
    chars: [...row.line].length,
  }));

  return {
    text,
    tokens: estimateTokens(text),
    modules: rows.map((row) => ({ name: row.name, when: row.when, tokens: row.tokens })),
    conflicts: detectConflicts(modules),
    activeLine: ACTIVE_LINE,
    overBudget: offenders.length > 0,
    lineIssues,
    errors,
  };
}

module.exports = {
  render,
  ACTIVE_LINE,
  DEFAULT_TOKEN_BUDGET_PER_MODULE,
  CONFLICT_JACCARD,
  normalizeTrigger,
  detectConflicts,
};
