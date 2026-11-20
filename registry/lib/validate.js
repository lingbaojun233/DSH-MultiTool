'use strict';

/**
 * module.yaml 校验 + 批量校验。零外部依赖，错误一律结构化返回（不抛异常）。
 *
 * 根目录约定（与 docs/registry-design.md 对齐）：
 *   repoRoot     = DSH-MultiTool 根，即 registry/..  —— entry.name 相对它解析
 *   registryRoot = repoRoot/registry
 *
 * 入口文件解析顺序：先 repoRoot，再 repoRoot 的父目录（工作区根）。
 * 第二步是为兼容现存 deploy 模块（`deploy-tool/deploy.ps1` 实际位于仓库外）；
 * 走第二步时会给出 W_ENTRY_OUTSIDE_ROOT 警告，可用
 * `{ allowWorkspaceFallback: false }` 关闭回退、严格按 repoRoot 解析。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const ENTRY_TYPES = ['tool', 'cmd'];
const COSTS = ['低', '中', '高'];
const WHEN_MAX_CHARS = 40;
const DEFAULT_README = 'README.md';

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

/** 按 UTF-16 码元比较，避免 locale 差异导致排序不确定。 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function charLength(value) {
  return [...value].length;
}

function show(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * 归一化根目录，接受三种写法（与 lib/loader.js 的 resolveLayout 一致）：
 *   1. registry/modules 目录本身
 *   2. registry 目录本身（含 modules/）
 *   3. DSH-MultiTool 仓库根（含 registry/modules/）
 * @returns {{repoRoot: string, registryRoot: string}}
 */
function resolveRoots(input) {
  const abs = path.resolve(input);
  if (path.basename(abs).toLowerCase() === 'modules' && isDirectory(abs)) {
    const registryRoot = path.dirname(abs);
    return { registryRoot, repoRoot: path.dirname(registryRoot) };
  }
  if (isDirectory(path.join(abs, 'modules'))) {
    return { registryRoot: abs, repoRoot: path.dirname(abs) };
  }
  if (isDirectory(path.join(abs, 'registry', 'modules'))) {
    return { registryRoot: path.join(abs, 'registry'), repoRoot: abs };
  }
  return { registryRoot: path.join(abs, 'registry'), repoRoot: abs };
}

function inferRootsFromModuleDir(dirAbs) {
  const registryRoot = path.resolve(dirAbs, '..', '..');
  return { registryRoot, repoRoot: path.dirname(registryRoot) };
}

/**
 * 把 entry.name 解析成真实文件。
 * @returns {{ok: true, base: string, file: string, viaFallback: boolean}|{ok: false, tried: string[]}}
 */
function resolveEntryFile(repoRoot, entryName, allowFallback) {
  const candidates = [
    { base: repoRoot, file: path.resolve(repoRoot, entryName), viaFallback: false },
  ];
  if (allowFallback) {
    const parent = path.dirname(repoRoot);
    if (parent && parent !== repoRoot) {
      candidates.push({ base: parent, file: path.resolve(parent, entryName), viaFallback: true });
    }
  }
  for (const candidate of candidates) {
    if (isFile(candidate.file)) return { ok: true, ...candidate };
  }
  return { ok: false, tried: candidates.map((candidate) => candidate.file) };
}

/**
 * 校验单个模块目录。
 * @param {string} dir 模块目录（registry/modules/<name>）
 * @param {{root?: string, allowWorkspaceFallback?: boolean}} [options]
 * @returns {{ok: true, module: object}|{ok: false, errors: Array<{code: string, field: string, message: string}>}}
 */
