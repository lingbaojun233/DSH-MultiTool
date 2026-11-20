#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: IO module
 *
 * The only supported way for other modules to talk to the DSH core:
 * feed a task in, read the final answer back.
 *
 * It drives the core exactly the way the official headless surface documents:
 *   node <core>/app/node_modules/@deepseek-ai/dsh/lib/bin.js \
 *        --profile headless [--session-id <id>] --json -
 * with the task written to stdin and DSH_HOME pointed at <core>/home.
 *
 * Transport facts (from @deepseek-ai/dsh-headless README):
 *   - task: positional argument, or stdin when the argument is "-"
 *   - answer: stdout (final text), reasoning: stderr
 *   - --json: newline-delimited events (session/status/text/thinking/tool_call/tool_result/final)
 *   - exit 0 = completed, 1 = aborted or errored
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IO_DIR = __dirname;
const DEFAULT_TIMEOUT_MS = 300000;

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
  const envFile = path.join(p.home, '.env');
  return {
    coreDir: p.dir,
    hasNode,
    hasDsh,
    hasProfile,
    hasEnvFile: fs.existsSync(envFile),
    ready: hasNode && hasDsh && hasProfile,
  };
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
  // Plain (non-JSON) mode prints only the final assistant message on stdout.
  if (!answer) answer = String(stdout || '').trim();
  return { answer, sessionId, reason, errorMessage, events };
}

/**
 * Run one task through the DSH core.
 * @param {string} task prompt text (written to stdin)
 * @param {object} options { sessionId, permissionMode, cwd, timeoutMs, coreDir, keepEvents }
 * @returns {Promise<object>} { ok, code, exitCode, answer, sessionId, reason, stderr, ms, events? }
 */
function run(task, options = {}) {
  const p = resolveCore(options);
  const status = coreStatus(options);
  const startedAt = Date.now();

  if (!status.ready) {
    return Promise.resolve({
      ok: false,
      code: 'CORE_NOT_READY',
      error: `DSH core is not installed at ${p.dir}. Run core\\bootstrap.ps1 first.`,
      answer: '',
      sessionId: null,
      exitCode: null,
      stderr: '',
      ms: 0,
    });
  }

  const timeoutMs = Number(options.timeoutMs || process.env.DSH_IO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  // dsh 0.1.1-rc.2: the task is a positional argument only. `-` (stdin) and
  // `--json` / `--session-id` belong to later releases, so do not pass them:
  // `-` would be answered literally as the task.
  const args = [p.bin, '--profile', 'headless', String(task)];

  const env = Object.assign({}, process.env, { DSH_HOME: p.home });

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
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
        events: options.keepEvents ? parsed.events : undefined,
      });
    });

    try {
      child.stdin.write(task == null ? '' : String(task), 'utf8');
      child.stdin.end();
    } catch (_) {
      /* the close handler reports the failure */
    }
  });
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
      '  --session <id>        continue an existing session',
      '  --permission-mode <m> pass a permission preset to the core',
      '  --timeout <ms>        hard timeout, default 300000',
      '  --json                print the full result object',
      '  --events              include the raw event stream in --json output',
      '',
    ].join('\n'),
  );
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session') { out.sessionId = argv[i + 1]; i += 1; }
    else if (a === '--permission-mode') { out.permissionMode = argv[i + 1]; i += 1; }
    else if (a === '--timeout') { out.timeoutMs = Number(argv[i + 1]); i += 1; }
    else if (a === '--file') { out.file = argv[i + 1]; i += 1; }
    else if (a === '--core') { out.coreDir = argv[i + 1]; i += 1; }
    else if (a === '--stdin') { out.stdin = true; }
    else if (a === '--json') { out.json = true; }
    else if (a === '--events') { out.events = true; }
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
    if (opts.file) task = fs.readFileSync(opts.file, 'utf8');
    else if (opts.stdin) task = fs.readFileSync(0, 'utf8');
    else task = opts._.join(' ');

    if (!task || !task.trim()) {
      process.stderr.write('dsh-io: empty task\n');
      return 2;
    }

    const res = await run(task, { ...opts, keepEvents: Boolean(opts.events) });
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

module.exports = { run, coreStatus, resolveCore, parseStream, IO_DIR };
