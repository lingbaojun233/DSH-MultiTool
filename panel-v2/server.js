'use strict';
/*
 * 视频面板 v2 的服务器：只做两件事
 *   1. 发面板自己的静态文件（index.html / app.js / style.css）
 *   2. 把 /api/studio/* 原样代理到 v2-core（默认 http://127.0.0.1:8774/v1/*）
 * 登录鉴权透传：authorization / cookie 原样带给上游；短视频、字幕这类 <a> 下载
 * 带不了请求头，允许 ?token=xxx 换成一个 Authorization 头（不转发给上游）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.DSH_PANEL_V2_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_PANEL_V2_PORT || 8775);
const STUDIO = (process.env.STUDIO_V2_URL || 'http://127.0.0.1:8774').replace(/\/+$/, '');
const SEPARATOR = (process.env.DSH_SEPARATOR_URL || 'http://127.0.0.1:8768').replace(/\/+$/, '');
const SPEAK = (process.env.DSH_SPEAK_URL || 'http://127.0.0.1:8770').replace(/\/+$/, '');

const ROOT = __dirname;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

// 请求头里不往上游带的：逐跳字段和 Host（Host 要换成上游的）
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// 回给浏览器时原样抄的响应头。content-encoding 保留：我们是纯字节转发，不解压
const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-range',
  'content-disposition',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'vary',
  'set-cookie',
  'location',
];

function log(message) {
  process.stdout.write(`[panel-v2] ${new Date().toISOString()} ${message}\n`);
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

function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const file = STATIC_FILES.get(pathname);
  if (!file) {
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
    return;
  }
  const target = path.join(ROOT, file);
  if (!target.startsWith(ROOT)) {
    sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      sendJson(res, 500, { ok: false, error: 'STATIC_READ_FAILED' });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
}

/** 从请求里取凭证：优先 Authorization，其次 ?token=（给下载链接用）。 */
function authHeaders(req, url) {
  const headers = {};
  const incoming = req.headers.authorization;
  if (incoming) headers.authorization = incoming;
  const cookie = req.headers.cookie;
  if (cookie) headers.cookie = cookie;
  const token = url.searchParams.get('token');
  if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** 去掉 token 查询参数，避免它被转发到上游日志里。 */
function upstreamSearch(url) {
  const params = new URLSearchParams(url.search);
  params.delete('token');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * 通用代理：把当前请求（含 body）流给上游，把上游响应流回浏览器。
 * 不缓冲视频，支持 Range 透传（播放器拖动进度可用）。
 */
function proxy(req, res, base, upstreamPath, label, timeoutMs) {
  const target = new URL(base);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(key)) continue;
    headers[key] = value;
  }
  headers.host = target.host;

  const started = Date.now();
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: upstreamPath,
    headers,
  });

  upstream.setTimeout(timeoutMs || 120000, () => {
    upstream.destroy(new Error('upstream timeout'));
  });

  upstream.on('response', (up) => {
    const out = {};
    for (const name of PASS_HEADERS) {
      if (up.headers[name] !== undefined) out[name] = up.headers[name];
    }
    res.writeHead(up.statusCode || 502, out);
    log(`${label} ${req.method} ${upstreamPath} → ${up.statusCode} ${Date.now() - started}ms`);
    up.pipe(res);
  });

  upstream.on('error', (err) => {
    log(`${label} ${req.method} ${upstreamPath} ✗ ${err.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, { ok: false, error: 'UPSTREAM_DOWN', detail: err.message });
  });

  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });

  req.pipe(upstream);
}

async function health(req, res, url) {
  const started = Date.now();
  let upstreamOk = false;
  let upstreamStatus = 0;
  try {
    const probe = await fetch(`${STUDIO}/v1/jobs`, {
      headers: authHeaders(req, url),
      signal: AbortSignal.timeout(3000),
    });
    upstreamStatus = probe.status;
    upstreamOk = probe.status < 500;
  } catch (err) {
    upstreamStatus = 0;
  }
  sendJson(res, 200, {
    ok: true,
    service: 'panel-v2',
    port: PORT,
    upstream: STUDIO,
    upstreamOk,
    upstreamStatus,
    ms: Date.now() - started,
  });
}

async function handler(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: 'BAD_URL' });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (STATIC_FILES.has(url.pathname) || url.pathname === '/favicon.ico') {
      serveStatic(req, res, url.pathname);
      return;
    }
  }

  if (url.pathname === '/api/health') {
    await health(req, res, url);
    return;
  }

  // 音色清单不在 v2-core 里：转到 speak 的 /v1/voices?zh=1，给设置页动态下拉
  if (url.pathname === '/api/studio/voices' && (req.method === 'GET' || req.method === 'HEAD')) {
    const params = new URLSearchParams(upstreamSearch(url).replace(/^\?/, ''));
    if (!params.has('zh')) params.set('zh', '1');
    const qs = params.toString();
    proxy(req, res, SPEAK, `/v1/voices${qs ? `?${qs}` : ''}`, 'speak', 30000);
    return;
  }

  if (url.pathname === '/api/studio' || url.pathname.startsWith('/api/studio/')) {
    const rest = url.pathname.slice('/api/studio'.length) || '/';
    const upstreamPath = `/v1${rest}${upstreamSearch(url)}`;
    const timeout = rest.startsWith('/video/') ? 600000 : 120000;
    proxy(req, res, STUDIO, upstreamPath, 'studio', timeout);
    return;
  }

  // 登录/注册仍然归 separator 管，面板不自己存口令
  if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
    const rest = url.pathname.slice('/api/auth'.length);
    proxy(req, res, SEPARATOR, `/v1/auth${rest}${upstreamSearch(url)}`, 'auth', 30000);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    log(`handler error: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'INTERNAL' });
    else res.destroy();
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 被占用：先停掉旧进程，或设 DSH_PANEL_V2_PORT 换一个`);
  } else {
    log(`server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} → ${STUDIO}/v1 (auth → ${SEPARATOR}, voices → ${SPEAK})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