function validateModule(dir, options) {
  const opts = options || {};
  const dirAbs = path.resolve(dir);
  const roots = opts.root ? resolveRoots(opts.root) : inferRootsFromModuleDir(dirAbs);
  const allowFallback = opts.allowWorkspaceFallback !== false;
  const yamlPath = path.join(dirAbs, 'module.yaml');
  const errors = [];
  const warnings = [];
  const add = (code, field, message) => { errors.push({ code, field, message }); };

  if (!isFile(yamlPath)) {
    add('E_MODULE_YAML_MISSING', 'module.yaml', `缺少 module.yaml：${yamlPath}`);
    return { ok: false, errors };
  }

  let raw;
  try {
    raw = yaml.parse(fs.readFileSync(yamlPath, 'utf8'));
  } catch (err) {
    add('E_YAML_PARSE', 'module.yaml', err && err.message ? err.message : String(err));
    return { ok: false, errors };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    add('E_YAML_PARSE', 'module.yaml', 'module.yaml 解析结果不是对象');
    return { ok: false, errors };
  }

  // name：必填、全小写、^[a-z][a-z0-9-]*$
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    add('E_NAME_MISSING', 'name', 'name 必填');
  } else if (!NAME_RE.test(name)) {
    const reason = /[A-Z]/.test(name)
      ? '必须全小写'
      : '只允许小写字母、数字与连字符，且必须以小写字母开头';
    add('E_NAME_INVALID', 'name', `name 不合法（${reason}）：${show(raw.name)}`);
  }

  // title：必填
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) add('E_TITLE_MISSING', 'title', 'title 必填');

  // when：必填、非空、≤40 字符
  const when = typeof raw.when === 'string' ? raw.when.trim() : '';
  if (!when) {
    add('E_WHEN_EMPTY', 'when', 'when 必填且不能为空');
  } else if (charLength(when) > WHEN_MAX_CHARS) {
    add('E_WHEN_TOO_LONG', 'when', `when 共 ${charLength(when)} 字符，超过上限 ${WHEN_MAX_CHARS} 字符`);
  }

  // not_when：必填、非空
  const notWhen = typeof raw.not_when === 'string' ? raw.not_when.trim() : '';
  if (!notWhen) add('E_NOT_WHEN_MISSING', 'not_when', 'not_when 必填且不能为空');

  // entry：type ∈ {tool, cmd}，name 指向真实文件
  let entryType = '';
  let entryName = '';
  let entryPath = '';
  let entryBase = '';
  const entryRaw = raw.entry;
  if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) {
    add('E_ENTRY_MISSING', 'entry', '缺少 entry 段（应包含 type 与 name）');
  } else {
    entryType = typeof entryRaw.type === 'string' ? entryRaw.type.trim() : '';
    if (!ENTRY_TYPES.includes(entryType)) {
      add('E_ENTRY_TYPE', 'entry.type', `entry.type 必须是 ${ENTRY_TYPES.join(' 或 ')}，实际：${show(entryRaw.type)}`);
    }
    entryName = typeof entryRaw.name === 'string' ? entryRaw.name.trim() : '';
    if (!entryName) {
      add('E_ENTRY_MISSING', 'entry.name', 'entry.name 必填（相对 DSH-MultiTool 根的路径）');
    } else {
      const resolved = resolveEntryFile(roots.repoRoot, entryName, allowFallback);
      if (!resolved.ok) {
        add('E_ENTRY_MISSING', 'entry.name',
          `entry.name 指向的文件不存在：${show(entryName)}（已尝试 ${resolved.tried.join(' 或 ')}）`);
      } else {
        entryPath = resolved.file;
        entryBase = resolved.base;
        if (resolved.viaFallback) {
          warnings.push({
            code: 'W_ENTRY_OUTSIDE_ROOT',
            field: 'entry.name',
            message: `entry.name 解析到 DSH-MultiTool 之外（${resolved.file}），建议把文件移入 repoRoot 或改写 entry.name`,
          });
        }
      }
    }
  }

  // cost ∈ {低, 中, 高}
  const cost = typeof raw.cost === 'string' ? raw.cost.trim() : '';
  if (!COSTS.includes(cost)) {
    add('E_COST_INVALID', 'cost', `cost 必须是 ${COSTS.join(' / ')}，实际：${show(raw.cost)}`);
  }

  // version：\d+\.\d+\.\d+
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!VERSION_RE.test(version)) {
    add('E_VERSION_INVALID', 'version', `version 必须形如 0.1.0（\\d+.\\d+.\\d+），实际：${show(raw.version)}`);
  }

  // readme：文件必须存在（缺省按 README.md）
  const readme = typeof raw.readme === 'string' && raw.readme.trim() ? raw.readme.trim() : DEFAULT_README;
  const readmePath = path.resolve(dirAbs, readme);
  if (!isFile(readmePath)) {
    add('E_README_MISSING', 'readme', `readme 文件不存在：${show(readme)}（期望 ${readmePath}）`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const module = {
    name,
    title,
    when,
    not_when: notWhen,
    entry: { type: entryType, name: entryName },
    cost,
    readme,
    version,
    dir: dirAbs,
    yamlPath,
    entryBase,
    entryPath,
    readmePath,
    warnings,
  };
  return { ok: true, module };
}

/**
 * 扫描并校验 registry/modules/*。
 * @param {string} [root] DSH-MultiTool 根（也接受 registry 目录）
 * @param {{allowWorkspaceFallback?: boolean}} [options]
 * @returns {{ok: boolean, modules: object[], errors: object[], warnings: object[]}}
 */
function validateAll(root, options) {
  const opts = options || {};
  const roots = resolveRoots(root === undefined || root === null ? DEFAULT_ROOT : root);
  const modulesDir = path.join(roots.registryRoot, 'modules');
  const errors = [];
  const warnings = [];
  const modules = [];

  if (!isDirectory(modulesDir)) {
    errors.push({
      module: '*',
      code: 'E_MODULES_DIR_MISSING',
      field: 'modules',
      message: `模块目录不存在：${modulesDir}`,
    });
    return { ok: false, modules, errors, warnings };
  }

  const dirNames = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareText);

  const owners = new Map();
  for (const dirName of dirNames) {
    const result = validateModule(path.join(modulesDir, dirName), {
      root: roots.repoRoot,
      allowWorkspaceFallback: opts.allowWorkspaceFallback,
    });
    if (!result.ok) {
      for (const error of result.errors) errors.push({ module: dirName, ...error });
      continue;
    }
    const mod = result.module;
    for (const warning of mod.warnings) warnings.push({ module: mod.name, ...warning });

    const owner = owners.get(mod.name);
    if (owner) {
      errors.push({
        module: dirName,
        code: 'E_DUPLICATE_NAME',
        field: 'name',
        message: `模块名 "${mod.name}" 重复：${owner} 与 ${dirName}`,
      });
      continue;
    }
    owners.set(mod.name, dirName);
    modules.push(mod);
  }

  modules.sort((a, b) => compareText(a.name, b.name));
  return { ok: errors.length === 0, modules, errors, warnings };
}

module.exports = {
  validateModule,
  validateAll,
  resolveRoots,
  NAME_RE,
  VERSION_RE,
  WHEN_MAX_CHARS,
  COSTS,
  ENTRY_TYPES,
};
