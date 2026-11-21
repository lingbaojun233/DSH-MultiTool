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
const { run, coreStatus, verifyUser } = require('./io.js');

const HOST = process.env.DSH_IO_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_IO_PORT || 8765);
/**
 * 插件产生的副作用动作（发表情、播放语音）先按 session 暂存，
 * 等这一轮 /v1/input 返回时一起带回界面。用内存就够：
 * 动作只在"这一轮结束"这个瞬间有用，丢了大不了这轮不显示。
 */
const actionQueue = new Map(); // sessionId -> [{type, ...}]

function takeActions(sessionId) {
  const list = actionQueue.get(sessionId) || [];
  actionQueue.delete(sessionId);
  return list;
}
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

    // 身份必须在最前面校验：没有有效会话就不进入模型
    let session = await verifyUser(req.headers.authorization || '');
    if (!session) {
      // 内部服务通道：插件（在 DSH 进程里）拿不到用户 token，
      // 但 studio 这类"服务替模型去调 io"的场景必须能用。
      // 只认回环 + 共享密钥，且用户 id 由调用方给出 —— 公网拿不到这个密钥。
      const secret = process.env.DSH_INTERNAL_TOKEN || '';
      const presented = String(req.headers['x-dsh-internal'] || '');
      const fromLoopback = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '') === '127.0.0.1';
      if (secret && presented === secret && fromLoopback) {
        const uid = Number(req.headers['x-dsh-user'] || payload.userId || 0);
        if (Number.isInteger(uid) && uid > 0) {
          session = { user: { id: uid, username: `tool#${uid}`, displayName: '工具', role: 'service' } };
          log(`internal call accepted for user #${uid}`);
        }
      }
    }
    if (!session) {
      return json(res, 401, { ok: false, code: 'E_UNAUTHORIZED', message: '需要登录（Authorization: Bearer <token>）' });
    }
    log(`input user=${session.user.username}#${session.user.id} len=${text.length} session=${payload.sessionId || '-'} history=${Array.isArray(payload.history) ? payload.history.length : 0}`);
    const result = await run(text, {
      sessionId: payload.sessionId || undefined,
      permissionMode: payload.permissionMode || undefined,
      timeoutMs: payload.timeoutMs || undefined,
      history: Array.isArray(payload.history) ? payload.history.slice(-8) : undefined,
      counterpart: payload.counterpart || undefined,
      stickers: Array.isArray(payload.stickers) ? payload.stickers.slice(0, 80) : undefined,
      attachments: Array.isArray(payload.attachments) ? payload.attachments.slice(0, 10) : undefined,
      // 程序化任务（写分镜/排版）不需要人格口吻，否则它会开始聊天
      persona: payload.persona === false ? false : undefined,
      session,
    });

    log(`output ok=${result.ok} code=${result.code} ms=${result.ms} tokens=${result.tokens ? result.tokens.prompt + '+' + result.tokens.answer + '=' + result.tokens.total : '?'}`);
    const { events, ...rest } = result;
    // 插件在这一轮里"做了点什么"（发表情、念一段）会挂在动作队列上，
    // 随响应一起带回给界面执行 —— 模型自己没法直接操作 DOM。
    const actions = takeActions(payload.sessionId || 'adhoc');
    return json(res, result.ok ? 200 : 502, actions.length ? { ...rest, actions } : rest);
  }

  // 插件侧的动作入口：{type, payload} 按 session 暂存，由这一轮的响应带走
  if (req.method === 'POST' && url.pathname === '/v1/action') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { ok: false, error: 'BAD_JSON' });
    }
    const sessionId = String(body.sessionId || 'adhoc');
    const type = String(body.type || '');
    if (!type) return json(res, 400, { ok: false, error: 'TYPE_REQUIRED' });
    // 两种形状都收：{type, payload:{...}} 是契约，扁平 {type, path, text} 也常见。
    // 宿主宽容一点，插件就不用为了适配某个宿主写特例。
    const { sessionId: _ignored, type: _t, payload, ...flat } = body;
    const queue = actionQueue.get(sessionId) || [];
    queue.push({ type, ...flat, ...(payload || {}) });
    actionQueue.set(sessionId, queue.slice(-20));
    log(`action ${type} session=${sessionId}`);
    return json(res, 200, { ok: true, queued: queue.length });
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
