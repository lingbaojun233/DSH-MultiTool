#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: IO module HTTP surface
 *
 * A localhost-only bridge other modules can call:
 *   GET  /v1/health                     -> core readiness
 *   POST /v1/input  {"text": "..."}     -> { ok, answer, sessionId, ... }
 *
 * Env:
 *   DSH_IO_HOST   default 127.0.0.1
 *   DSH_IO_PORT   default 8765
 *   DSH_IO_TOKEN  optional bearer token; when set, every /v1/* call must send it
 *   DSH_CORE_DIR  optional core folder override
 */

const http = require('node:http');
const { run, coreStatus } = require('./io.js');

const HOST = process.env.DSH_IO_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_IO_PORT || 8765);
const TOKEN = process.env.DSH_IO_TOKEN || '';
const MAX_BODY = 1024 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${TOKEN}`;
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(line) {
  process.stdout.write(`[io] ${new Date().toISOString()} ${line}\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  if (req.method === 'GET' && url.pathname === '/v1/health') {
    const status = coreStatus();
    return json(res, status.ready ? 200 : 503, { ok: status.ready, core: status, uptimeSec: Math.round(process.uptime()) });
  }

  if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

  if (req.method === 'POST' && url.pathname === '/v1/input') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { ok: false, error: `bad json: ${err.message}` });
    }

    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) return json(res, 400, { ok: false, error: 'text is required' });

    log(`input len=${text.length} session=${payload.sessionId || '-'} history=${Array.isArray(payload.history) ? payload.history.length : 0}`);
    const result = await run(text, {
      sessionId: payload.sessionId || undefined,
      permissionMode: payload.permissionMode || undefined,
      timeoutMs: payload.timeoutMs || undefined,
      history: Array.isArray(payload.history) ? payload.history.slice(-8) : undefined,
    });

    log(`output ok=${result.ok} code=${result.code} ms=${result.ms}`);
    const { events, ...rest } = result;
    return json(res, result.ok ? 200 : 502, rest);
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  const status = coreStatus();
  log(`listening on http://${HOST}:${PORT}  coreReady=${status.ready}  core=${status.coreDir}`);
  if (!status.ready) log('WARNING: core not ready; run core\\bootstrap.ps1 or /v1/health for details');
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
