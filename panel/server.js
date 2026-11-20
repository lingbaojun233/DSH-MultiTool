#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: panel module
 *
 * Serves the text in/out panel, proxies it to the IO module, and persists the
 * conversation so a page refresh (or another browser) still shows the history.
 *
 *   browser -> 127.0.0.1:8766 (this process) -> 127.0.0.1:8765 (io) -> DSH core
 *                                            \-> 127.0.0.1:8768 (separator：登录/注册/会话)
 *
 * History lives OUTSIDE this folder (..\data\panel-history.jsonl) so that a
 * `push` that replaces panel\ wholesale never destroys it.
 *
 * Bound to loopback on purpose: reach it from your desktop with
 *   ssh -N -L 8766:127.0.0.1:8766 fish-server
 * (panel\open-panel.cmd does that for you locally).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.DSH_PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_PANEL_PORT || 8766);
const IO_BASE = process.env.DSH_IO_URL || 'http://127.0.0.1:8765';
const MEMORY_BASE = process.env.DSH_MEMORY_URL || 'http://127.0.0.1:8767';
const SEPARATOR_BASE = process.env.DSH_SEPARATOR_URL || 'http://127.0.0.1:8768';
const VIDEO_BASE = process.env.DSH_VIDEO_URL || 'http://127.0.0.1:8769';
const SPEAK_BASE = process.env.DSH_SPEAK_URL || 'http://127.0.0.1:8770';
const LISTEN_BASE = process.env.DSH_LISTEN_URL || 'http://127.0.0.1:8771';
const ROOT = __dirname;
const MAX_BODY = 1024 * 1024;

// 默认写在模块目录之外，push 整目录替换也不会丢掉；DSH_PANEL_DATA 只给自测用
const DATA_DIR = process.env.DSH_PANEL_DATA || path.join(ROOT, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'panel-history.jsonl');
const HISTORY_MAX_LINES = 1000;
const HISTORY_TRIM_TO = 800;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function log(message) {
  process.stdout.write(`[panel] ${new Date().toISOString()} ${message}\n`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ---- history ---------------------------------------------------------------

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    log(`cannot create ${DATA_DIR}: ${err.message}`);
  }
}

function readHistory(limit) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    const messages = [];
    for (const line of slice) {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.role) messages.push(entry);
      } catch {
        /* skip a torn line */
      }
    }
    return messages;
  } catch (err) {
    log(`history read failed: ${err.message}`);
    return [];
  }
}

function appendHistory(entry) {
  try {
    ensureDataDir();
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    trimHistory();
  } catch (err) {
    log(`history write failed: ${err.message}`);
  }
}

function trimHistory() {
  try {
    const size = fs.statSync(HISTORY_FILE).size;
    if (size < 2 * 1024 * 1024) return;
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= HISTORY_MAX_LINES) return;
    fs.writeFileSync(HISTORY_FILE, `${lines.slice(-HISTORY_TRIM_TO).join('\n')}\n`, 'utf8');
    log(`history trimmed to ${HISTORY_TRIM_TO} entries`);
  } catch (err) {
    log(`history trim failed: ${err.message}`);
  }
}

function clearHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '', 'utf8');
  } catch (err) {
    log(`history clear failed: ${err.message}`);
  }
}

// ---- http ------------------------------------------------------------------

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(ROOT, relative);
  if (!target.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearer(req) {
  const raw = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : '';
}

/** 面板自己的用户态闸门：没带 token 的请求不往 io/记忆服务转发。 */
function protectedPath(pathname) {
  return pathname === '/api/input' || pathname === '/api/persona' ||
    pathname.startsWith('/api/memory/') || pathname.startsWith('/api/video') ||
    pathname === '/api/tts' || pathname === '/api/asr';
}

/** 服务间直连 POST（视频模块 / io）：不走 req 透传，因为要拿回结果再二次加工。 */
function postJson(base, pathName, obj, headers = {}, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const target = new URL(pathName, base);
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const upstream = http.request(target, {
      method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
      }, headers),
      timeout: timeoutMs,
    }, (reply) => {
      const chunks = [];
      reply.on('data', (c) => chunks.push(c));
      reply.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { }
        resolve({ status: reply.statusCode || 0, data });
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => resolve({ status: 0, data: { ok: false, error: err.message } }));
    upstream.write(body);
    upstream.end();
  });
}

