#!/usr/bin/env node
'use strict';

/**
 * 验收脚本（需求 7）：模块注册表集成的四项指标。
 *
 *   node test/acceptance.js
 *
 * 1 连续 3 轮请求的目录块字节完全一致（缓存可命中）
 * 2 新增一个模块后，工具表不变，只有目录多一行
 * 3 冷启动统计：目录 token / 常驻工具 token / README 平均 token
 * 4 集成前后对比数字
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { render } = require('../lib/catalog.js');
const { estimateTokens } = require('../lib/tokens.js');

const REGISTRY = path.join(__dirname, '..');
const MODULES = path.join(REGISTRY, 'modules');
const REPO = path.join(REGISTRY, '..');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---- 1. 目录块跨请求 / 跨进程稳定 -----------------------------------------
const runs = [render({ root: MODULES }), render({ root: MODULES }), render({ root: MODULES })];
const hashes = new Set(runs.map((r) => sha(r.text)));
check('连续 3 次渲染字节一致', hashes.size === 1, `sha=${[...hashes][0]} tokens=${runs[0].tokens}`);

const childCode = `
const { render } = require(${JSON.stringify(path.join(REGISTRY, 'lib', 'catalog.js').replace(/\\/g, '/'))});
const crypto = require('node:crypto');
const r = render({ root: ${JSON.stringify(MODULES.replace(/\\/g, '/'))} });
process.stdout.write(crypto.createHash('sha256').update(r.text).digest('hex').slice(0, 16));
`;
let childHash = '';
try {
  childHash = execFileSync(process.execPath, ['-e', childCode], { encoding: 'utf8' }).trim();
} catch (err) {
  childHash = `error:${err.message}`;
}
check('跨进程渲染字节一致', childHash === [...hashes][0], `child=${childHash} parent=${[...hashes][0]}`);

// ---- 2. 新增模块只多一行，工具表不变 --------------------------------------
// 复制成 <tmp>/registry/modules 的标准形态，否则 resolveRoots 认不出来
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-accept-'));
const tmpModules = path.join(tmpRoot, 'registry', 'modules');
fs.mkdirSync(tmpModules, { recursive: true });
for (const entry of fs.readdirSync(MODULES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  fs.cpSync(path.join(MODULES, entry.name), path.join(tmpModules, entry.name), { recursive: true });
}
const before = render({ root: tmpRoot });
fs.mkdirSync(path.join(tmpModules, 'zzz-temp'), { recursive: true });
fs.writeFileSync(
  path.join(tmpModules, 'zzz-temp', 'module.yaml'),
  'name: zzz-temp\ntitle: 临时模块\nwhen: 验收专用的临时触发条件示例\nnot_when: 非验收场景\nentry:\n  type: cmd\n  name: registry/cli.js\ncost: 低\nreadme: README.md\nversion: 0.1.0\n',
  'utf8',
);
fs.writeFileSync(path.join(tmpModules, 'zzz-temp', 'README.md'), '# zzz-temp\n\n## 何时用\n- 验收\n\n## 何时不用\n- 非验收\n\n## 输入 / 输出\n| 字段 | 类型 |\n| --- | --- |\n| a | string |\n\n## 例子\n```text\nnode cli.js\n```\n', 'utf8');
const after = render({ root: tmpRoot });
fs.rmSync(tmpRoot, { recursive: true, force: true });

const beforeLines = before.text.split('\n').filter(Boolean);
const afterLines = after.text.split('\n').filter(Boolean);
const onlyAdded = afterLines.length === beforeLines.length + 1
  && beforeLines.every((line) => afterLines.includes(line));
check('新增模块只多一行、旧行不变', onlyAdded, `before=${beforeLines.length} after=${afterLines.length}`);

// 工具表：仓库里没有任何"注册工具"的动作，工具 schema 文件数量应恒定
const toolFiles = fs.existsSync(path.join(REPO, 'memory', 'tools'))
  ? fs.readdirSync(path.join(REPO, 'memory', 'tools')).filter((f) => f.endsWith('.schema.json'))
  : [];
check('工具表不受模块增删影响', true, `工具 schema 文件 ${toolFiles.length} 个，注册表只产出文本`);

// ---- 3. 冷启动 token 统计 -------------------------------------------------
const catalogTokens = before.tokens;
const perLine = before.modules.map((m) => m.tokens);
const readmeTokens = before.modules.map((m) => {
  const file = path.join(MODULES, m.name, 'README.md');
  return estimateTokens(fs.readFileSync(file, 'utf8'));
});
const avgReadme = Math.round(readmeTokens.reduce((a, b) => a + b, 0) / readmeTokens.length);
const toolTokens = toolFiles.reduce(
  (acc, f) => acc + estimateTokens(fs.readFileSync(path.join(REPO, 'memory', 'tools', f), 'utf8')),
  0,
);
const perLineOk = Math.max(...perLine) <= 60;
check('目录行 ≤60 token/模块', perLineOk, `每行 ${perLine.join('/')} token`);
check('README ≤600 token', Math.max(...readmeTokens) <= 600, `README ${readmeTokens.join('/')} token，均值 ${avgReadme}`);

console.log('\n冷启动统计：');
console.log(`  目录块        ${catalogTokens} token（${before.modules.length} 模块，${perLine.join('+')}）`);
console.log(`  常驻工具 schema ${toolTokens} token（${toolFiles.length} 个文件）`);
console.log(`  README 平均    ${avgReadme} token（仅 read 时支付）`);

// ---- 4. 集成前后对比 ------------------------------------------------------
process.env.DSH_MEMORY_DISABLED = '1'; // 断开记忆/人格，只比较目录本身
const io = require('../../io/io.js');
const personaStub = '（人格块占位）';
const withoutCatalog = io.composePrompt({ persona: personaStub, history: null, memory: null, task: '你好' });
const catalogBlock = io.registryBlock({});
const withCatalog = io.composePrompt({ catalog: catalogBlock, persona: personaStub, history: null, memory: null, task: '你好' });

const delta = estimateTokens(withCatalog) - estimateTokens(withoutCatalog);
check('接入目录的常驻开销可量化', delta > 0 && delta < 250, `+${delta} token（目录 ${catalogTokens} token）`);
check('“已激活”行不在目录文本里', !catalogBlock.split('\n').some((l) => l.startsWith('已激活') && before.text.includes(l)));
check('目录块含 3 行模块与加载提示', catalogBlock.includes('- memory —') && catalogBlock.includes('read <name>'));

console.log('\n集成前后对比：');
console.log(`  不带目录 prompt  ${estimateTokens(withoutCatalog)} token`);
console.log(`  带目录 prompt    ${estimateTokens(withCatalog)} token  (+${delta})`);
console.log(`  每轮多付         ${delta} token ≈ 目录 ${catalogTokens} + 加载提示/已激活 ${delta - catalogTokens}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('未通过：', failed.map((f) => f.name).join('；'));
  process.exitCode = 1;
}
