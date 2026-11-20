#!/usr/bin/env node
'use strict';

/**
 * DSH-MultiTool :: separator（分隔模块）
 *
 * 只做两件事：
 *   1. 身份：注册 / 登录 / 会话校验，密码 scrypt 加盐，token 只存哈希。
 *   2. 隔离：每个用户一份「相处档案」（关系、称呼、语气补充、traits 覆盖）。
 *
 * 大肥鱼本体（宪法/traits/自传）由 memory 共享，这里不复制人格，只描述差别。
 * 监听 127.0.0.1:8768。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data', 'separator');
const DB_FILE = process.env.DSH_SEPARATOR_DB || path.join(DATA_DIR, 'separator.db');
const HOST = process.env.DSH_SEPARATOR_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_SEPARATOR_PORT || 8768);
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function openDb() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
  return db;
}

const db = openDb();

function log(message) {
  process.stdout.write(`[separator] ${new Date().toISOString()} ${message}\n`);
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
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- 密码与令牌 ------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)')
    .run(tokenHash(token), userId, now.toISOString(), expires.toISOString(), now.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.user_id, s.expires_at, u.username, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(tokenHash(token));
  if (!row) return null;
  if (String(row.expires_at) < new Date().toISOString()) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date().toISOString(), tokenHash(token));
  return { id: row.user_id, username: row.username, displayName: row.display_name };
}

function profileOf(userId) {
  const row = db.prepare('SELECT * FROM user_traits WHERE user_id = ?').get(userId);
  return {
    relationship: row ? row.relationship : 'friend',
    callMe: row ? row.call_me : null,
    toneNote: row ? row.tone_note : null,
    traits: row ? JSON.parse(row.traits_json || '{}') : {},
  };
}

function ensureProfile(userId) {
  const exists = db.prepare('SELECT user_id FROM user_traits WHERE user_id = ?').get(userId);
  if (!exists) {
    db.prepare('INSERT INTO user_traits (user_id, relationship, traits_json, updated_at) VALUES (?,?,?,?)')
      .run(userId, 'friend', '{}', new Date().toISOString());
  }
}

function bearer(req) {
  const raw = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : '';
}

// ---- 路由 ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  try {
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      return sendJson(res, 200, { ok: true, users });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/register') {
      const body = JSON.parse(await readBody(req) || '{}');
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const displayName = String(body.displayName || body.display_name || username).trim() || username;

      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        return sendJson(res, 400, { ok: false, code: 'E_USERNAME', message: '用户名 3-32 位，只允许小写字母/数字/下划线' });
      }
      if (password.length < 6) {
        return sendJson(res, 400, { ok: false, code: 'E_PASSWORD', message: '密码至少 6 位' });
      }
      const dup = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (dup) return sendJson(res, 409, { ok: false, code: 'E_TAKEN', message: '用户名已被占用' });

      const now = new Date().toISOString();
      const info = db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)')
        .run(username, displayName, hashPassword(password), now);
      const userId = Number(info.lastInsertRowid);
      ensureProfile(userId);
      const session = issueSession(userId);
      log(`register ${username} (#${userId})`);
      return sendJson(res, 201, {
        ok: true,
        user: { id: userId, username, displayName },
        profile: profileOf(userId),
        ...session,
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      const body = JSON.parse(await readBody(req) || '{}');
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!row || !verifyPassword(password, row.password_hash)) {
        return sendJson(res, 401, { ok: false, code: 'E_BAD_CREDENTIALS', message: '用户名或密码不对' });
      }
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      ensureProfile(row.id);
      const session = issueSession(row.id);
      log(`login ${username} (#${row.id})`);
      return sendJson(res, 200, {
        ok: true,
        user: { id: row.id, username: row.username, displayName: row.display_name },
        profile: profileOf(row.id),
        ...session,
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      const token = bearer(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      const user = userFromToken(bearer(req));
      if (!user) return sendJson(res, 401, { ok: false, code: 'E_UNAUTHORIZED', message: '未登录或会话已过期' });
      return sendJson(res, 200, { ok: true, user, profile: profileOf(user.id) });
    }

    return sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `no route: ${req.method} ${url.pathname}` });
  } catch (err) {
    log(`error: ${err.message}`);
    return sendJson(res, 500, { ok: false, code: 'E_INTERNAL', message: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  db=${DB_FILE}`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
