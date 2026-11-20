#!/usr/bin/env node
'use strict';

/**
 * registry CLI —— 模块注册表的命令行入口。
 *
 *   node cli.js validate             校验全部 module.yaml
 *   node cli.js catalog [--json]     渲染目录（就是注入给模型的那段）
 *   node cli.js read <name>          读某模块的 README（模型通过它懒加载用法）
 *   node cli.js lint [name]          质检 README
 *   node cli.js gen <name>           生成决策卡（打印，不写文件）
 *   node cli.js stats                读取统计 / 读了没用的清单
 *
 * 所有命令都支持 --json，错误统一为 {ok:false, code, field?, message}。
 */

const path = require('node:path');
const { validateAll, validateModule } = require('./lib/validate.js');
const { render } = require('./lib/catalog.js');
const loader = require('./lib/loader.js');
const { lint } = require('./lib/lint.js');
const { generate } = require('./lib/readme-gen.js');

const ROOT = path.join(__dirname, 'modules');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const args = argv.filter((a) => !a.startsWith('--'));
const [command, ...rest] = args;

function print(value, raw) {
  if (asJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  if (raw) process.stdout.write(raw.endsWith('\n') ? '' : '\n');
}

function fail(code, message, extra = {}) {
  const payload = { ok: false, code, message, ...extra };
  if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}

switch (command) {
  case 'validate': {
    const result = validateAll(ROOT);
    if (asJson) print(result);
    else if (result.ok) {
      print(`全部通过：${result.modules.length} 个模块`);
      result.modules.forEach((m) => print(`  - ${m.name}  (${m.version})  ${m.when}`));
    } else {
      print(`校验失败：${result.errors.length} 处`);
      result.errors.forEach((e) => print(`  [${e.code}] ${e.module || '-'} ${e.field || ''} ${e.message}`));
    }
    if (!result.ok) process.exitCode = 1;
    break;
  }

  case 'catalog': {
    const scopeArg = (argv.find((a) => a.startsWith('--scope=')) || '').split('=')[1] || null;
    const result = render({ root: ROOT, scope: scopeArg });
    if (asJson) print(result);
    else {
      print(result.text);
      print(`\n(tokens=${result.tokens}, modules=${result.modules.length})`);
      if (result.conflicts.length) {
        print(`冲突 ${result.conflicts.length} 处：`);
        result.conflicts.forEach((c) => print(`  ${c.a} ↔ ${c.b}：${c.reason}`));
      }
      if (result.overBudget) print('警告：有目录行超出 60 token 预算');
    }
    break;
  }

  case 'read': {
    const name = rest[0];
    if (!name) return fail('E_USAGE', '用法：read <name>');
    const sessionKey = (argv.find((a) => a.startsWith('--session=')) || '').split('=')[1] || 'cli';
    const result = loader.read(ROOT, name, { sessionKey });
    if (asJson) print(result);
    else if (result.ok) {
      if (result.cached) print('(已在本会话读过，内容见上下文，无需重复)\n');
      print(result.content);
      if (result.warning) process.stderr.write(`warning: ${result.warning}\n`);
    } else {
      fallbackUnknown(name, result);
    }
    if (!result.ok) process.exitCode = 1;
    break;
  }

  case 'lint': {
    const name = rest[0];
    if (name) {
      const result = lint(path.join(ROOT, name));
      if (asJson) print(result);
      else printLint(name, result);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    const modules = validateAll(ROOT);
    let bad = 0;
    for (const m of modules.modules) {
      const result = lint(path.join(ROOT, m.name));
      if (!result.ok) bad += 1;
      if (asJson) print({ module: m.name, ...result });
      else printLint(m.name, result);
    }
    if (bad) process.exitCode = 1;
    break;
  }

  case 'gen': {
    const name = rest[0];
    if (!name) return fail('E_USAGE', '用法：gen <name>');
    const dir = path.join(ROOT, name);
    const validation = validateModule(dir);
    if (!validation.ok) return fail('E_INVALID_MODULE', '模块校验未通过', { errors: validation.errors });
    const result = generate(dir);
    print(asJson ? result : result.content);
    break;
  }

  case 'stats': {
    print(loader.stats(ROOT));
    break;
  }

  default:
    print(
      [
        '用法: node cli.js <validate|catalog|read|lint|gen|stats> [参数] [--json]',
        '',
        '  validate          校验 modules/*/module.yaml',
        '  catalog           渲染目录（注入给模型的那段）',
        '  read <name>       懒加载某模块的 README',
        '  lint [name]       质检 README',
        '  gen <name>        生成决策卡（打印）',
        '  stats             读取统计',
      ].join('\n'),
    );
    process.exitCode = 2;
}

function fallbackUnknown(name, result) {
  print(`未知模块：${name}`);
  if (result.available && result.available.length) print(`可用：${result.available.join('、')}`);
}

function printLint(name, result) {
  if (result.ok) {
    print(`${name}: ok (${result.tokens} tokens)`);
    return;
  }
  print(`${name}: ${result.issues.length} 个问题`);
  result.issues.forEach((i) => print(`  [${i.code}] ${i.field || ''} ${i.message}${i.suggestion ? ` → ${i.suggestion}` : ''}`));
}
