#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: memory 服务
 *
 * 对外只暴露三个工具：
 *   memory_remember  POST /v1/tools/memory_remember
 *   memory_search    POST /v1/tools/memory_search
 *   memory_forget    POST /v1/tools/memory_forget
 * 另有内部运维接口：proactive / nightly / persona / undo / stats / health。
 *
 * 监听 127.0.0.1:8767（回环，不对外）。
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { open } = require('./db/open.js');
const { fail, toResponse, MemoryError } = require('./lib/errors.js');
const { remember } = require('./lib/remember.js');
const { search } = require('./lib/search.js');
const { nightly, forget, undoForget } = require('./lib/maintenance.js');
const { proactiveRecall, addToBlacklist } = require('./lib/proactive.js');
const persona = require('./lib/persona.js');

const HOST = process.env.DSH_MEMORY_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_MEMORY_PORT || 8767);
const MAX_BODY = 256 * 1024;
const DATA_DIR = path.join(__dirname, '..', 'data', 'memory');
const AUDIT_DIR = path.join(DATA_DIR, 'audits');

const db = open();
persona.initPersona(db);

function log(message) {
  process.stdout.write(`[memory] ${new Date().toISOString()} ${message}\n`);
}

function audit(kind, payload) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(path.join(AUDIT_DIR, `${kind}.jsonl`), `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (err) {
    log(`audit failed: ${err.message}`);
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
        reject(new MemoryError('E_BAD_REQUEST', 'body too large', '单次请求不超过 256KB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new MemoryError('E_BAD_REQUEST', 'body is not valid JSON', '请求体必须是 JSON 对象');
  }
}

const ROUTES = {
  'POST /v1/tools/memory_remember': async (body) => {
    if (!body || typeof body !== 'object') throw new MemoryError('E_BAD_REQUEST');
    const result = remember(db, body);
    audit('remember', { ts: new Date().toISOString(), stored: result.stored, reason: result.reason, eventId: result.eventId || null });

    // 无证据是硬错误（约束 1），必须给结构化错误，而不是 ok:true + stored:false
    if (!result.stored && result.reason === 'no_evidence') {
      return {
        status: 400,
        payload: fail('E_NO_EVIDENCE', result.detail || '缺少证据定位', '每条记忆必须带 evidence: "source:locator"'),
      };
    }
    return { status: result.stored ? 201 : 200, payload: { ok: true, ...result } };
  },

  'POST /v1/tools/memory_search': async (body) => {
    const result = search(db, {
      query: String((body && body.query) || ''),
      context: (body && body.context) || {},
      budget: (body && body.budget) || {},
    });
    audit('search', {
      ts: new Date().toISOString(),
      query: String((body && body.query) || ''),
      ids: result.items.map((item) => item.id),
      used: result.used,
      reranked: result.reranked || false,
    });
    return { status: 200, payload: { ok: true, ...result } };
  },

  'POST /v1/tools/memory_forget': async (body) => {
    // undo 只需要 tombstoneId，不要求 id/target —— 否则撤销路径永远 400。
    if (body && body.undo) {
      const tombstoneId = Number(body.tombstoneId || body.tombstone_id || body.id);
      if (!Number.isFinite(tombstoneId) || tombstoneId <= 0) {
        throw new MemoryError('E_BAD_REQUEST', 'tombstoneId is required when undo=true', '传 {undo:true, tombstoneId: 3}');
      }
      const undone = undoForget(db, tombstoneId);
      audit('forget', { ts: new Date().toISOString(), undo: true, tombstoneId });
      return { status: 200, payload: { ok: true, ...undone } };
    }

    const target = body && (body.id || body.target);
    if (!target) throw new MemoryError('E_BAD_REQUEST', 'id is required', '传 "event:123" 或 123');
    const result = forget(db, target, body.reason || 'user_request');
    audit('forget', { ts: new Date().toISOString(), target: String(target), tombstoneId: result.tombstoneId });
    return { status: 200, payload: { ok: true, ...result } };
  },

  'POST /v1/proactive': async (body) => {
    const result = proactiveRecall(db, {
      turn: Number((body && body.turn) || 0),
      sessionId: (body && body.sessionId) || 'default',
      cues: (body && body.cues) || {},
    });
    if (body && body.blacklist) addToBlacklist(body.blacklist);
    return { status: 200, payload: { ok: true, ...result } };
  },

  'POST /v1/nightly': async (body) => {
    const dryRun = Boolean(body && body.dryRun);
    const maintenance = nightly(db, { dryRun });
    const personaDiff = persona.consolidate(db, { dryRun });
    audit('nightly', { ts: new Date().toISOString(), dryRun, maintenance, persona: { changed: Boolean(personaDiff && personaDiff.changed) } });
    return { status: 200, payload: { ok: true, maintenance, persona: personaDiff } };
  },

  'GET /v1/persona': async () => {
    const current = persona.getPersona(db);
    return { status: 200, payload: { ok: true, ...current, block: persona.render(db) } };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    if (key === 'GET /v1/health') {
      const counts = {
        events: db.prepare('SELECT COUNT(*) c FROM events WHERE deleted = 0').get().c,
        facts: db.prepare('SELECT COUNT(*) c FROM facts WHERE deleted = 0').get().c,
        entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
        tombstones: db.prepare('SELECT COUNT(*) c FROM tombstones').get().c,
      };
      return sendJson(res, 200, { ok: true, counts, version: process.version });
    }

    if (key === 'GET /v1/stats') {
      return sendJson(res, 200, {
        ok: true,
        dataDir: DATA_DIR,
        counts: {
          events: db.prepare('SELECT COUNT(*) c FROM events WHERE deleted = 0').get().c,
          deletedEvents: db.prepare('SELECT COUNT(*) c FROM events WHERE deleted = 1').get().c,
          facts: db.prepare('SELECT COUNT(*) c FROM facts WHERE deleted = 0').get().c,
          conflicts: db.prepare("SELECT COUNT(*) c FROM facts WHERE status = 'conflict'").get().c,
          entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
        },
      });
    }

    const handler = ROUTES[key];
    if (!handler) return sendJson(res, 404, fail('E_NOT_FOUND', `no route: ${key}`));

    const body = req.method === 'POST' ? parseBody(await readBody(req)) : {};
    const { status, payload } = await handler(body);
    return sendJson(res, status, payload);
  } catch (err) {
    const payload = toResponse(err);
    log(`error ${key}: ${payload.code} ${payload.message}`);
    return sendJson(res, payload.code === 'E_BAD_REQUEST' ? 400 : 500, payload);
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  db=${require('./db/open.js').DB_FILE}`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
