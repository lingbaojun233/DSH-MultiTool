#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: IO module
 *
 * 其他模块与 DSH 核心交互的唯一通道：喂任务进去，拿答案回来。
 * 同时负责记忆的接入：
 *   1) 发问前 → memory_search 召回，拼成上下文块前置到 prompt
 *   2) 回答后 → memory_remember 把用户消息与 DSH 回答各写一条事件（带证据）
 *
 * 调用形式（dsh 0.1.1-rc.2 实测）：
 *   node <core>/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "<task>"
 * 答案走 stdout，推理走 stderr，退出码 0/1。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 复用记忆模块的 token 估算，保证"成本数字"和人格预算用的是同一把尺子。
// 找不到就退回按字符估算，不让 io 因为缺一个可选依赖起不来。
let estimateTokens;
try {
  ({ estimateTokens } = require(path.join(__dirname, '..', 'memory', 'lib', 'budget.js')));
} catch {
  estimateTokens = (text) => Math.ceil(String(text || '').length / 1.2);
}

const IO_DIR = __dirname;
const DEFAULT_TIMEOUT_MS = 300000;
const MEMORY_URL = process.env.DSH_MEMORY_URL || 'http://127.0.0.1:8767';

function resolveCore(options = {}) {
  const dir = path.resolve(options.coreDir || process.env.DSH_CORE_DIR || path.join(IO_DIR, '..', 'core'));
  return {
    dir,
    node: path.join(dir, 'runtime', 'node', 'node.exe'),
    bin: path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    home: path.join(dir, 'home'),
  };
}

function coreStatus(options = {}) {
  const p = resolveCore(options);
  const hasNode = fs.existsSync(p.node);
  const hasDsh = fs.existsSync(p.bin);
  const hasProfile = fs.existsSync(path.join(p.home, 'profiles', 'headless', 'package.json'));
  return {
    coreDir: p.dir,
    hasNode,
    hasDsh,
    hasProfile,
    hasEnvFile: fs.existsSync(path.join(p.home, '.env')),
    ready: hasNode && hasDsh && hasProfile,
  };
}

// ---- memory bridge ---------------------------------------------------------

function memoryEnabled(options = {}) {
  if (options.memory === false) return false;
  return process.env.DSH_MEMORY_DISABLED !== '1';
}