/** 视频描述 + 用户的话 → 交给 io，让大肥鱼用自己的口气回应。 */
function buildVideoTask(analysis, userText) {
  const lines = [];
  lines.push(userText ? `我给你发了一段视频，说：${userText}` : '我给你发了一段视频。');
  lines.push('');
  lines.push('【视频内容（已经有人帮你看过了，描述如下）】');
  lines.push(analysis.synopsis || analysis.answer || '（没描述出来）');
  if (Array.isArray(analysis.timeline) && analysis.timeline.length) {
    lines.push('时间线：');
    for (const t of analysis.timeline.slice(0, 20)) {
      lines.push(`- ${t.t || '?'} ${t.what || ''}`);
    }
  }
  if (Array.isArray(analysis.highlights) && analysis.highlights.length) {
    lines.push('要点：' + analysis.highlights.join('；'));
  }
  if (analysis.onScreen) lines.push('画面上出现的文字：' + analysis.onScreen);

  // 听力模块听出来的东西：谁在说话、有什么响动、有多吵
  const audio = analysis.audio;
  if (audio && audio.ok) {
    lines.push('');
    lines.push('【声音（听出来的）】');
    if (audio.transcript) lines.push('听到的话：' + audio.transcript);
    else lines.push('没听出成句的人话');
    if (audio.summary) lines.push('声音概况：' + audio.summary);
    if (Array.isArray(audio.events) && audio.events.length) {
      lines.push('声音事件：');
      for (const e of audio.events.slice(0, 8)) lines.push(`- ${e.t || '?'} ${e.desc || ''}`);
    }
    lines.push('【声音结束】');
  }
  lines.push('【描述结束】');
  lines.push('');
  lines.push('用你自己的口气回我：先给一句直接看法（这视频怎么样、值不值得看），再补一两点你自己注意到的东西或者想问的。');
  lines.push('不要复述时间线，不要写成报告。');
  return lines.join('\n');
}

