#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: panel module
 *
 * Serves the text in/out panel and proxies it to the IO module, so the browser
 * only ever needs one local tunnel:
 *
 *   browser -> 127.0.0.1:8766 (this process) -> 127.0.0.1:8765 (io) -> DSH core
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
const ROOT = __dirname;
const MAX_BODY = 1024 * 1024;

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

function proxy(req, res, ioPath, body) {
  const target = new URL(ioPath, IO_BASE);
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;

  const upstream = http.request(
    target,
    { method: req.method, headers, timeout: 600000 },
    (reply) => {
      res.writeHead(reply.statusCode || 502, {
        'content-type': reply.headers['content-type'] || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      reply.pipe(res);
    },
  );

  upstream.on('timeout', () => {
    upstream.destroy(new Error('io timed out'));
  });
  upstream.on('error', (err) => {
    if (res.headersSent) return;
    sendJson(res, 502, { ok: false, error: `io unreachable: ${err.message}` });
  });

  if (body && body.length) upstream.write(body);
  upstream.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return proxy(req, res, '/v1/health');
    }
    if (req.method === 'POST' && url.pathname === '/api/input') {
      const body = await readBody(req);
      return proxy(req, res, '/v1/input', body);
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
  log(`listening on http://${HOST}:${PORT}  io=${IO_BASE}`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
