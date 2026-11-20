#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: memory module (P0)
 *
 * Cross-session memory with mandatory evidence, three layers, and a dual
 * (count + token) recall budget. P0 covers: evidence gate, append-only store,
 * inverted index, recall. Consolidation, conflicts and forget arrive later.
 *
 * Bound to loopback: 127.0.0.1:8767
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const gate = require('./lib/gate.js');
const store = require('./lib/store.js');
const indexer = require('./lib/indexer.js');
const { recall, renderBlock } = require('./lib/recall.js');

const HOST = process.env.DSH_MEMORY_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_MEMORY_PORT || 8767);
const MAX_BODY = 256 * 1024;
const AUDIT_DIR = path.join(store.DATA_DIR, 'audits');

function log(message) {
  process.stdout.write(`[memory] ${new Date().toISOString()} ${message}\n`);
}

function audit(kind, payload) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(path.join(AUDIT_DIR, `${kind}.jsonl`), `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (err) {
    log(`audit write failed: ${err.message}`);
  }
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

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  try {
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return sendJson(res, 200, { ok: true, index: indexer.snapshot(), stats: store.stats() });
    }

    if (req.method === 'GET' && url.pathname === '/v1/stats') {
      return sendJson(res, 200, { ok: true, ...store.stats(), index: indexer.snapshot() });
    }

    if (req.method === 'POST' && url.pathname === '/v1/events') {
      const input = parseJson(await readBody(req));
      if (!input) return sendJson(res, 400, { ok: false, errors: ['body is not valid JSON'] });

      const verdict = gate.validateEvent(input);
      if (!verdict.ok) {
        store.appendRejected({ ts: new Date().toISOString(), errors: verdict.errors, input });
        audit('write', { ts: new Date().toISOString(), ok: false, errors: verdict.errors, evidence: input.evidence || null });
        log(`rejected: ${verdict.errors.join('; ')}`);
        return sendJson(res, 400, { ok: false, rejected: true, errors: verdict.errors });
      }

      const written = store.appendEvent(verdict.event);
      indexer.add(verdict.event);
      audit('write', {
        ts: new Date().toISOString(),
        ok: true,
        id: verdict.event.id,
        evidence: verdict.event.evidence,
        bytes: written.bytes,
      });
      log(`stored ${verdict.event.id} (${verdict.event.evidence.source}:${verdict.event.evidence.locator})`);
      return sendJson(res, 201, { ok: true, id: verdict.event.id, storedAt: written.file, bytes: written.bytes });
    }

    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const events = store.readAllEvents().slice(-limit);
      return sendJson(res, 200, { ok: true, count: events.length, events });
    }

    if (req.method === 'POST' && url.pathname === '/v1/recall') {
      const body = parseJson(await readBody(req)) || {};
      const result = recall(String(body.query || ''), body.budget || {});
      const payload = { ok: true, ...result };
      if (body.render) payload.block = renderBlock(result);
      audit('recall', {
        ts: new Date().toISOString(),
        query: body.query || '',
        items: result.items.map((item) => item.id),
        used: result.used,
        truncated: result.truncated,
        sessionId: body.sessionId || null,
      });
      log(`recall "${String(body.query || '').slice(0, 40)}" -> ${result.used.count} item(s), ${result.used.tokens} token(s)`);
      return sendJson(res, 200, payload);
    }

    if (req.method === 'POST' && url.pathname === '/v1/reindex') {
      indexer.rebuild();
      return sendJson(res, 200, { ok: true, index: indexer.snapshot() });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log(`error: ${err.message}`);
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

store.ensureDirs();
indexer.rebuild();
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  data=${store.DATA_DIR}  ${indexer.snapshot().events} event(s) indexed`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