function proxy(req, res, ioPath, body, onDone, base, label) {
  const target = new URL(ioPath, base || IO_BASE);
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;

  const upstream = http.request(
    target,
    { method: req.method, headers, timeout: 600000 },
    (reply) => {
      const chunks = [];
      reply.on('data', (chunk) => chunks.push(chunk));
      reply.on('end', () => {
        const payload = Buffer.concat(chunks);
        res.writeHead(reply.statusCode || 502, {
          'content-type': reply.headers['content-type'] || 'application/json; charset=utf-8',
          'content-length': payload.length,
          'cache-control': 'no-store',
        });
        res.end(payload);
        if (onDone) {
          try {
            onDone(reply.statusCode || 502, payload);
          } catch (err) {
            log(`post-proxy step failed: ${err.message}`);
          }
        }
      });
    },
  );

  upstream.on('timeout', () => upstream.destroy(new Error('io timed out')));
  upstream.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: `${label || 'io'} unreachable: ${err.message}` });
  });

  if (body && body.length) upstream.write(body);
  upstream.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  try {
    // 用户态：注册/登录/退出/会话校验都代理到 separator，浏览器只与面板同源
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }
      const sub = url.pathname.slice('/api/auth'.length);
      const raw = req.method === 'POST' ? await readBody(req) : null;
      return proxy(req, res, '/v1/auth' + sub + url.search, raw, null, SEPARATOR_BASE, 'separator');
    }

    // 没登录就不该碰输入/记忆接口：浏览器会弹登录层，这里先挡一道
    if (protectedPath(url.pathname) && !bearer(req)) {
      return sendJson(res, 401, { ok: false, code: 'E_UNAUTHORIZED', error: '未登录或会话已过期' });
    }

    // 面板的记忆/人格视图：透传到记忆服务，浏览器只走这一个口
    // 管理员接口透传（鉴权在 separator 里做，面板只负责转发）
    if (url.pathname.startsWith('/api/admin/')) {
      const rest = '/v1/admin' + url.pathname.slice('/api/admin'.length);
      const body = req.method === 'POST' || req.method === 'DELETE' ? await readBody(req) : null;
      return proxy(req, res, rest + url.search, body, null, SEPARATOR_BASE);
    }
    if (req.method === 'GET' && url.pathname === '/api/persona') {
      return proxy(req, res, '/v1/persona', null, null, MEMORY_BASE);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/memory/')) {
      const rest = url.pathname.slice('/api/memory'.length);
      return proxy(req, res, '/v1' + rest + url.search, null, null, MEMORY_BASE);
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return proxy(req, res, '/v1/health');
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const limit = Number(url.searchParams.get('limit') || 200);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, messages: readHistory(limit) }));
    }

    if (req.method === 'DELETE' && url.pathname === '/api/history') {
      clearHistory();
      return sendJson(res, 200, { ok: true, cleared: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/input') {
      const raw = await readBody(req);
      let text = '';
      try {
        text = String((JSON.parse(raw.toString('utf8')) || {}).text || '').trim();
      } catch {
        /* upstream will reject it */
      }
      if (text) appendHistory({ role: 'user', text, ts: Date.now() });

      return proxy(req, res, '/v1/input', raw, (status, payload) => {
        let data = {};
        try {
          data = JSON.parse(payload.toString('utf8'));
        } catch {
          /* not json */
        }
        // 401 是用户态问题，不写进对话历史，避免每次掉线都留一条错误
        if (status === 401) return;
        if (data && data.ok) {
          appendHistory({ role: 'assistant', text: data.answer || '', ms: data.ms, usage: data.usage || null, ts: Date.now() });
        } else {
          const reason = (data && (data.error || data.code)) || `HTTP ${status}`;
          appendHistory({ role: 'error', text: String(reason), ts: Date.now() });
        }
      });
    }

    // 视频：先让 video 模块看懂画面，再把描述交给 io，由大肥鱼用自己的口气回应
    if (req.method === 'POST' && (url.pathname === '/api/video/analyze' || url.pathname === '/api/video/url')) {
      const rawVideo = await readBody(req);
      let body = {};
      try { body = JSON.parse(rawVideo.toString('utf8')) || {}; } catch { }
      const isUrl = url.pathname.endsWith('/url');
      if (isUrl && !/^https?:\/\//i.test(String(body.url || ''))) {
        return sendJson(res, 400, { ok: false, error: 'BAD_URL' });
      }

      const v = await postJson(VIDEO_BASE, isUrl ? '/v1/analyze-url' : '/v1/analyze',
        isUrl ? { url: body.url, text: body.text, frames: body.frames }
          : { frames: body.frames, text: body.text }, {}, 900000);

      if (!v.data || !v.data.ok) {
        return sendJson(res, 200, {
          ok: false, step: 'video',
          error: (v.data && v.data.error) || `video module HTTP ${v.status}`,
        });
      }

      const label = String(body.text || '').trim();
      const io = await postJson(IO_BASE, '/v1/input',
        { text: buildVideoTask(v.data, label), sessionId: 'panel-video' },
        { authorization: req.headers.authorization || '' }, 600000);
      const reply = (io.data && io.data.answer) || '';

      appendHistory({ role: 'user', text: label ? `[视频] ${label}` : '[视频]', ts: Date.now() });
      if (reply) appendHistory({ role: 'assistant', text: reply, ts: Date.now(), usage: (io.data && io.data.usage) || null });

      return sendJson(res, 200, {
        ok: true,
        analysis: v.data,
        reply,
        ioOk: Boolean(io.data && io.data.ok),
        tokens: (io.data && io.data.tokens) || null,
      });
    }

    // 发声：把 wav 原样吐给浏览器，<audio> 直接用
    if (req.method === 'POST' && url.pathname === '/api/tts') {
      const rawTts = await readBody(req);
      const target = new URL('/v1/speak', SPEAK_BASE);
      const upstream = http.request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': rawTts.length },
        timeout: 120000,
      }, (reply) => {
        const ct = String(reply.headers['content-type'] || '');
        if (!ct.startsWith('audio/')) {
          const chunks = [];
          reply.on('data', (c) => chunks.push(c));
          reply.on('end', () => {
            res.writeHead(reply.statusCode || 502, { 'content-type': 'application/json; charset=utf-8' });
            res.end(Buffer.concat(chunks));
          });
          return;
        }
        res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-store' });
        reply.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('speak timeout')));
      upstream.on('error', (err) => {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: `speak unreachable: ${err.message}` });
      });
      upstream.write(rawTts);
      upstream.end();
      return;
    }

    // 听力：浏览器录音（webm/wav base64）→ 文本
    if (req.method === 'POST' && url.pathname === '/api/asr') {
      // base64 后的音频比原始大 1/3，60 秒录音给到 32MB 才安全
      const rawAsr = await readBody(req, 32 * 1024 * 1024);
      let payload = {};
      try { payload = JSON.parse(rawAsr.toString('utf8')) || {}; } catch { }
      const r = await postJson(LISTEN_BASE, '/v1/transcribe', payload, {}, 120000);
      if (!r.data) return sendJson(res, 502, { ok: false, error: `listen module HTTP ${r.status}` });
      return sendJson(res, r.status || 200, r.data);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(res, url.pathname);
    }

    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  ensureDataDir();
  log(`listening on http://${HOST}:${PORT}  io=${IO_BASE}  separator=${SEPARATOR_BASE}  history=${HISTORY_FILE}`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
