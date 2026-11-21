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
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = process.env.DSH_PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_PANEL_PORT || 8766);
const IO_BASE = process.env.DSH_IO_URL || 'http://127.0.0.1:8765';
const MEMORY_BASE = process.env.DSH_MEMORY_URL || 'http://127.0.0.1:8767';
const SEPARATOR_BASE = process.env.DSH_SEPARATOR_URL || 'http://127.0.0.1:8768';
const VIDEO_BASE = process.env.DSH_VIDEO_URL || 'http://127.0.0.1:8769';
const SPEAK_BASE = process.env.DSH_SPEAK_URL || 'http://127.0.0.1:8770';
const LISTEN_BASE = process.env.DSH_LISTEN_URL || 'http://127.0.0.1:8771';
const STUDIO_BASE = process.env.DSH_STUDIO_URL || 'http://127.0.0.1:8772';
const STICKER_BASE = process.env.DSH_STICKER_URL || 'http://127.0.0.1:8773';

// 浏览器上传的视频落在这里，处理完就删。放在 data\ 下（模块目录以外），
// 这样一次 push 替换 panel\ 不会把正在传的文件搞坏。
const UPLOAD_DIR = process.env.DSH_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const UPLOAD_MAX_BYTES = Number(process.env.DSH_UPLOAD_MAX_BYTES || 2 * 1024 * 1024 * 1024);
const uploads = new Map(); // id -> { file, name, bytes, kind, at }
const ROOT = __dirname;
const MAX_BODY = 1024 * 1024;

// 默认写在模块目录之外，push 整目录替换也不会丢掉；DSH_PANEL_DATA 只给自测用
const DATA_DIR = process.env.DSH_PANEL_DATA || path.join(ROOT, '..', 'data');
// 必须放在 DATA_DIR 之后：const 有 TDZ，写前面会在模块加载时直接抛 ReferenceError
const STUDIO_DIR = process.env.DSH_STUDIO_DIR || path.join(DATA_DIR, 'studio');
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

/**
 * 附件的 kind 只按扩展名判断：够用，也不用读文件头 ——
 * 2GB 的片子为了看前几个字节先开一次流，不值得。
 */
const KIND_BY_EXT = {
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video', '.avi': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.ogg': 'audio', '.flac': 'audio', '.aac': 'audio',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.csv': 'text', '.log': 'text', '.srt': 'text',
  '.js': 'text', '.ts': 'text', '.py': 'text', '.ps1': 'text', '.yaml': 'text', '.yml': 'text',
};

// 预览路由要用它回 content-type：浏览器认得出类型才肯内联显示
const UPLOAD_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac',
};

const KIND_LIST = ['video', 'audio', 'image', 'text', 'other'];

function kindOfName(name) {
  return KIND_BY_EXT[path.extname(String(name || '')).toLowerCase()] || 'other';
}

/**
 * 上传名只留文件名：去掉目录与 `..`，既防穿越，也避免 Windows 非法字符写盘失败。
 * 浏览器有时会把整个本地路径塞进 name；落盘名还会再加一层 UUID 前缀。
 */
function safeUploadName(raw) {
  const base = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
  const cleaned = base
    .replace(/\.\.+/g, '.')                    // 任何一段 `..` 都不能留
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')    // Windows 不允许的字符：写盘会直接失败
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'upload.bin';
  return cleaned.slice(0, 120) || 'upload.bin';
}

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

// 历史按用户分文件：多人共用面板时，谁也别看到谁的对话。
const HISTORY_DIR = path.join(DATA_DIR, 'panel-history');

function historyFile(userId) {
  return path.join(HISTORY_DIR, `${Number(userId) || 0}.jsonl`);
}

/**
 * 从 Bearer token 解析出当前用户（问 separator 要）。
 * 60 秒缓存：面板一轮对话会连着发好几个请求，不该每次都去问一次。
 */
const userCache = new Map(); // tokenHash -> { user, at }
const USER_TTL_MS = 60 * 1000;

