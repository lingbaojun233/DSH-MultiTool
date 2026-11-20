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
  return pathname === '/api/input' || pathname === '/api/persona' || pathname.startsWith('/api/memory/');
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
