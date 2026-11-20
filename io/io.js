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

const IO_DIR = __dirname;
const DEFAULT_TIMEOUT_MS = 300000;
const MEMORY_URL = process.env.DSH_MEMORY_URL || 'http://127.0.0.1:8767';
const MEMORY_BUDGET = { max_items: 6, max_tokens: 800 };

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

/** 召回并渲染注入块；记忆服务不可用时静默降级为"无记忆"。 */
async function recallFor(task, options = {}) {
  if (!memoryEnabled(options)) return null;
  try {
    const { ok, data } = await postJson(`${MEMORY_URL}/v1/tools/memory_search`, {
      query: String(task).slice(0, 500),
      budget: MEMORY_BUDGET,
    });
    if (!ok || !data || !data.ok) return null;

    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return { block: null, used: data.used, items: [] };

    const lines = ['[可用记忆 · 仅在相关时引用；这里没有的信息不要编造]'];
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.text}  ⟵ ${item.evidence || 'no-evidence'}`);
    });
    return { block: lines.join('\n'), used: data.used, items: items.map((i) => ({ id: i.id, evidence: i.evidence })) };
  } catch {
    return null;
  }
}

/**
 * 人格常驻块：这是"按人格要求回答"的唯一依据。
 * 60 秒缓存——人格变更低频，但也不能永远拿到陈旧版本。
 */
let personaCache = { at: 0, block: null };
async function personaBlock(options = {}) {
  if (!memoryEnabled(options) || options.persona === false) return null;
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

/** 把人格块、对话上下文、记忆块、当前消息按固定顺序拼成 prompt。 */
function composePrompt({ persona, history, memory, task }) {
  const sections = [];

  if (persona) {
    sections.push('[人格设定 · 这是你的身份与行为准则，优先遵守]', persona);
  }
  if (Array.isArray(history) && history.length) {
    const lines = ['[最近对话 · 用于理解指代与言外之意]'];
    for (const turn of history.slice(-8)) {
      const who = turn.role === 'user' ? '用户' : 'DSH';
      lines.push(`${who}：${String(turn.text || '').slice(0, 500)}`);
    }
    sections.push(lines.join('\n'));
  }
  if (memory) {
    sections.push(memory);
  }

  sections.push('[当前消息]', String(task));
  return sections.join('\n\n');
}

/** 记录一轮对话（用户消息 + DSH 回答）。失败只记日志，不影响对话。 */
async function recordTurn(task, answer, options = {}) {
  if (!memoryEnabled(options) || options.record === false) return;
  const sessionId = options.sessionId || 'adhoc';
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

  const [recall, persona] = await Promise.all([recallFor(task, options), personaBlock(options)]);
  const promptText = composePrompt({
    persona,
    history: options.history,
    memory: recall && recall.block ? recall.block : null,
    task,
  });

  const timeoutMs = Number(options.timeoutMs || process.env.DSH_IO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const args = [p.bin, '--profile', 'headless', promptText];
  const env = Object.assign({}, process.env, { DSH_HOME: p.home });

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

  if (recall) {
    result.memory = { used: recall.used, items: recall.items };
  }

  // 落事件：不阻塞返回，失败也不影响对话
  setImmediate(() => {
    recordTurn(task, result.answer, options).catch(() => {});
  });

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
      '  --no-memory           skip recall and skip recording events',
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

module.exports = { run, coreStatus, resolveCore, parseStream, IO_DIR, MEMORY_URL };