async function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.user;

  try {
    const res = await fetch(`${SEPARATOR_BASE}/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { userCache.delete(key); return null; }
    const data = await res.json().catch(() => null);
    const user = data && data.user ? data.user : null;
    if (user) userCache.set(key, { user, at: Date.now() });
    return user;
  } catch (err) {
    log(`auth/me failed: ${err.message}`);
    return null;
  }
}

function readHistory(userId, limit) {
  try {
    const file = historyFile(userId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
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

function appendHistory(userId, entry) {
  try {
    const file = historyFile(userId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    trimHistory(userId);
  } catch (err) {
    log(`history write failed: ${err.message}`);
  }
}

function trimHistory(userId) {
  try {
    const file = historyFile(userId);
    const size = fs.statSync(file).size;
    if (size < 2 * 1024 * 1024) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= HISTORY_MAX_LINES) return;
    fs.writeFileSync(file, `${lines.slice(-HISTORY_TRIM_TO).join('\n')}\n`, 'utf8');
    log(`history trimmed to ${HISTORY_TRIM_TO} entries (user ${userId})`);
  } catch (err) {
    log(`history trim failed: ${err.message}`);
  }
}

function clearHistory(userId) {
  try {
    const file = historyFile(userId);
    if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  } catch (err) {
    log(`history clear failed: ${err.message}`);
  }
}

/** 老版本只有一份全局历史。第一次启动时改名归档，避免谁的账号里突然冒出别人的对话。 */
function archiveLegacyHistory() {
  try {
    const legacy = path.join(DATA_DIR, 'panel-history.jsonl');
    if (!fs.existsSync(legacy)) return;
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(HISTORY_DIR, `legacy-${stamp}.jsonl`);
    fs.renameSync(legacy, dest);
    log(`legacy global history archived -> ${path.basename(dest)}`);
  } catch (err) {
    log(`legacy archive failed: ${err.message}`);
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
    pathname === '/api/tts' || pathname === '/api/asr' ||
    pathname === '/api/history' || pathname === '/api/studio/create' ||
    pathname === '/api/studio/plan' || pathname === '/api/studio/render' ||
    pathname === '/api/stickers/send' || pathname === '/api/stickers/favorite' ||
    pathname === '/api/message' || pathname === '/api/upload';
  // 注意：GET /api/upload/:id（预览）故意不在这里 —— <img>/<video>/新窗口都带不了
  // Bearer 头，它靠不可猜的 UUID 当凭据，和 /api/studio/video 同一个理由。
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
  lines.push('【视频内容（已经有人帮你看过了）】');
  lines.push(analysis.synopsis || analysis.answer || '（没描述出来）');
  if (Array.isArray(analysis.highlights) && analysis.highlights.length) {
    lines.push('要点：' + analysis.highlights.slice(0, 2).join('；'));
  }

  // 听力模块听出来的东西：谁在说话、有什么响动、有多吵
  const audio = analysis.audio;
  if (audio && audio.ok) {
    if (audio.transcript) {
      // SAPI 背景嘈杂时会把噪声听成句子，置信度低于 0.5 就别当成原话
      const shaky = typeof audio.confidence === 'number' && audio.confidence < 0.5;
      lines.push(shaky
        ? '听到的话（背景太吵，识别可能不准，别当原话引用）：' + audio.transcript
        : '听到的话：' + audio.transcript);
    } else {
      lines.push('声音：没听出成句的人话');
    }
    if (audio.summary) lines.push('声音概况：' + audio.summary);
    if (Array.isArray(audio.events) && audio.events.length) {
      lines.push('声音事件：' + audio.events.slice(0, 4).map((e) => `${e.t} ${e.desc}`).join('；'));
    }
  }
  lines.push('【描述结束】');
  lines.push('');
  lines.push('用你自己的口气回我，分成 2~3 条短消息，一条一行，每条不超过 20 字：');
  lines.push('第一条直接说你的看法（好看/一般/没意思），后面的补你自己注意到的东西或者想问的。');
  lines.push('不要复述时间线，不要写成报告，不要每句都提问。');
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

/** 视频分析结果 → 交给 io（大肥鱼用自己的口气说）→ 写历史 → 返回浏览器 */
async function completeVideo(req, res, v, label) {
  if (!v.data || !v.data.ok) {
    return sendJson(res, 200, {
      ok: false, step: 'video',
      error: (v.data && v.data.error) || `video module HTTP ${v.status}`,
    });
  }
  const user = await currentUser(req);
  const io = await postJson(IO_BASE, '/v1/input',
    { text: buildVideoTask(v.data, label), sessionId: 'panel-video' },
    { authorization: req.headers.authorization || '' }, 600000);
  const reply = (io.data && io.data.answer) || '';
  if (user) {
    appendHistory(user.id, { role: 'user', text: label ? `[视频] ${label}` : '[视频]', ts: Date.now() });
    if (reply) appendHistory(user.id, { role: 'assistant', text: reply, ts: Date.now(), usage: (io.data && io.data.usage) || null });
  }
  return sendJson(res, 200, {
    ok: true,
    analysis: v.data,
    reply,
    ioOk: Boolean(io.data && io.data.ok),
    tokens: (io.data && io.data.tokens) || null,
  });
}

function sweepUploads() {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.at > UPLOAD_TTL_MS) {
      try { fs.unlinkSync(u.file); } catch { }
      uploads.delete(id);
    }
  }
}

/**
 * 浏览器把原片直接 PUT 上来，边收边写盘：不经过 base64（省 33% 体积），
 * 也不在内存里攒（2GB 的片子也不会把面板撑爆）。
 *
 * kindHint 是给录音这类"容器扩展名与内容不一致"的文件留的逃生口：
 * MediaRecorder 只能出 webm，但那段录音是 audio，不能让模型去 watch。
 */
function saveUpload(req, res, name, declaredSize, kindHint) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  sweepUploads();
  const id = crypto.randomUUID();
  const safe = safeUploadName(name);
  const hinted = KIND_LIST.includes(String(kindHint || '')) ? String(kindHint) : '';
  const kind = hinted || kindOfName(safe);
  // 声明的大小先挡一道：2GB 的请求没必要收完了才拒绝
  const declared = Number(declaredSize);
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
    return sendJson(res, 413, { ok: false, error: 'TOO_LARGE' });
  }
  const file = path.join(UPLOAD_DIR, id + path.extname(safe));
  const ws = fs.createWriteStream(file);
  let bytes = 0;
  let aborted = false;

  const fail = (code, msg) => {
    if (aborted) return;
    aborted = true;
    try { ws.destroy(); } catch { }
    try { fs.unlinkSync(file); } catch { }
    if (!res.headersSent) sendJson(res, code, { ok: false, error: msg });
  };

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > UPLOAD_MAX_BYTES) {
      fail(413, 'TOO_LARGE');
      try { req.destroy(); } catch { }
    }
  });
  req.on('aborted', () => fail(499, 'CLIENT_ABORTED'));
  req.on('error', () => fail(500, 'UPLOAD_ERROR'));
  ws.on('error', () => fail(500, 'DISK_ERROR'));
  ws.on('finish', () => {
    if (aborted) return;
    if (bytes === 0) { fail(400, 'EMPTY_BODY'); return; }
    uploads.set(id, { file, name: safe, bytes, kind, at: Date.now() });
    log(`upload ok id=${id} name=${safe} bytes=${bytes} kind=${kind}`);
    sendJson(res, 200, { ok: true, uploadId: id, name: safe, bytes, kind });
  });
  req.pipe(ws);
}

/**
 * uploadIds → 上传记录。不认识的 id 直接跳过（过期、服务重启、
 * 或者历史上已经发过的那条消息都会这样），不让整条消息因此失败。
 */
function pickUploads(ids) {
  const out = [];
  for (const raw of Array.isArray(ids) ? ids.slice(0, 10) : []) {
    const id = String(raw || '');
    const up = uploads.get(id);
    if (up) out.push(Object.assign({ id }, up));
  }
  return out;
}

/**
 * 图片的"一句话描述"。
 * 为什么由面板来做：模型看不到像素，附件说明里只有这一句 description，
 * 而视觉能力在视频模块手里（面板不持有视觉 key）。
 * 失败一律不阻断 —— 少一句描述，总比整条消息发不出去强。
 */
async function describeImage(up) {
  // 大图 base64 会把内存顶满；超过 8MB 就放弃描述，只报文件名
  if (up.bytes > 8 * 1024 * 1024) return '';
  try {
    const ext = path.extname(up.name).toLowerCase();
    const mime = UPLOAD_MIME[ext] || 'image/png';
    const buf = await fs.promises.readFile(up.file);
    const r = await postJson(VIDEO_BASE, '/v1/look', {
      image: `data:${mime};base64,${buf.toString('base64')}`,
      prompt: '用一句中文说清这张图里有什么、有没有字。不超过 40 字，不要客套。',
    }, {}, 90000);
    const desc = r.data && r.data.ok ? String(r.data.description || '').replace(/\s+/g, ' ').trim() : '';
    return desc.slice(0, 200);
  } catch (err) {
    log(`image describe failed: ${err.message}`);
    return '';
  }
}

/**
 * 表情 id → 名字。
 * 前端选中表情时本来就知道 mood，会顺手带过来（stickerMood），省一次目录请求；
 * 没带才问一次表情模块 —— 找不到就退回"表情"，绝不因为一张图卡住整条消息。
 */
async function stickerMood(id, hint) {
  const named = String(hint || '').trim();
  if (named) return named.slice(0, 40);
  try {
    const r = await fetch(`${STICKER_BASE}/v1/list?limit=200`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json().catch(() => null);
    const items = data && Array.isArray(data.items) ? data.items : [];
    const hit = items.find((it) => it && String(it.id) === id);
    if (hit) return String(hit.mood || hit.name || '表情').slice(0, 40);
  } catch (err) {
    log(`sticker mood lookup failed: ${err.message}`);
  }
  return '表情';
}

/** 这一轮用完的上传文件立刻删掉：附件已经交给模型了，留着只会塞满磁盘。 */
function dropUploads(list) {
  for (const up of list) {
    try { fs.unlinkSync(up.file); } catch { }
    uploads.delete(up.id);
  }
}

/**
 * 一条消息 = 一次 io 调用。
 *
 * 为什么要在面板里合成：文字、图片、音频、文档、表情在界面上是"一条"，
 * 到了模型那边也必须是"一次"。否则「文字 + 表情」会回两遍，上下文也被拆散。
 * 这里把附件折成 io 的 attachments 字段（它自己决定用 watch / hear / 看描述），
 * 表情折成正文前面的一行提示 —— 模型才知道你"发了一张图"而不是在说文字。
 */
async function handleMessage(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { ok: false, code: 'E_UNAUTHORIZED', error: '未登录或会话已过期' });

  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw.toString('utf8')) || {}; } catch { }
  const text = String(body.text || '').trim();
  const files = pickUploads(body.uploadIds);
  const stickerId = /^[0-9a-f]{6,40}$/i.test(String(body.stickerId || '')) ? String(body.stickerId) : '';

  if (!text && !files.length && !stickerId) {
    return sendJson(res, 400, { ok: false, error: 'EMPTY_MESSAGE' });
  }

  const started = Date.now();
  let sticker = null;
  const attachments = [];
  try {
    // 1) 图片先让人看一眼：附件块里给模型一句人话，它才编得出"我看到了什么"
    for (const up of files) {
      const description = up.kind === 'image' ? await describeImage(up) : '';
      attachments.push({
        kind: up.kind,
        name: up.name,
        path: up.file,
        description: description || undefined,
      });
    }

    // 2) 表情是这条消息的一部分：在正文前面拼一行，不再单独发一轮
    const lines = [];
    if (stickerId) {
      const mood = await stickerMood(stickerId, body.stickerMood);
      sticker = { id: stickerId, label: mood };
      lines.push(`[我发了一个表情：${mood}]`);
    }
    if (text) lines.push(text);
    if (!lines.length) lines.push(files.length ? '（我给你发了几个文件，你看一下）' : '（我发了一个表情）');

    // 3) 历史先记：万一 io 挂了，至少知道这句话说过；附件信息也只在这里留一份
    appendHistory(user.id, {
      role: 'user',
      text,
      attachments: attachments.map((a, i) => ({
        uploadId: files[i].id, name: a.name, kind: a.kind, bytes: files[i].bytes,
      })),
      sticker: stickerId || undefined,
      stickerLabel: sticker ? sticker.label : undefined,
      ts: Date.now(),
    });

    // 4) 只有这一次 io：不带 stickers 目录（模型手上已经有 send_sticker 工具了）
    const io = await postJson(IO_BASE, '/v1/input', {
      text: lines.join('\n'),
      sessionId: String(body.sessionId || 'panel'),
      history: Array.isArray(body.history) ? body.history.slice(-8) : undefined,
      attachments: attachments.length ? attachments : undefined,
    }, { authorization: req.headers.authorization || '' }, 600000);

    const answer = (io.data && io.data.answer) || '';
    const ok = Boolean(io.data && io.data.ok);
    if (io.status === 401) {
      // 用户态问题：不写 assistant，也别把"未登录"当成一句话存进历史
      return sendJson(res, 401, { ok: false, code: 'E_UNAUTHORIZED', error: '会话已过期，请重新登录' });
    }
    if (ok) {
      // 一条 user + 一条 assistant：即使答案是空串也照记，回放时才看得出这一轮走完了
      appendHistory(user.id, {
        role: 'assistant',
        text: answer,
        ms: io.data && io.data.ms,
        usage: (io.data && io.data.usage) || null,
        ts: Date.now(),
      });
    } else {
      const reason = (io.data && (io.data.error || io.data.code)) || `io HTTP ${io.status}`;
      appendHistory(user.id, { role: 'error', text: String(reason), ts: Date.now() });
    }

    const publicAtts = attachments.map((a, i) => ({
      uploadId: files[i].id,
      name: a.name,
      kind: a.kind,
      bytes: files[i].bytes,
      link: `/api/upload/${files[i].id}`,
    }));

    log(`message user=${user.id} files=${files.length} sticker=${stickerId || '-'} io=${io.status} ok=${ok} ms=${Date.now() - started}`);

    return sendJson(res, 200, {
      ok,
      answer,
      ms: io.data && io.data.ms != null ? io.data.ms : Date.now() - started,
      usage: (io.data && io.data.usage) || null,
      actions: (io.data && Array.isArray(io.data.actions)) ? io.data.actions : [],
      attachments: publicAtts,
      sticker,
      error: ok ? undefined : ((io.data && (io.data.error || io.data.code)) || `io HTTP ${io.status}`),
    });
  } catch (err) {
    log(`message failed: ${err.message}`);
    return sendJson(res, 500, { ok: false, error: err.message });
  } finally {
    // 5) 不论成败都清掉这一轮的临时文件
    dropUploads(files);
  }
}

/**
 * 登录/注册限速。对公网开放之后，这是必需项：
 * 没有它，攻击者可以拿字典无限次试密码，scrypt 再慢也架不住。
 * 按来源 IP 计数，窗口过了自动清零（内存实现，重启即清空，够用）。
 */
const authAttempts = new Map(); // ip -> { count, resetAt }
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

function clientIp(req) {
  // 面板是最外层，直接取 socket；如果以后放在反代后面，再补 x-forwarded-for 处理
  const raw = (req.socket && req.socket.remoteAddress) || 'unknown';
  return raw.replace(/^::ffff:/, '');
}

function allowAuth(ip) {
  const now = Date.now();
  const hit = authAttempts.get(ip);
  if (!hit || now > hit.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  hit.count += 1;
  return hit.count <= AUTH_MAX_ATTEMPTS;
}

const handler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  // 基础安全头：公网暴露时这几个是最低成本、最有效的
  try {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('referrer-policy', 'no-referrer');
  } catch { }

  try {
    // 用户态：注册/登录/退出/会话校验都代理到 separator，浏览器只与面板同源
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }
      // 只对"会验证密码/创建账号"的接口限速；/me 和 /logout 不限
      const guarded = url.pathname.startsWith('/api/auth/login') || url.pathname.startsWith('/api/auth/register');
      if (guarded && !allowAuth(clientIp(req))) {
        return sendJson(res, 429, { ok: false, code: 'E_TOO_MANY', error: '尝试太频繁了，等十分钟再试' });
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
      const user = await currentUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
      const limit = Number(url.searchParams.get('limit') || 200);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, messages: readHistory(user.id, limit) }));
    }

    if (req.method === 'DELETE' && url.pathname === '/api/history') {
      const user = await currentUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
      clearHistory(user.id);
      log(`history cleared for user ${user.id}`);
      return sendJson(res, 200, { ok: true, cleared: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/input') {
      const user = await currentUser(req);
      if (!user) return sendJson(res, 401, { ok: false, code: 'E_UNAUTHORIZED', error: '未登录或会话已过期' });
      const raw = await readBody(req);
      let text = '';
      try {
        text = String((JSON.parse(raw.toString('utf8')) || {}).text || '').trim();
      } catch {
        /* upstream will reject it */
      }
      if (text) appendHistory(user.id, { role: 'user', text, ts: Date.now() });

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
          appendHistory(user.id, { role: 'assistant', text: data.answer || '', ms: data.ms, usage: data.usage || null, ts: Date.now() });
        } else {
          const reason = (data && (data.error || data.code)) || `HTTP ${status}`;
          appendHistory(user.id, { role: 'error', text: String(reason), ts: Date.now() });
        }
      });
    }

    // 通用附件上传：任何类型都能挂。流式写盘沿用旧视频上传那一套，不整包进内存。
    if (req.method === 'PUT' && url.pathname === '/api/upload') {
      return saveUpload(req, res, url.searchParams.get('name'), url.searchParams.get('size'),
        url.searchParams.get('kind'));
    }

    // 预览：图片/视频内联给浏览器看，文本回前 200 行，其它 415。
    // 这里不校验 Bearer（<img>/<video>/新窗口都带不了头），凭据就是不可猜的 UUID ——
    // 和 /api/studio/video 同一个理由；protectedPath 里也刻意没拦这个前缀。
    if (req.method === 'GET' && url.pathname.startsWith('/api/upload/')) {
      let id = '';
      try { id = decodeURIComponent(url.pathname.slice('/api/upload/'.length)); } catch { }
      const up = uploads.get(id);
      if (!up) {
        return sendJson(res, 404, { ok: false, error: 'UPLOAD_NOT_FOUND（可能已过期，或这条消息已经发过了）' });
      }
      let size = 0;
      try { size = fs.statSync(up.file).size; } catch { return sendJson(res, 404, { ok: false, error: 'UPLOAD_GONE' }); }
      const ext = path.extname(up.name).toLowerCase();
      // 录音是 webm 容器但只有音频：别让 <audio> 收到 video/webm
      const type = up.kind === 'audio' && ext === '.webm' ? 'audio/webm' : (UPLOAD_MIME[ext] || '');

      if (up.kind === 'image' || up.kind === 'video') {
        if (!type) return sendJson(res, 415, { ok: false, error: 'UNSUPPORTED' });
        res.writeHead(200, {
          'content-type': type,
          'content-length': size,
          'accept-ranges': 'none',
          'cache-control': 'no-store',
        });
        return fs.createReadStream(up.file).pipe(res);
      }

      // 文本预览只读前 256KB 再取 200 行：预览不是下载，别为了一份日志把内存吃满
      if (up.kind === 'text') {
        const fd = fs.openSync(up.file, 'r');
        try {
          const buf = Buffer.alloc(Math.min(size, 256 * 1024));
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          const body = buf.subarray(0, n).toString('utf8').split(/\r?\n/).slice(0, 200).join('\n');
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(body);
        } finally {
          fs.closeSync(fd);
        }
      }

      return sendJson(res, 415, { ok: false, error: 'UNSUPPORTED（这种文件不能预览）' });
    }

    // 一条消息：文字 + 附件 + 表情，只调一次 io（细节见 handleMessage）
    if (req.method === 'POST' && url.pathname === '/api/message') {
      return handleMessage(req, res);
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

      return completeVideo(req, res, v, String(body.text || '').trim());
    }

    // 原片上传（兼容旧路径）：和 /api/upload 同一套流式实现，只是调用方是老页面/老脚本
    if (req.method === 'PUT' && url.pathname === '/api/video/upload') {
      return saveUpload(req, res, url.searchParams.get('name'), url.searchParams.get('size'),
        url.searchParams.get('kind'));
    }

    // 上传完成后分析：服务器自己抽帧 + 听音轨（浏览器那条路只有帧，听不到声音）
    if (req.method === 'POST' && url.pathname === '/api/video/analyze-file') {
      const rawUp = await readBody(req, 1024 * 1024);
      let body = {};
      try { body = JSON.parse(rawUp.toString('utf8')) || {}; } catch { }
      const id = String(body.uploadId || '');
      const up = uploads.get(id);
      if (!up) return sendJson(res, 404, { ok: false, error: 'UPLOAD_NOT_FOUND（可能已过期或服务重启过）' });

      let v;
      try {
        v = await postJson(VIDEO_BASE, '/v1/analyze-file',
          { filePath: up.file, text: body.text, frames: body.frames }, {}, 900000);
      } finally {
        // 不论成败都删掉原片，别把服务器磁盘塞满
        try { fs.unlinkSync(up.file); } catch { }
        uploads.delete(id);
      }
      return completeVideo(req, res, v, String(body.text || '').trim());
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

    // 表情包：列表 + 取图 + 发一张（发不经过模型，只写进历史）
    if (req.method === 'GET' && url.pathname === '/api/stickers') {
      const q = url.searchParams.get('q') || '';
      const limit = url.searchParams.get('limit') || '60';
      const fav = url.searchParams.get('favorite') === '1' ? '&favorite=1' : '';
      const r = await fetch(`${STICKER_BASE}/v1/list?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}${fav}`,
        { signal: AbortSignal.timeout(15000) });
      const data = await r.json().catch(() => null);
      if (!data) return sendJson(res, 502, { ok: false, error: '表情包模块没响应' });
      return sendJson(res, 200, data);
    }

    if (req.method === 'GET' && url.pathname === '/api/stickers/gif') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9a-f]{6,40}$/i.test(id)) return sendJson(res, 400, { ok: false, error: 'BAD_ID' });
      const r = await fetch(`${STICKER_BASE}/v1/gif?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, {
        'content-type': 'image/gif',
        'content-length': buf.length,
        'cache-control': 'public, max-age=604800',
      });
      return res.end(buf);
    }

    // 发一张表情：记进历史，并且当成一轮对话交给模型 ——
    // 否则它根本不知道你发了图，只会对着空气继续上一句话。
    if (req.method === 'POST' && url.pathname === '/api/stickers/send') {
      const user = await currentUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8')) || {}; } catch { }
      const id = String(body.id || '');
      if (!/^[0-9a-f]{6,40}$/i.test(id)) return sendJson(res, 400, { ok: false, error: 'BAD_ID' });
      const label = String(body.mood || body.name || '表情').slice(0, 40);

      // 有表情名就用名字（快）；没名字或用户勾了"看图"才花一次视觉调用。
      // 外部传进来的 GIF 本来就没有名字，靠这条路径识字。
      let seen = '';
      const wantsLook = body.look === true || !String(body.mood || '').trim();
      if (wantsLook) {
        try {
          const d = await fetch(`${STICKER_BASE}/v1/describe?id=${encodeURIComponent(id)}`,
            { signal: AbortSignal.timeout(90000) });
          const dj = await d.json().catch(() => null);
          if (dj && dj.ok && dj.description) seen = String(dj.description).slice(0, 160);
        } catch (err) {
          log(`sticker describe failed: ${err.message}`);
        }
      }

      appendHistory(user.id, {
        role: 'user',
        text: `[表情] ${label}`,
        sticker: id,
        ts: Date.now(),
      });

      // 把"我发了什么图"翻译成模型能读的一句话。有画面描述就优先用它，
      // 否则退回到表情名 —— 名字是语义标签，也足够接话。
      const prompt = seen
        ? `（我发了一张表情包，画面上是：${seen}。就当我发了这张图，自然地接一句，别说你看到的是文字。）`
        : `（我发了一张表情包，表情叫「${label}」。就当我发了这张图，自然地接一句，别说你看到的是文字。）`;
      // 带上目录，它才可能"回敬"一张 —— 否则它手里没有 id 可填
      const io = await postJson(IO_BASE, '/v1/input',
        { text: prompt, sessionId: 'panel', stickers: await stickerCatalogForPrompt() },
        { authorization: req.headers.authorization || '' }, 600000);

      const reply = (io.data && io.data.answer) || '';
      if (reply) {
        appendHistory(user.id, {
          role: 'assistant',
          text: reply,
          ms: io.data && io.data.ms,
          usage: (io.data && io.data.usage) || null,
          ts: Date.now(),
        });
      }
      log(`sticker send id=${id} label=${label} look=${seen ? 'yes' : 'no'} reply=${reply ? 'yes' : 'no'} io=${io.status}`);
      return sendJson(res, 200, {
        ok: true,
        id,
        label,
        seen,
        reply,
        ms: (io.data && io.data.ms) || null,
        ioOk: Boolean(io.data && io.data.ok),
        error: reply ? undefined : ((io.data && (io.data.error || io.data.code)) || `io HTTP ${io.status}`),
      });
    }

    // 收藏 / 取消收藏：面板只做同源代理，重复点也幂等（表情模块自己说了算）
    if (req.method === 'POST' && url.pathname === '/api/stickers/favorite') {
      const rawFav = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(rawFav.toString('utf8')) || {}; } catch { }
      const id = String(body.id || '');
      if (!/^[0-9a-f]{6,40}$/i.test(id)) return sendJson(res, 400, { ok: false, error: 'BAD_ID' });
      const name = String(body.name || '').trim().slice(0, 40);
      const note = String(body.note || '').trim().slice(0, 160);
      const payload = { id };
      if (name) payload.name = name;
      if (note) payload.note = note;
      const r = await postJson(STICKER_BASE, '/v1/favorite', payload, {}, 20000);
      if (!r.data) return sendJson(res, 502, { ok: false, error: `表情包模块没响应（HTTP ${r.status}）` });
      log(`sticker favorite on id=${id} name=${name || '-'} ok=${r.data.ok} http=${r.status}`);
      return sendJson(res, r.status || 200, r.data);
    }

    if (req.method === 'DELETE' && url.pathname === '/api/stickers/favorite') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9a-f]{6,40}$/i.test(id)) return sendJson(res, 400, { ok: false, error: 'BAD_ID' });
      const r = await fetch(`${STICKER_BASE}/v1/favorite?id=${encodeURIComponent(id)}`,
        { method: 'DELETE', signal: AbortSignal.timeout(20000) });
      const data = await r.json().catch(() => null);
      if (!data) return sendJson(res, 502, { ok: false, error: '表情包模块没响应' });
      log(`sticker favorite off id=${id} ok=${data.ok} http=${r.status}`);
      return sendJson(res, r.status || 200, data);
    }

    // 视频创作：DSH 只写分镜，ffmpeg 渲染（模型不生成像素）
    if (req.method === 'POST' && url.pathname === '/api/studio/create') {
      const rawStudio = await readBody(req, 1024 * 1024);
      let body = {};
      try { body = JSON.parse(rawStudio.toString('utf8')) || {}; } catch { }
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { ok: false, error: '先写一句想要什么' });
      const r = await postJson(STUDIO_BASE, '/v1/create', {
        prompt,
        seconds: Number(body.seconds) || 12,
        voice: body.voice || '',
        bgm: body.bgm || '',
      }, { authorization: req.headers.authorization || '' }, 1200000);
      if (!r.data) return sendJson(res, 502, { ok: false, error: `studio HTTP ${r.status}` });
      log(`studio create ok=${r.data.ok} job=${r.data.jobId || '-'} ms=${r.data.ms || 0}`);
      return sendJson(res, r.status || 200, r.data);
    }

    // 只写分镜：把「写」和「渲染」拆开，人在面板里改完再花那 15~40 秒。
    if (req.method === 'POST' && url.pathname === '/api/studio/plan') {
      const rawPlan = await readBody(req, 1024 * 1024);
      let body = {};
      try { body = JSON.parse(rawPlan.toString('utf8')) || {}; } catch { }
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { ok: false, error: '先写一句想要什么' });
      const r = await postJson(STUDIO_BASE, '/v1/plan', {
        prompt,
        seconds: Number(body.seconds) || 12,
      }, { authorization: req.headers.authorization || '' }, 180000);
      if (!r.data) return sendJson(res, 502, { ok: false, error: `studio HTTP ${r.status}` });
      const scenes = (r.data.plan && Array.isArray(r.data.plan.scenes)) ? r.data.plan.scenes.length : 0;
      log(`studio plan ok=${r.data.ok} scenes=${scenes} ms=${r.data.ms || 0}`);
      return sendJson(res, r.status || 200, r.data);
    }

    // 用面板改过的分镜重渲：分镜本身只有几 KB，1MB 上限绰绰有余。
    // 只校验「像不像一份分镜」，具体字段让 studio 自己判（它才是渲染方，规则改了我不用跟着改）。
    if (req.method === 'POST' && url.pathname === '/api/studio/render') {
      const rawRender = await readBody(req, 1024 * 1024);
      let body = {};
      try { body = JSON.parse(rawRender.toString('utf8')) || {}; } catch { }
      const plan = body.plan;
      if (!plan || !Array.isArray(plan.scenes) || !plan.scenes.length) {
        return sendJson(res, 400, { ok: false, error: '分镜是空的' });
      }
      const r = await postJson(STUDIO_BASE, '/v1/render', {
        plan,
        voice: body.voice || '',
        bgm: body.bgm || '',
      }, { authorization: req.headers.authorization || '' }, 1200000);
      if (!r.data) return sendJson(res, 502, { ok: false, error: `studio HTTP ${r.status}` });
      log(`studio render ok=${r.data.ok} job=${r.data.jobId || '-'} ms=${r.data.ms || 0}`);
      return sendJson(res, r.status || 200, r.data);
    }

    // 成片取回。用不可猜的 UUID 当凭据，所以不额外要求 Bearer（<video> 带不了头）。
    if (req.method === 'GET' && url.pathname === '/api/studio/video') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return sendJson(res, 400, { ok: false, error: 'BAD_ID' });
      }
      const file = path.join(STUDIO_DIR, `${id}.mp4`);
      if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': stat.size,
        'accept-ranges': 'none',
        'cache-control': 'no-store',
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(res, url.pathname);
    }

    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
};