async function postJson(url, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) };
    } catch {
      return { ok: res.ok, status: res.status, data: { raw: text } };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 记忆库快照（只读）；服务不可用时返回 null。 */
const SEPARATOR_URL = process.env.DSH_SEPARATOR_URL || 'http://127.0.0.1:8768';

/** 用分隔模块校验 token，返回 {user, profile} 或 null。 */
async function verifyUser(authorization) {
  if (!authorization) return null;
  try {
    const res = await fetch(SEPARATOR_URL + '/v1/auth/me', {
      headers: { authorization },
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}

/** 每人的相处档案：大肥鱼人格共享，但对不同人态度不同。 */
function userBlock(session) {
  if (!session || !session.user) return null;
  const user = session.user;
  const p = session.profile || {};
  const lines = ['[当前用户]'];
  lines.push('名字：' + (user.displayName || user.username));
  if (p.callMe) lines.push('称呼他：' + p.callMe);
  lines.push('关系：' + (p.relationship || 'friend'));
  if (p.toneNote) lines.push('相处说明：' + p.toneNote);
  const traits = p.traits || {};
  const keys = Object.keys(traits);
  if (keys.length) {
    lines.push('对他的态度基准：' + keys.map((k) => k + ' ' + traits[k]).join('、'));
  }
  lines.push('（人格与说话方式照旧，但亲近程度、语气按上面这段来）');
  return lines.join('\n');
}

async function memoryStats() {
  try {
    const res = await fetch(`${MEMORY_URL}/v1/stats`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return data && data.ok ? data.counts : null;
  } catch {
    return null;
  }
}

/** 本轮（since 之后）模型自己触发的检索审计。 */
async function memoryAuditsSince(since) {
  try {
    const res = await fetch(
      `${MEMORY_URL}/v1/audits?kind=search&since=${encodeURIComponent(since)}&limit=200`,
      { signal: AbortSignal.timeout(3000) },
    );
    const data = await res.json();
    return data && data.ok ? data.items || [] : [];
  } catch {
    return [];
  }
}

/** 汇总一轮的用量：用了多少条记忆、写了什么。 */
function buildUsage(before, after, audits) {
  const usedIds = new Set();
  let usedItems = 0;
  for (const audit of audits) {
    usedItems += Number(audit && audit.used && audit.used.count) || 0;
    for (const id of (audit && audit.ids) || []) usedIds.add(id);
  }
  const delta = before && after
    ? {
      events: (after.events || 0) - (before.events || 0),
      facts: (after.facts || 0) - (before.facts || 0),
      entities: (after.entities || 0) - (before.entities || 0),
      conflicts: (after.conflicts || 0) - (before.conflicts || 0),
    }
    : null;
  return {
    memory: { used: usedItems, ids: [...usedIds].slice(0, 20), searches: audits.length },
    delta,
  };
}

/**
 * 人格常驻块：这是"按人格要求回答"的唯一依据。
 * 60 秒缓存——人格变更低频，但也不能永远拿到陈旧版本。
 */
let personaCache = { at: 0, block: null };
async function personaBlock(options = {}) {
  if (options.persona === false) return null;
  if (Date.now() - personaCache.at < 60000) return personaCache.block;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${MEMORY_URL}/v1/persona`, { signal: controller.signal });
    const data = await res.json();
    personaCache = { at: Date.now(), block: data && data.ok && data.block ? data.block : null };
  } catch {
    personaCache = { at: Date.now(), block: null };
  } finally {
    clearTimeout(timer);
  }
  return personaCache.block;
}

/**
 * 模块目录：常驻、极便宜（每模块一行），只告诉模型"有哪些模块、何时用"。
 * 用法由 read_module 原生工具按需加载——这里不再给路径与命令，避免重复。
 */
let catalogCache = { at: 0, block: null, modules: [] };
function registryBlock(options = {}) {
  if (options.registry === false) return null;
  if (Date.now() - catalogCache.at < 60000) return catalogCache.block;

  try {
    const registryDir = path.join(IO_DIR, '..', 'registry');
    const { render } = require(path.join(registryDir, 'lib', 'catalog.js'));
    // io 跑在服务器上：只暴露服务器真正能用的模块（deploy 这类本地工具不出现）
    const scope = process.env.DSH_REGISTRY_SCOPE || 'server';
    const result = render({ root: path.join(registryDir, 'modules'), scope });
    const block = ['[模块目录]', result.text].join('\n');
    catalogCache = { at: Date.now(), block, modules: result.modules.map((m) => m.name) };
  } catch {
    catalogCache = { at: Date.now(), block: null, modules: [] };
  }
  return catalogCache.block;
}

/** 把人格块、对话上下文、当前消息按固定顺序拼成 prompt。 */
/**
 * 表情包能力说明。模型不能真的"发图片"，所以给它一个约定标记：
 * 想发就在回答最后单独一行写 [sticker:<id>]，面板会把它渲染成图片气泡。
 * 只传 id 和名字（不传路径），避免提示词被撑爆。
 */
function stickerBlock(stickers) {
  const list = Array.isArray(stickers) ? stickers.filter((s) => s && s.id && s.name) : [];
  if (!list.length) return '';
  const shown = list.slice(0, 80);
  const lines = [
    '[表情包 · 你可以发表情]',
    '想发一张表情时，在回答的最后单独一行写：[sticker:<id>]（不要解释这个标记，它会变成图片）。',
    '如果这张让你很满意、想以后一直用，再单独一行写：[收藏这张]。',
    '一次最多发两张。没合适的就别发，不要硬凑。',
    '可用表情：',
  ];
  for (const s of shown) lines.push(`${s.id}=${String(s.name).slice(0, 20)}`);
  return lines.join('\n');
}

function composePrompt({ catalog, persona, user, history, task, stickers }) {
  const sections = [];

  if (catalog) sections.push(catalog);

  if (persona) {
    sections.push('[人格设定 · 这是你的身份与行为准则，优先遵守]', persona);
  }
  if (user) sections.push(user);

  const stickerText = stickerBlock(stickers);
  if (stickerText) sections.push(stickerText);

  if (Array.isArray(history) && history.length) {
    const lines = ['[最近对话 · 用于理解指代与言外之意]'];
    for (const turn of history.slice(-8)) {
      const who = turn.role === 'user' ? '用户' : 'DSH';
      lines.push(`${who}：${String(turn.text || '').slice(0, 500)}`);
    }
    sections.push(lines.join('\n'));
  }

  sections.push('[当前消息]', String(task));
  return sections.join('\n\n');
}

/** 记录一轮对话（用户消息 + DSH 回答）。失败只记日志，不影响对话。 */
async function recordTurn(task, answer, options = {}) {
  if (!memoryEnabled(options) || options.record === false) return;
  const sessionId = options.sessionId || 'adhoc';
  const userId = options.userId == null ? null : Number(options.userId);
  // 对话对象：有值 = 这两条记忆只属于跟这个人的对话（QQ 参谋按联系人隔离）
  const counterpart = options.counterpart == null ? null : String(options.counterpart).slice(0, 60);
  const stamp = Date.now();
  const events = [
    {
      content: String(task),
      evidence: `chat:${sessionId}#u${stamp}`,
      channel: 'chat',
      group_id: sessionId,
      speaker_id: 'user',
      speaker_name: '用户',
      kind: 'msg',
      confidence: 0.9,
      user_id: userId,
      counterpart,
    },
  ];
  if (answer && String(answer).trim()) {
    events.push({
      content: String(answer),
      evidence: `chat:${sessionId}#d${stamp}`,
      channel: 'chat',
      group_id: sessionId,
      speaker_id: 'dsh',
      speaker_name: 'DSH',
      kind: 'msg',
      confidence: 0.8,
      user_id: userId,
      counterpart,
    });
  }

  for (const event of events) {
    try {
      await postJson(`${MEMORY_URL}/v1/tools/memory_remember`, event, 8000);
    } catch {
      /* 记忆不可用不应影响对话 */
    }
  }
}

function parseStream(stdout) {
  const events = [];
  let sessionId = null;
  let finalText = null;
  let lastText = null;
  let reason = null;
  let errorMessage = null;

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(ev);
    if (ev.type === 'session' && typeof ev.sessionId === 'string') sessionId = ev.sessionId;
    if (ev.type === 'text' && typeof ev.text === 'string') lastText = ev.text;
    if (ev.type === 'final') {
      if (typeof ev.text === 'string') finalText = ev.text;
      if (typeof ev.sessionId === 'string') sessionId = ev.sessionId;
      if (ev.reason !== undefined && ev.reason !== null) reason = ev.reason;
    }
    if (ev.type === 'error' && typeof ev.message === 'string') errorMessage = ev.message;
  }

  let answer = finalText !== null ? finalText : (lastText !== null ? lastText : '');
  if (!answer) answer = String(stdout || '').trim();
  return { answer, sessionId, reason, errorMessage, events };
}

/**
 * 跑一个任务：先召回记忆组 prompt，再调用核心，最后异步落事件。
 * @returns {Promise<object>} { ok, code, exitCode, answer, sessionId, stderr, ms, memory? }
 */
async function run(task, options = {}) {
  const p = resolveCore(options);
  const status = coreStatus(options);
  const startedAt = Date.now();

  if (!status.ready) {
    return {
      ok: false,
      code: 'CORE_NOT_READY',
      error: `DSH core is not installed at ${p.dir}. Run core\\bootstrap.ps1 first.`,
      answer: '',
      sessionId: null,
      exitCode: null,
      stderr: '',
      ms: 0,
    };
  }

  const session = options.session || null;
  const userCtx = userBlock(session);
  const persona = await personaBlock(options);
  const catalog = registryBlock(options);
  const promptText = composePrompt({
    catalog,
    persona,
    user: userCtx,
    history: options.history,
    task,
    stickers: options.stickers,
  });
  // 成本可见性：每轮都记下输入/输出 token，否则"一次对话多少钱"只能靠猜。
  const promptTokens = estimateTokens(promptText);
  const timeoutMs = Number(options.timeoutMs || process.env.DSH_IO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  // 本轮起点 + 记忆库基线：结束时用差值算出"用了什么、写了什么"
  const turnStartedAt = new Date().toISOString();
  const beforeStats = await memoryStats();
  const args = [p.bin, '--profile', 'headless', promptText];
  const env = Object.assign({}, process.env, {
    DSH_HOME: p.home,
    DSH_USER_ID: session && session.user ? String(session.user.id) : '',
    DSH_USER_NAME: session && session.user ? String(session.user.displayName || session.user.username) : '',
    // 供插件里的 memory_search / memory_remember 按对话对象过滤
    DSH_COUNTERPART: options.counterpart == null ? '' : String(options.counterpart).slice(0, 60),
    // 插件要"做点什么"（发张图、念一段）时，把动作发到这里，等这一轮结束随响应带回界面
    DSH_SESSION_ID: options.sessionId || 'adhoc',
    DSH_ACTION_URL: `${process.env.DSH_ACTION_URL || 'http://127.0.0.1:8765'}/v1/action`,
  });

  const result = await new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer = null;

    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawn(p.node, args, {
        cwd: options.cwd || process.cwd(),
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      done({ ok: false, code: 'SPAWN_FAILED', error: err.message, answer: '', sessionId: null, exitCode: null, stderr: '', ms: Date.now() - startedAt });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      done({
        ok: false,
        code: 'TIMEOUT',
        error: `timed out after ${timeoutMs} ms`,
        answer: '',
        sessionId: null,
        exitCode: null,
        stderr,
        ms: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      done({ ok: false, code: 'SPAWN_FAILED', error: err.message, answer: '', sessionId: null, exitCode: null, stderr, ms: Date.now() - startedAt });
    });

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('close', (code) => {
      const parsed = parseStream(stdout);
      const ok = code === 0;
      done({
        ok,
        code: ok ? 'OK' : (parsed.errorMessage ? 'DSH_ERROR' : `DSH_EXIT_${code}`),
        exitCode: code,
        answer: parsed.answer,
        sessionId: parsed.sessionId,
        reason: parsed.reason,
        error: parsed.errorMessage || undefined,
        stderr,
        ms: Date.now() - startedAt,
      });
    });

    try {
      child.stdin.write('', 'utf8');
      child.stdin.end();
    } catch (_) {
      /* close handler reports the failure */
    }
  });

  // 落事件后再统计增量，保证 usage 里能看到这一轮写了什么（多花约 15ms）
  try {
    await recordTurn(task, result.answer, Object.assign({}, options, {
    userId: session && session.user ? session.user.id : null,
    counterpart: options.counterpart == null ? null : options.counterpart,
  }));
  } catch {
    /* 记忆不可用不影响对话 */
  }

  try {
    const [afterStats, audits] = await Promise.all([memoryStats(), memoryAuditsSince(turnStartedAt)]);
    result.usage = buildUsage(beforeStats, afterStats, audits);
  const answerTokens = estimateTokens(result.answer || '');
  result.tokens = { prompt: promptTokens, answer: answerTokens, total: promptTokens + answerTokens };
  } catch {
    /* 统计失败不影响对话 */
  }

  return result;
}

// ---- CLI -------------------------------------------------------------------

function usage() {
  process.stdout.write(
    [
      'dsh-io - feed the DSH core and read its answer back',
      '',
      '  node io.js send "task text"',
      '  node io.js send --file prompt.txt',
      '  node io.js send --stdin < prompt.txt',
      '  node io.js health',
      '',
      'Options:',
      '  --session <id>        session id used for memory evidence',
      '  --timeout <ms>        hard timeout, default 300000',
      '  --no-memory           skip persona injection and event recording',
      '  --json                print the full result object',
      '',
    ].join('\n'),
  );
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session') { out.sessionId = argv[i + 1]; i += 1; }
    else if (a === '--timeout') { out.timeoutMs = Number(argv[i + 1]); i += 1; }
    else if (a === '--file') { out.file = argv[i + 1]; i += 1; }
    else if (a === '--core') { out.coreDir = argv[i + 1]; i += 1; }
    else if (a === '--stdin') { out.stdin = true; }
    else if (a === '--no-memory') { out.memory = false; }
    else if (a === '--json') { out.json = true; }
    else { out._.push(a); }
  }
  return out;
}

async function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') { usage(); return 0; }

  if (cmd === 'health') {
    const s = coreStatus();
    process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    return s.ready ? 0 : 1;
  }

  if (cmd === 'prompt') {
    // 只拼 prompt、不调模型：验收与排错用
    const opts = parseFlags(argv.slice(1));
    let task;
    if (opts.file) task = fs.readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, '');
    else if (opts.stdin) task = fs.readFileSync(0, 'utf8');
    else task = opts._.join(' ') || '（空任务）';

    const persona = await personaBlock(opts);
    const catalog = registryBlock(opts);
    process.stdout.write(
      `${composePrompt({ catalog, persona, history: opts.history, task })}\n`,
    );
    return 0;
  }

  if (cmd === 'send') {
    const opts = parseFlags(argv.slice(1));
    let task;
    if (opts.file) task = fs.readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, '');
    else if (opts.stdin) task = fs.readFileSync(0, 'utf8');
    else task = opts._.join(' ');

    if (!task || !task.trim()) {
      process.stderr.write('dsh-io: empty task\n');
      return 2;
    }

    const res = await run(task, opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (res.ok) {
      process.stdout.write(res.answer.endsWith('\n') ? res.answer : res.answer + '\n');
    } else {
      process.stderr.write(`dsh-io: ${res.code}: ${res.error || res.reason || 'failed'}\n`);
      if (res.stderr) process.stderr.write(res.stderr);
    }
    return res.ok ? 0 : 1;
  }

  process.stderr.write(`dsh-io: unknown command "${cmd}"\n`);
  usage();
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { run, coreStatus, resolveCore, parseStream, IO_DIR, MEMORY_URL, SEPARATOR_URL, registryBlock, composePrompt, verifyUser, userBlock };