/**
 * 给提示词用的表情目录（id + 名字）。失败就返回 undefined ——
 * 目录缺席只会让它不发图，不该让整轮对话挂掉。
 */
async function stickerCatalogForPrompt(limit = 80) {
  try {
    const r = await fetch(`${STICKER_BASE}/v1/list?limit=${limit}`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json().catch(() => null);
    if (!data || !data.ok || !Array.isArray(data.items)) return undefined;
    return data.items.slice(0, limit).map((it) => ({ id: it.id, name: it.mood || it.name || it.id }));
  } catch {
    return undefined;
  }
}

const server = http.createServer(handler);

// ---- 可选 HTTPS ---------------------------------------------------------
// 公网直连必须走 TLS：一是密码不能明文过网，二是浏览器只在"安全上下文"
// （https 或 localhost）里给麦克风权限 —— 上了 https，手机上也能按着说话。
// 用 PFX（Windows 自签证书导出格式）省掉 pem 转换。
const TLS_PORT = Number(process.env.DSH_PANEL_TLS_PORT || 0);
// HTTPS 默认监听所有网卡（要对公网开放）；HTTP 那个口保持 127.0.0.1，只给隧道/本机用。
const TLS_HOST = process.env.DSH_PANEL_TLS_HOST || '0.0.0.0';
const TLS_PFX = process.env.DSH_PANEL_PFX || path.join(DATA_DIR, 'panel-cert.pfx');
const TLS_PASS = process.env.DSH_PANEL_PFX_PASS || '';

let tlsServer = null;
if (TLS_PORT > 0) {
  if (fs.existsSync(TLS_PFX)) {
    try {
      tlsServer = https.createServer({ pfx: fs.readFileSync(TLS_PFX), passphrase: TLS_PASS }, handler);
      tlsServer.on('tlsClientError', (err) => log(`tls client error: ${err.message}`));
      tlsServer.listen(TLS_PORT, TLS_HOST, () => {
        log(`listening on https://${TLS_HOST}:${TLS_PORT} (pfx=${path.basename(TLS_PFX)})`);
      });
    } catch (err) {
      log(`TLS disabled, cannot load ${TLS_PFX}: ${err.message}`);
    }
  } else {
    log(`TLS requested (port ${TLS_PORT}) but ${TLS_PFX} is missing`);
  }
}

server.listen(PORT, HOST, () => {
  ensureDataDir();
  archiveLegacyHistory();
  log(`listening on http://${HOST}:${PORT}  io=${IO_BASE}  separator=${SEPARATOR_BASE}  history=${HISTORY_DIR}`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  if (tlsServer) tlsServer.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
