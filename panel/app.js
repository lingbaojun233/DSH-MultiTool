'use strict';

const logEl = document.getElementById('log');
const emptyEl = document.getElementById('empty');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const tabsEl = document.getElementById('tabs');
const viewTitle = document.getElementById('viewTitle');
const tabAdmin = document.getElementById('tabAdmin');

const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const userBox = document.getElementById('userBox');
const userName = document.getElementById('userName');

const authOverlay = document.getElementById('authOverlay');
const authForm = document.getElementById('authForm');
const authTitle = document.getElementById('authTitle');
const authSub = document.getElementById('authSub');
const authUsername = document.getElementById('authUsername');
const authPassword = document.getElementById('authPassword');
const authDisplayRow = document.getElementById('authDisplayRow');
const authDisplayName = document.getElementById('authDisplayName');
const authInviteRow = document.getElementById('authInviteRow');
const authInvite = document.getElementById('authInvite');
const authError = document.getElementById('authError');
const authSubmit = document.getElementById('authSubmit');
const authSwitch = document.getElementById('authSwitch');
const authSwitchHint = document.getElementById('authSwitchHint');

const hasMarkdown = typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined';

if (hasMarkdown) {
  window.marked.setOptions({ gfm: true, breaks: true });
}

let busy = false;

// 最近几轮对话（发给 io 作为上下文），刷新后从服务端历史回填
const recentTurns = [];

// 会话 id：用于记忆证据定位（chat:<sessionId>#u<时间戳>），存在浏览器里
const SESSION_KEY = 'dsh-panel-session';
function getSessionId() {
  let id = '';
  try {
    id = window.localStorage.getItem(SESSION_KEY) || '';
  } catch (err) {
    id = '';
  }
  if (!id) {
    id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      window.localStorage.setItem(SESSION_KEY, id);
    } catch (err) {
      /* 隐私模式下忽略 */
    }
  }
  return id;
}

// ---- 用户态：token、请求头、登录/注册浮层 ----------------------------------

const TOKEN_KEY = 'dsh-panel-token';

function readToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch (err) {
    return '';
  }
}

function saveToken(token) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch (err) {
    /* 隐私模式下存不住，本次打开仍然可用 */
  }
}

function clearToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch (err) {
    /* 忽略 */
  }
}

let authToken = readToken();
let currentUser = null;
let authMode = 'login';
let authBusy = false;

/** 所有走面板后端的请求都带上 Bearer；没登录时不带，让服务端回 401。 */
function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return headers;
}

async function apiFetch(url, options) {
  const opts = Object.assign({ cache: 'no-store' }, options || {});
  opts.headers = authHeaders(opts.headers);
  return fetch(url, opts);
}

/** 取 JSON；401 统一按「会话过期」处理，返回 null 让调用方安静退出。 */
async function apiJson(url, options) {
  const res = await apiFetch(url, options);
  if (res.status === 401) {
    handleUnauthorized('会话过期，请重新登录');
    return null;
  }
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function setAuthError(text) {
  authError.textContent = text || '';
  authError.classList.toggle('hidden', !text);
}

function setLocked(locked) {
  inputEl.disabled = locked;
  inputEl.placeholder = locked ? '请先登录后再输入…' : '输入内容… 也可以挂图片 / 视频 / 音频 / 文档（可多选）';
  sendBtn.disabled = locked || busy;
}

/** 顶栏用户区：未登录显示「登录」，登录后显示显示名 +「退出」。 */
function renderUser() {
  const logged = Boolean(currentUser);
  loginBtn.classList.toggle('hidden', logged);
  userBox.classList.toggle('hidden', !logged);
  if (logged) {
    userName.textContent = currentUser.displayName || currentUser.username || '';
    userName.title = currentUser.username ? `@${currentUser.username}` : '';
  } else {
    userName.textContent = '';
    userName.title = '';
  }
  setLocked(!logged);
}

/** 打开登录/注册浮层；mode 只认 'login' / 'register'。 */
function showAuth(mode, message) {
  authMode = mode === 'register' ? 'register' : 'login';
  const register = authMode === 'register';

  authTitle.textContent = register ? '注册' : '登录';
  authSub.textContent = register
    ? '注册后会为大肥鱼建立一份只属于你的相处档案。'
    : '登录后才能和核心对话。';
  authSubmit.textContent = register ? '注册并登录' : '登录';
  authSwitchHint.textContent = register ? '已经有账号？' : '还没有账号？';
  authSwitch.textContent = register ? '去登录' : '注册一个';

  authDisplayRow.classList.toggle('hidden', !register);
  // 邀请码只在注册时出现；服务端是 closed 模式时填了也没用，所以不做额外判断
  if (authInviteRow) authInviteRow.classList.toggle('hidden', !register);
  authPassword.autocomplete = register ? 'new-password' : 'current-password';
  if (register) authPassword.setAttribute('minlength', '6');
  else authPassword.removeAttribute('minlength');

  setAuthError(message || '');
  authOverlay.classList.remove('hidden');
  authOverlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('authing');
  authUsername.focus();
}

function hideAuth() {
  authOverlay.classList.add('hidden');
  authOverlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('authing');
  setAuthError('');
  authPassword.value = '';
}

/** 收到 401：清本地 token、锁住输入、弹登录层。 */
function handleUnauthorized(message) {
  clearToken();
  authToken = '';
  currentUser = null;
  recentTurns.length = 0;
  renderUser();
  showAuth('login', message || '会话过期，请重新登录');
}

/** 管理员面板：列出账号，可删除（不能删自己）。非管理员整块隐藏。 */
async function loadAdminPanel() {
  const isAdmin = Boolean(currentUser) && currentUser.role === 'admin';
  if (tabAdmin) tabAdmin.classList.toggle('hidden', !isAdmin);
  if (!isAdmin) return;
  const list = document.getElementById('adminUsers');
  const count = document.getElementById('adminCount');
  try {
    const data = await apiJson('/api/admin/users');
    const users = (data && data.users) || [];
    if (count) count.textContent = users.length + ' 个';
    list.innerHTML = users.map((u) => {
      const self = u.id === currentUser.id;
      return '<li data-uid="' + u.id + '"><div>' + escapeHtml(u.display_name || u.username)
        + (self ? '（我）' : '') + ' <span class="ev-meta">@' + escapeHtml(u.username)
        + ' · ' + escapeHtml(u.role) + '</span></div>'
        + (self ? '' : '<button class="ghost danger" data-del="' + u.id + '">删除</button>')
        + '</li>';
    }).join('') || '<li class="ev-meta">（暂无账号）</li>';

    list.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = Number(btn.dataset.del);
        if (!window.confirm('删除这个账号连同其全部记忆？不可恢复。')) return;
        try {
          await apiFetch('/api/admin/users/' + uid, { method: 'DELETE' });
          await loadAdminPanel();
        } catch (err) {
          window.alert('删除失败：' + (err && err.message ? err.message : err));
        }
      });
    });
  } catch (err) {
    list.innerHTML = '<li class="ev-meta">加载失败：' + escapeHtml(err && err.message ? err.message : String(err)) + '</li>';
  }
}

/** 登录/注册成功后进入用户态。 */
function enterSession(data) {
  saveToken(data.token);
  authToken = data.token;
  currentUser = data.user || null;
  authDisplayName.value = '';
  renderUser();
  hideAuth();
  refreshHealth();
  loadHistory();
  if (currentUser) inputEl.focus();
  loadAdminPanel();
  enterVideoV2();
}

async function logout() {
  const token = authToken;
  if (!token) {
    handleUnauthorized('');
    return;
  }
  try {
    // 让服务端把这条会话删掉，再清本地；网络失败也照样退出
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      cache: 'no-store',
    });
  } catch (err) {
    /* 忽略：本地退出不受影响 */
  }
  clearToken();
  authToken = '';
  currentUser = null;
  recentTurns.length = 0;
  // 退出就把没发出去的附件一起丢掉：下一个登录的人不该看到别人的文件
  attachments = [];
  pickedSticker = null;
  renderAttachChips();
  renderUser();
  showEmpty();
  showAuth('login', '');
}

// ---- 状态与渲染 ------------------------------------------------------------

function setStatus(kind, text) {
  statusEl.className = `status ${kind}`;
  statusText.textContent = text;
}

/**
 * Model output is untrusted: render Markdown, then sanitize before touching DOM.
 * Without the libraries the bubble falls back to plain text.
 */
function renderMarkdown(text) {
  if (!hasMarkdown) return null;
  try {
    const html = window.marked.parse(text);
    return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  } catch (err) {
    return null;
  }
}

/** 把 io 返回的 usage 变成一句人话：用了多少记忆、写了什么。 */
function usageNote(usage) {
  if (!usage) return '';
  const parts = [];
  const used = usage.memory && usage.memory.used;
  if (used) parts.push('记忆 ' + used + ' 条');
  const d = usage.delta;
  if (d) {
    const bits = [];
    if (d.events) bits.push('事件 +' + d.events);
    if (d.facts) bits.push('事实 +' + d.facts);
    if (bits.length) parts.push(bits.join(' '));
  }
  return parts.length ? ' · ' + parts.join(' · ') : '';
}
// ---------------------------------------------------------------- 听力 ----

const micBtn = document.getElementById('mic');
let recorder = null;
let recordChunks = [];

/** 录音只在浏览器里生成 webm/ogg：落盘名跟着容器走，kind 则明确告诉服务端是 audio。 */
function recordingFileName(type) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
  const ext = String(type || '').includes('ogg') ? 'ogg' : String(type || '').includes('wav') ? 'wav' : 'webm';
  return `录音-${stamp}.${ext}`;
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    micBtn.title = '这个浏览器不支持录音';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recordChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      micBtn.classList.remove('recording');
      micBtn.textContent = '…';
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(recordChunks, { type });
      recorder = null;
      try {
        // 录音不再先转文字填输入框：原声直接当一个 audio 附件挂在这条消息上，
        // 让模型自己决定 hear / transcribe（少一次 ASR 调用，也不打断说话）。
        const file = new File([blob], recordingFileName(type), { type: type || 'audio/webm' });
        addAttachment(file, 'audio');
        micBtn.title = '录音已挂上，和文字一起发';
      } catch (err) {
        micBtn.title = '录音处理失败：' + (err && err.message || err);
      } finally {
        micBtn.textContent = '🎤';
      }
    };
    recorder.start();
    micBtn.classList.add('recording');
    micBtn.textContent = '⏺';
    micBtn.title = '正在录音，点一下结束';
  } catch (err) {
    micBtn.title = '拿不到麦克风：' + (err && err.message || err);
  }
}

if (micBtn) {
  micBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    } else {
      startRecording();
    }
  });
}

function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let currentAudio = null;

/** 把一段回复读出来：后端 SAPI 合成 wav，前端直接播。 */
async function speakText(text, btn) {
  if (!text) return;
  if (currentAudio) {
    try { currentAudio.pause(); } catch { }
    currentAudio = null;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await apiFetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('audio/')) {
      const detail = await res.text().catch(() => '');
      throw new Error(detail.slice(0, 120) || '不是音频');
    }
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      btn.textContent = original;
      btn.disabled = false;
      if (currentAudio === audio) currentAudio = null;
    };
    await audio.play();
    btn.textContent = '⏹';
  } catch (err) {
    btn.textContent = '🔇';
    btn.title = '读不出来：' + (err && err.message || err);
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1400);
  }
}

// 大肥鱼会自己发表情：回复里带 [sticker:<id>]，单独一行或句尾都可能。
// 全角括号、冒号两侧的空格都认；[收藏这张] 是"把刚发的这张收起来"的指令，不能念出来。
const REPLY_MARK_RE = /[ \t]*[\[【]\s*(?:sticker\s*[:：]\s*([0-9a-z][0-9a-z_-]{2,63})|收藏这张)\s*[\]】]/gi;

/**
 * 把回复拆成「文字 / 表情」段：正文去掉标记，表情按出现顺序排队。
 * 返回 { text, segments, stickers, favorite }，text 是剥掉标记后的正文。
 */
function parseReplyMarks(text) {
  const src = String(text == null ? '' : text);
  const segments = [];
  const stickers = [];
  let favorite = false;
  let cursor = 0;

  REPLY_MARK_RE.lastIndex = 0;
  let m;
  while ((m = REPLY_MARK_RE.exec(src))) {
    const before = src.slice(cursor, m.index);
    if (before) segments.push({ kind: 'text', text: before });
    cursor = m.index + m[0].length;
    if (m[1]) {
      const id = String(m[1]).trim();
      stickers.push(id);
      segments.push({ kind: 'sticker', id });
    } else {
      favorite = true;
    }
  }
  const tail = src.slice(cursor);
  if (tail) segments.push({ kind: 'text', text: tail });

  const cleaned = src
    .replace(REPLY_MARK_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: cleaned, segments, stickers, favorite };
}

/** 历史记录里的 stickers 字段：去掉正文标记已经渲染过的，免得同一张出现两次。 */
function extraStickerIds(text, list) {
  if (!Array.isArray(list) || !list.length) return [];
  const seen = new Set(parseReplyMarks(text).stickers);
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (!/^[0-9a-z][0-9a-z_-]{2,63}$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 一条回复拆成几条短消息：像真人那样一条一条发，而不是甩一大段。
 * 先按换行切（模型常这么分条），过长再按句末标点切，还长就硬切。
 */
function splitBubbles(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const out = [];
  const pushChunk = (chunk) => {
    const s = chunk.trim();
    if (!s) return;
    if (s.length <= 60) { out.push(s); return; }
    const parts = s.split(/(?<=[。！？!?…~～])\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length <= 1) {
      for (let i = 0; i < s.length; i += 40) out.push(s.slice(i, i + 40));
      return;
    }
    for (const p of parts) {
      if (p.length <= 60) out.push(p);
      else for (let i = 0; i < p.length; i += 40) out.push(p.slice(i, i + 40));
    }
  };
  for (const line of raw.split(/\n+/)) pushChunk(line);
  return out.length ? out : [raw];
}

/** 按"多条消息"渲染；只有最后一条文字挂朗读按钮，读的是整段（不含表情标记）。 */
async function addReplySeries(text, meta, options = {}) {
  const parsed = parseReplyMarks(text);

  // 标记处断开：文字段照旧拆气泡，表情位置插入一条纯图片气泡，顺序跟正文一致
  const blocks = [];
  for (const seg of parsed.segments) {
    if (seg.kind === 'sticker') {
      blocks.push({ kind: 'sticker', id: seg.id });
    } else {
      for (const part of splitBubbles(seg.text)) blocks.push({ kind: 'text', text: part });
    }
  }
  if (!blocks.length) {
    addMessage('assistant', '（空答案）', meta);
    return null;
  }

  let lastTextIndex = -1;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].kind === 'text') lastTextIndex = i;

  let last = null;
  for (let i = 0; i < blocks.length; i++) {
    const isLast = i === blocks.length - 1;
    const block = blocks[i];
    if (block.kind === 'sticker') {
      // 纯图片不挂朗读按钮：addMessage 只在有文字时才加 🔊
      last = addMessage('assistant', '', isLast ? meta : '', { sticker: block.id });
    } else {
      last = addMessage('assistant', block.text, isLast ? meta : '', { noSpeak: i !== lastTextIndex });
      if (i === lastTextIndex) {
        const btn = last.querySelector('.msg-tools .iconbtn');
        if (btn) {
          btn.title = '读出来（整段）';
          btn.replaceWith(btn.cloneNode(true));
          const fresh = last.querySelector('.msg-tools .iconbtn');
          fresh.addEventListener('click', () => speakText(parsed.text, fresh));
        }
      }
    }
    if (!isLast && !options.instant) {
      await new Promise((r) => setTimeout(r, 380));
    }
  }
  return last;
}

function addMessage(role, text, meta, options) {
  // showEmpty() 会重建节点头，这里按选择器找当前节点，避免用失效引用
  const placeholder = logEl.querySelector('.empty');
  if (placeholder) placeholder.remove();

  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (options && options.sticker) {
    // 表情是图片气泡：文字只作为 alt（无图时也能看出是什么）
    const img = document.createElement('img');
    img.className = 'bubble-sticker';
    img.alt = text || '表情';
    img.loading = 'lazy';
    img.src = `/api/stickers/gif?id=${encodeURIComponent(options.sticker)}`;
    bubble.appendChild(img);
    bubble.classList.add('bubble-media');
  } else {
    const html = role === 'assistant' ? renderMarkdown(text) : null;
    if (html !== null) {
      bubble.classList.add('md');
      bubble.innerHTML = html;
    } else {
      bubble.textContent = text;
    }
  }

  wrap.appendChild(bubble);

  // 每条回复都可以点「读出来」（本地 SAPI 合成，不花 API 钱）
  if (role === 'assistant' && text && !(options && options.noSpeak)) {
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'iconbtn';
    btn.title = '读出来';
    btn.textContent = '🔊';
    btn.addEventListener('click', () => speakText(text, btn));
    tools.appendChild(btn);
    wrap.appendChild(tools);
  }

  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = meta;
    wrap.appendChild(metaEl);
  }

  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
  return wrap;
}

function addPending() {
  const wrap = addMessage('assistant', '');
  wrap.querySelector('.bubble').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  logEl.scrollTop = logEl.scrollHeight;
  return wrap;
}

function showEmpty() {
  logEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'empty';
  div.id = 'empty';
  div.textContent = '在下面输入内容，也可以挂图片 / 视频 / 音频 / 文档，一起发给我。';
  logEl.appendChild(div);
}

/**
 * The server keeps the transcript; a refresh replays it.
 */
async function loadHistory() {
  try {
    const data = await apiJson('/api/history?limit=200');
    if (!data) return;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (!messages.length) return;

    logEl.innerHTML = '';
    for (const m of messages) {
      if (m.role === 'assistant') {
        const meta = typeof m.ms === 'number' ? `${(m.ms / 1000).toFixed(1)} 秒 · ${formatClock(m.ts)}` : formatClock(m.ts);
        await addReplySeries(m.text || '', meta + usageNote(m.usage), { instant: true });
        // 历史里单独存了表情（正文可能没有标记）：补上还没渲染的那几张
        for (const id of extraStickerIds(m.text || '', m.stickers)) {
          addMessage('assistant', '', '', { sticker: id });
        }
      } else if (m.role === 'user') {
        // 历史里的用户消息：附件只剩元数据（文件已经删了），但链接还拼得出来
        addUserMessage(m.text || '', formatClock(m.ts), {
          sticker: m.sticker ? { id: m.sticker, label: m.stickerLabel || '' } : null,
          attachments: Array.isArray(m.attachments) ? m.attachments : [],
        });
      } else {
        addMessage('error', m.text || '（错误）', formatClock(m.ts));
      }
    }
    logEl.scrollTop = logEl.scrollHeight;

    // 回填上下文，避免刷新后模型"失忆"
    recentTurns.length = 0;
    for (const m of messages.slice(-8)) {
      if (m.role === 'user') recentTurns.push({ role: 'user', text: m.text || '' });
      else if (m.role === 'assistant') recentTurns.push({ role: 'assistant', text: m.text || '' });
    }
  } catch (err) {
    /* offline: start with an empty transcript */
  }
}

async function refreshHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    const ready = Boolean(data.ok) && (!data.core || data.core.ready !== false);
    setStatus(ready ? 'online' : 'offline', ready ? '核心就绪' : '核心未就绪');
  } catch (err) {
    setStatus('offline', '连接断开');
  }
}

// ------------------------------------- 聊天里的附件（什么都能发） --

const attachBtn = document.getElementById('attach');
const attachFile = document.getElementById('attachFile');
const attachList = document.getElementById('attachList');
const composerHint = document.querySelector('.composer-actions .hint');

// 待发送的附件：顺序就是用户挑的顺序；发送时整体快照，再清空
let attachments = [];      // [{ key, file, name, kind, size, kindHint }]
let pickedSticker = null;  // { id, mood } —— 表情和文字一起发，不再单独发一轮
let uploading = false;

const KIND_ICON = { video: '🎬', audio: '🎵', image: '🖼️', text: '📄', other: '📦' };
const MAX_ATTACHMENTS = 10; // io 那边也只收 10 个，这里先挡住

// 和 server.js 的 KIND_BY_EXT 同一张表：前端只用来挑图标，
// 真正的 kind 由服务端按扩展名再判一次（录音会显式带上 kind=audio）。
const KIND_BY_EXT = {
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video', '.avi': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.ogg': 'audio', '.flac': 'audio', '.aac': 'audio',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.csv': 'text', '.log': 'text', '.srt': 'text',
  '.js': 'text', '.ts': 'text', '.py': 'text', '.ps1': 'text', '.yaml': 'text', '.yml': 'text',
};

function kindOfName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  const ext = i >= 0 ? s.slice(i).toLowerCase() : '';
  return KIND_BY_EXT[ext] || 'other';
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 底栏那句提示平时说明快捷键；出错/超限时临时借用，几秒后自己换回来
let hintTimer = null;
function flashHint(text) {
  if (!composerHint) return;
  composerHint.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { composerHint.textContent = 'Ctrl+Enter 发送 · Enter 换行'; }, 2600);
}

/** 挑一个文件：kind 按扩展名猜，录音这类容器与内容不一致的由调用方显式指定。 */
function addAttachment(file, kindOverride) {
  if (!file) return;
  if (attachments.length >= MAX_ATTACHMENTS) {
    flashHint(`一次最多挂 ${MAX_ATTACHMENTS} 个文件`);
    return;
  }
  const name = file.name || 'upload.bin';
  attachments.push({
    key: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    file,
    name,
    kind: kindOverride || kindOfName(name),
    kindHint: kindOverride || '',
    size: Number(file.size) || 0,
  });
  renderAttachChips();
}

/** 输入框上方那排 chip：每个附件一张，带图标/名字/大小，可单独移除；上传时下面再挂总进度。 */
function renderAttachChips() {
  if (!attachList) return;
  attachList.innerHTML = '';
  const has = attachments.length || pickedSticker || uploading;
  attachList.classList.toggle('hidden', !has);
  if (!has) return;

  for (const a of attachments) {
    const chip = document.createElement('div');
    chip.className = `attach-chip ${a.kind}`;

    const icon = document.createElement('span');
    icon.className = 'attach-icon';
    icon.textContent = KIND_ICON[a.kind] || KIND_ICON.other;

    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = a.name;
    name.title = a.name;

    const size = document.createElement('span');
    size.className = 'attach-size';
    size.textContent = formatBytes(a.size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attach-x';
    remove.textContent = '×';
    remove.title = '移除';
    remove.onclick = () => {
      attachments = attachments.filter((x) => x.key !== a.key);
      renderAttachChips();
    };

    chip.append(icon, name, size, remove);
    attachList.appendChild(chip);
  }

  if (pickedSticker) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip sticker';
    const icon = document.createElement('span');
    icon.className = 'attach-icon';
    icon.textContent = '😀';
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = `表情：${pickedSticker.mood || '表情'}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attach-x';
    remove.textContent = '×';
    remove.title = '移除';
    remove.onclick = () => { pickedSticker = null; renderAttachChips(); };
    chip.append(icon, name, remove);
    attachList.appendChild(chip);
  }

  // 多文件时是"已发字节 / 总字节"，单文件时百分比也一样准，所以只留这一种进度条
  if (uploading) {
    const row = document.createElement('div');
    row.className = 'attach-total';
    const label = document.createElement('span');
    label.className = 'attach-total-label';
    label.id = 'attachTotalLabel';
    label.textContent = '上传 0%';
    const wrap = document.createElement('div');
    wrap.className = 'attach-bar';
    const bar = document.createElement('div');
    bar.className = 'attach-bar-fill';
    bar.id = 'attachTotalBar';
    wrap.appendChild(bar);
    row.append(label, wrap);
    attachList.appendChild(row);
  }
}

function setUploadProgress(frac) {
  const bar = document.getElementById('attachTotalBar');
  const label = document.getElementById('attachTotalLabel');
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  if (bar) bar.style.width = pct + '%';
  if (label) label.textContent = `上传 ${pct}%`;
}

/** 单个文件 PUT 直传（XHR 才有上传进度）；不走 base64，也不整包读进内存。 */
function uploadFile(item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const hint = item.kindHint ? `&kind=${encodeURIComponent(item.kindHint)}` : '';
    xhr.open('PUT', `/api/upload?name=${encodeURIComponent(item.name)}&size=${item.size}${hint}`);
    const h = authHeaders({});
    Object.keys(h).forEach((k) => xhr.setRequestHeader(k, h[k]));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { }
      if (!data) return reject(new Error('服务器返回不是 JSON'));
      if (!data.ok) {
        // 把状态码和错误码带回去：调用方要区分"没登录"和"文件太大"
        const err = new Error(data.error || `HTTP ${xhr.status}`);
        err.status = xhr.status;
        err.code = String(data.code || '');
        return reject(err);
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('上传失败（网络中断或面板不可达）'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.send(item.file);
  });
}

/**
 * 串行上传，进度按总字节算：多文件时用户想看到的是"这一条消息发了多少"，
 * 而不是每个文件各自从 0 跳到 100。
 */
async function uploadAll(items, onProgress) {
  const total = items.reduce((sum, it) => sum + (it.size || 0), 0) || 1;
  let done = 0;
  const ids = [];
  for (const it of items) {
    const data = await uploadFile(it, (frac) => {
      if (onProgress) onProgress((done + (it.size || 0) * frac) / total);
    });
    done += it.size || 0;
    if (onProgress) onProgress(done / total);
    ids.push(data.uploadId);
  }
  return ids;
}

/** 读音频时长；浏览器解不了就 reject，气泡那边会退回"只显示文件名"。 */
function probeAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const sec = audio.duration;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(sec) ? sec : 0);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('读不到时长'));
    };
    audio.src = url;
  });
}

function fileMetaNode(info) {
  const icon = document.createElement('span');
  icon.className = 'bubble-file-icon';
  icon.textContent = KIND_ICON[info.kind || 'other'] || KIND_ICON.other;

  const body = document.createElement('span');
  body.className = 'bubble-file-meta';
  const name = document.createElement('span');
  name.className = 'bubble-file-name';
  name.textContent = info.name || '文件';
  const sub = document.createElement('span');
  sub.className = 'bubble-file-sub';
  sub.textContent = formatBytes(info.size);
  body.append(name, sub);
  return { icon, body, sub };
}

/** 气泡里的一个附件。刚发出去的有本地 File（能做缩略图/时长），
 * 从历史回放的只有名字；两者用同一个节点，结构不会因为刷新而变样。
 */
function userFileCard(info) {
  const kind = info.kind || 'other';
  const card = document.createElement('a');
  card.className = `bubble-file ${kind}`;
  card.title = info.name || '';
  // 有 uploadId 才给链接：预览路由凭 UUID，能看原图/原文件；文件被清掉就是 404
  if (info.uploadId) {
    card.href = `/api/upload/${encodeURIComponent(info.uploadId)}`;
    card.target = '_blank';
    card.rel = 'noopener';
  }

  const { icon, body, sub } = fileMetaNode({ kind, name: info.name, size: info.size });

  // 图片：本地 File 直接出缩略图。发送后服务端会删文件，所以缩略图必须靠本地 blob，
  // 不能指望 /api/upload/:id —— 那正是"点开看原图"用的，不是缩略图用的。
  if (kind === 'image' && (info.file || info.uploadId)) {
    const img = document.createElement('img');
    img.className = 'bubble-thumb';
    img.alt = info.name || '图片';
    img.loading = 'lazy';
    if (info.file) {
      img.src = URL.createObjectURL(info.file);
    } else {
      img.src = `/api/upload/${encodeURIComponent(info.uploadId)}`;
      // 历史里的文件早被删了：别留一个破图标，退回成"图标 + 文件名"的卡片
      img.onerror = () => {
        card.textContent = '';
        card.classList.remove('image');
        card.append(icon, body);
      };
    }
    card.appendChild(img);
    return card;
  }

  card.append(icon, body);

  // 音频有时长就补上；拿不到就只显示文件名，够用了
  if (kind === 'audio' && info.file) {
    probeAudioDuration(info.file).then((sec) => {
      if (sec > 0) sub.textContent = `${fmtClock(sec)} · ${formatBytes(info.size)}`;
    }).catch(() => { });
  }
  return card;
}

/**
 * 一条用户消息 = 一个气泡组。
 * 文字、表情、附件都塞进同一个 .bubble —— 拆成多条气泡的话，
 * 回看时就分不清哪些东西是"一起发出去"的了。
 */
function addUserMessage(text, meta, opts = {}) {
  const placeholder = logEl.querySelector('.empty');
  if (placeholder) placeholder.remove();

  const wrap = document.createElement('div');
  wrap.className = 'msg user';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (opts.sticker && opts.sticker.id) {
    const img = document.createElement('img');
    img.className = 'bubble-sticker';
    img.alt = opts.sticker.label ? `表情：${opts.sticker.label}` : '表情';
    img.title = img.alt;
    img.loading = 'lazy';
    img.src = `/api/stickers/gif?id=${encodeURIComponent(opts.sticker.id)}`;
    bubble.appendChild(img);
  }

  if (text) {
    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }

  const files = Array.isArray(opts.files) ? opts.files : [];
  const saved = Array.isArray(opts.attachments) ? opts.attachments : [];
  if (files.length || saved.length) {
    const list = document.createElement('div');
    list.className = 'bubble-files';
    for (const it of files) {
      list.appendChild(userFileCard({ name: it.name, kind: it.kind, size: it.size, file: it.file }));
    }
    for (const it of saved) {
      list.appendChild(userFileCard({ name: it.name, kind: it.kind, size: it.bytes, uploadId: it.uploadId }));
    }
    bubble.appendChild(list);
  }

  wrap.appendChild(bubble);

  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = meta;
    wrap.appendChild(metaEl);
  }

  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
  return wrap;
}

/**
 * 发完之后服务端才给出 uploadId：把气泡里那几张卡片补上"点开看原件"的链接。
 * 顺序和上传顺序一致（服务端按 uploadIds 原序返回）。
 */
function wireSentAttachmentLinks(wrap, links) {
  if (!wrap || !Array.isArray(links) || !links.length) return;
  const cards = wrap.querySelectorAll('.bubble-files .bubble-file');
  for (let i = 0; i < cards.length && i < links.length; i++) {
    const link = links[i];
    if (!link || !link.link) continue;
    cards[i].href = link.link;
    cards[i].target = '_blank';
    cards[i].rel = 'noopener';
    cards[i].title = link.name || '';
  }
}

if (attachBtn) {
  attachBtn.addEventListener('click', () => attachFile.click());
  attachFile.addEventListener('change', () => {
    const files = Array.from(attachFile.files || []);
    // 先清 value：连着选同一个文件两次也要能触发 change
    attachFile.value = '';
    for (const f of files) addAttachment(f);
  });
}

/**
 * 发送：一条消息只调一次 /api/message。
 * 先把附件传完拿到 uploadIds，再把「文字 + uploadIds + stickerId」合成一个请求；
 * 表情不再是"另一条消息"，所以发"文字 + 表情"只会回一次。
 */
async function send() {
  if (busy) return;
  const text = inputEl.value.trim();
  const files = attachments.slice();
  const sticker = pickedSticker;
  if (!text && !files.length && !sticker) return;
  if (!currentUser) {
    showAuth('login', '请先登录');
    return;
  }

  busy = true;
  sendBtn.disabled = true;
  // 内容已经拿在手上了：输入框清空，选择也清空，界面上不留第二份
  inputEl.value = '';
  autoGrow();
  attachments = [];
  pickedSticker = null;
  uploading = files.length > 0;
  renderAttachChips();

  // 把最近几轮带上去，模型才能读出指代与言外之意
  const history = recentTurns.slice(-6);
  const userWrap = addUserMessage(text, formatClock(Date.now()), { files, sticker });
  const pending = addPending();
  const started = performance.now();
  let delivered = false;

  try {
    let uploadIds = [];
    if (files.length) {
      setStatus('busy', '上传 0%…');
      uploadIds = await uploadAll(files, (frac) => {
        setUploadProgress(frac);
        setStatus('busy', `上传 ${Math.round(frac * 100)}%…`);
      });
    }
    uploading = false;
    renderAttachChips();
    setStatus('busy', files.length || sticker ? '让它看看…' : '处理中…');

    const res = await apiFetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 不再带 stickers 目录：模型有 send_sticker 工具，80 条目录纯属白烧 token
      body: JSON.stringify({
        text,
        uploadIds,
        stickerId: sticker ? sticker.id : '',
        stickerMood: sticker ? sticker.mood : '',
        sessionId: getSessionId(),
        history,
      }),
    });

    if (res.status === 401) {
      pending.remove();
      handleUnauthorized('会话过期，请重新登录');
      return;
    }

    const data = await res.json().catch(() => ({ ok: false, error: '无法解析响应' }));
    pending.remove();

    if (data.ok) {
      delivered = true;
      const ms = typeof data.ms === 'number' ? data.ms : Math.round(performance.now() - started);
      recentTurns.push({ role: 'user', text });
      recentTurns.push({ role: 'assistant', text: data.answer || '' });
      if (recentTurns.length > 12) recentTurns.splice(0, recentTurns.length - 12);
      // 服务端把这次用到的附件 id 带回来了：给气泡里的卡片补上可点的原件链接
      wireSentAttachmentLinks(userWrap, data.attachments);
      await addReplySeries(data.answer || '（空答案）',
        `${(ms / 1000).toFixed(1)} 秒${usageNote(data.usage)} · ${formatClock(Date.now())}`);
      // 插件在这一轮里"做了点什么"：发张表情、念一段。模型自己碰不到界面，靠这里落地。
      applyActions(data.actions);
      // 它回「收藏这张」：收的就是这条消息里发的那张
      if (sticker && parseReplyMarks(data.answer || '').favorite) await favoriteSentSticker(sticker);
    } else {
      addMessage('error', data.error || data.code || '请求失败', '');
    }
  } catch (err) {
    pending.remove();
    addMessage('error', String(err && err.message ? err.message : err));
  } finally {
    uploading = false;
    busy = false;
    sendBtn.disabled = !currentUser;
    // 没送到就不要偷偷把附件丢掉：还回去，改一下再发，不用重新挑文件
    if (!delivered && (files.length || sticker) && !attachments.length && !pickedSticker) {
      attachments = files;
      pickedSticker = sticker;
    }
    renderAttachChips();
    setStatus('', '');
    refreshHealth();
    if (currentUser) inputEl.focus();
  }
}

/**
 * 执行插件塞回来的动作。目前两种：
 *   sticker —— 它自己挑了一张图，插一个图片气泡
 *   speak   —— 它想直接念出来，走本地 TTS 播放
 * 未知类型直接跳过：插件可能比面板新，不能让界面因为不认识就报错。
 */
function applyActions(actions) {
  if (!Array.isArray(actions) || !actions.length) return;
  for (const a of actions) {
    if (!a || !a.type) continue;
    if (a.type === 'sticker' && a.id) {
      addMessage('assistant', '', '', { sticker: a.id });
    } else if (a.type === 'speak' && a.text) {
      speakText(String(a.text).slice(0, 300));
    }
  }
}

function autoGrow() {  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 220)}px`;
}

sendBtn.addEventListener('click', send);


inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    send();
  }
});

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/** 人格栏：宪法 + traits。切到该栏时现拉。 */
async function loadPersonaView() {
  if (!currentUser) return;
  try {
    const p = await apiJson('/api/persona');
    if (p && p.ok) {
      document.getElementById('personaVersion').textContent = 'v' + p.version;
      const traits = p.traits || {};
      document.getElementById('personaTraits').innerHTML = Object.keys(traits)
        .map((k) => '<span class="trait">' + k + ' ' + traits[k] + '</span>')
        .join('');
      document.getElementById('personaBlock').textContent = p.block || '';
    }
  } catch (err) {
    /* 记忆服务可能没起 */
  }
}

/** 五种明细的取数与标题。 */
const DETAILS = {
  events: { title: '全部事件', url: '/api/memory/events?limit=100' },
  facts: { title: '全部事实', url: '/api/memory/facts?limit=100' },
  conflicts: { title: '冲突事实', url: '/api/memory/facts?status=conflict&limit=100' },
  entities: { title: '全部实体', url: '/api/memory/entities?limit=200' },
  deleted: { title: '已删除事件', url: '/api/memory/events?limit=100&deleted=1' },
};
let currentDetail = 'events';

function renderDetail(kind, payload) {
  const spec = DETAILS[kind] || DETAILS.events;
  const titleEl = document.getElementById('detailTitle');
  const countEl = document.getElementById('detailCount');
  const list = document.getElementById('memEvents');
  if (!list) return;

  let rows = [];
  if (kind === 'facts' || kind === 'conflicts') {
    rows = (payload.facts || []).map((f) => '<li><div>' + escapeHtml(f.subject + ' · ' + f.predicate + ' · ' + f.object)
      + '</div><div class="ev-meta">' + escapeHtml(f.status) + ' · 置信 ' + escapeHtml(f.confidence)
      + ' · 支持 ' + escapeHtml(f.support) + ' · ' + escapeHtml(f.last_seen) + '</div></li>');
  } else if (kind === 'entities') {
    rows = (payload.entities || []).map((e) => '<li><div>' + escapeHtml(e.name)
      + ' <span class="ev-meta">' + escapeHtml(e.type) + '</span></div><div class="ev-meta">'
      + escapeHtml(e.aliases || '') + '</div></li>');
  } else {
    rows = (payload.events || []).map((ev) => '<li><div>' + escapeHtml(ev.content)
      + '</div><div class="ev-meta">#' + escapeHtml(ev.id) + ' · ' + escapeHtml(ev.actor) + ' · '
      + escapeHtml(ev.ts) + ' · ' + escapeHtml(ev.evidence)
      + (ev.user_id == null ? ' · 共享' : ' · 用户 ' + escapeHtml(ev.user_id)) + '</div></li>');
  }

  if (titleEl) titleEl.firstChild.textContent = spec.title + ' ';
  if (countEl) countEl.textContent = rows.length + ' 条';
  list.innerHTML = rows.join('') || '<li class="ev-meta">（暂无）</li>';
}

async function loadDetail(kind) {
  currentDetail = DETAILS[kind] ? kind : 'events';
  try {
    const data = await apiJson(DETAILS[currentDetail].url);
    renderDetail(currentDetail, data || {});
  } catch (err) {
    const list = document.getElementById('memEvents');
    if (list) list.innerHTML = '<li class="ev-meta">加载失败：' + escapeHtml(err.message) + '</li>';
  }
}

/** 记忆栏：统计按钮（点了看明细）+ 明细列表。 */
async function loadMemoryView() {
  if (!currentUser) return;

  try {
    const s = await apiJson('/api/memory/stats');
    if (s && s.ok) {
      const c = s.counts || {};
      const kinds = [
        ['events', '事件', c.events], ['facts', '事实', c.facts], ['conflicts', '冲突', c.conflicts],
        ['entities', '实体', c.entities], ['deleted', '已删', c.deletedEvents],
      ];
      document.getElementById('memStats').innerHTML = kinds
        .map(([kind, label, v]) => '<button class="stat" data-kind="' + kind + '"><b>'
          + (v == null ? 0 : v) + '</b><span>' + label + '</span></button>')
        .join('');
      document.querySelectorAll('#memStats .stat').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#memStats .stat').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          loadDetail(btn.dataset.kind);
        });
      });
    }
  } catch (err) {
    /* 忽略 */
  }

  await loadDetail(currentDetail);
}

/**
 * 视频创作 v2 的入口：逻辑和视图都在 /video-v2.js 里（从 panel-v2 抽出来的），
 * 这里只负责在「切到视频 tab」和「登录成功」时叫它初始化一次。
 */
function enterVideoV2() {
  if (!window.VideoV2 || typeof window.VideoV2.enter !== 'function') return;
  try {
    window.VideoV2.enter();
  } catch (err) {
    console.warn('video-v2 初始化失败：', err);
  }
}

/** 切栏：聊天 / 记忆 / 视频创作 / 人格 / 账号。 */
function setView(name) {
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const titles = { chat: '聊天', memory: '记忆', video: '视频创作', persona: '人格', admin: '账号' };
  if (viewTitle) viewTitle.textContent = titles[name] || '';
  if (name === 'memory') loadMemoryView();
  if (name === 'video') enterVideoV2();
  if (name === 'persona') loadPersonaView();
  if (name === 'admin') loadAdminPanel();
  if (name === 'chat') inputEl.focus();
}

tabsEl.addEventListener('click', (event) => {
  const btn = event.target.closest('.tab');
  if (!btn || btn.classList.contains('hidden')) return;
  if (!currentUser) {
    showAuth('login', '请先登录');
    return;
  }
  setView(btn.dataset.view);
});

// ---- 登录/注册/退出交互 ----------------------------------------------------

loginBtn.addEventListener('click', () => showAuth('login', ''));
logoutBtn.addEventListener('click', logout);

authSwitch.addEventListener('click', () => {
  showAuth(authMode === 'register' ? 'login' : 'register', '');
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authBusy) return;

  const username = authUsername.value.trim();
  const password = authPassword.value;
  const displayName = authDisplayName.value.trim();
  const invite = authInvite ? authInvite.value.trim() : '';

  if (!username || !password) {
    setAuthError('请填写用户名和密码');
    return;
  }
  if (authMode === 'register' && password.length < 6) {
    setAuthError('密码至少 6 位');
    return;
  }

  const register = authMode === 'register';
  authBusy = true;
  authSubmit.disabled = true;
  authSwitch.disabled = true;
  authSubmit.textContent = register ? '注册中…' : '登录中…';
  setAuthError('');

  try {
    // 登录/注册本身不需要旧 token，直接请求，避免过期 token 干扰
    const res = await fetch(register ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(register ? { username, password, displayName, code: invite } : { username, password }),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setAuthError(data.message || data.error || `请求失败（HTTP ${res.status}）`);
      return;
    }
    enterSession(data);
  } catch (err) {
    setAuthError('连接失败：' + (err && err.message ? err.message : err));
  } finally {
    authBusy = false;
    authSubmit.disabled = false;
    authSwitch.disabled = false;
    authSubmit.textContent = authMode === 'register' ? '注册并登录' : '登录';
  }
});

// ---- 启动 ------------------------------------------------------------------

/** 启动时用 token 校验会话；无效就锁住输入并弹登录层。 */
async function boot() {
  renderUser();
  refreshHealth();

  if (!authToken) {
    showAuth('login', '');
    return;
  }

  let user = null;
  let rejected = false;
  try {
    const res = await fetch('/api/auth/me', {
      headers: { authorization: `Bearer ${authToken}` },
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.ok && data.user) user = data.user;
    } else if (res.status === 401) {
      rejected = true;
    }
  } catch (err) {
    /* 账号服务没起：按未登录处理，但提示连接问题 */
  }

  if (!user) {
    clearToken();
    authToken = '';
    currentUser = null;
    renderUser();
    showAuth('login', rejected ? '会话过期，请重新登录' : '无法连接账号服务，请登录');
    return;
  }

  currentUser = user;
  renderUser();
  hideAuth();
  await loadHistory();
  enterVideoV2();
  inputEl.focus();
}

setInterval(refreshHealth, 15000);
boot();

// ------------------------------------------------------------- 表情包 ----
// 表情现在只是"这条消息的一部分"：点一张 → 变成输入框上方的 chip，
// 和文字一起走一次 /api/message。不再单独发一轮，也不会被模型改写。

const stickerEls = {
  btn: document.getElementById('stickerBtn'),
  panel: document.getElementById('stickerPanel'),
  grid: document.getElementById('stickerGrid'),
  search: document.getElementById('stickerSearch'),
  close: document.getElementById('stickerClose'),
  hint: document.getElementById('stickerHint'),
  tabAll: document.getElementById('stickerTabAll'),
  tabFav: document.getElementById('stickerTabFav'),
};

let stickerList = [];
let stickerQuery = '';
let stickerTimer = null;
let stickerFavOnly = false;

function renderStickerGrid(items) {
  if (!stickerEls.grid) return;
  stickerEls.grid.innerHTML = '';
  if (!items.length) {
    if (stickerEls.hint) {
      stickerEls.hint.textContent = stickerFavOnly ? '还没有收藏，点右上角 ★ 收一张' : '没找到，换个词试试';
    }
    return;
  }
  if (stickerEls.hint) stickerEls.hint.textContent = `共 ${items.length} 张 · 点一张放进输入框，和文字一起发`;
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-cell';
    btn.title = it.mood || it.name || it.id;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/api/stickers/gif?id=${encodeURIComponent(it.id)}`;
    img.alt = it.mood || '';
    btn.appendChild(img);

    // 右上角收藏星：只切收藏，不触发发送（stopPropagation）
    const star = document.createElement('span');
    star.className = 'sticker-star';
    star.setAttribute('role', 'button');
    star.tabIndex = 0;
    paintStickerStar(star, it.favorite);
    const toggle = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleFavorite(it, star);
    };
    star.addEventListener('click', toggle);
    star.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') toggle(ev);
    });
    btn.appendChild(star);

    btn.addEventListener('click', () => pickSticker(it));
    stickerEls.grid.appendChild(btn);
  }
}

function paintStickerStar(star, favorite) {
  if (!star) return;
  star.textContent = '★';
  star.classList.toggle('on', Boolean(favorite));
  star.setAttribute('aria-pressed', favorite ? 'true' : 'false');
  star.title = favorite ? '取消收藏' : '收藏这张';
}

/** 点 ★：收藏 / 取消收藏。收藏页里取消后立刻把这张拿掉。 */
async function toggleFavorite(item, star) {
  if (!item || !item.id) return;
  const want = !item.favorite;
  const label = item.mood || item.name || item.id;
  try {
    const r = want
      ? await apiJson('/api/stickers/favorite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, name: label }),
      })
      : await apiJson(`/api/stickers/favorite?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    if (!r || !r.ok) {
      if (stickerEls.hint) stickerEls.hint.textContent = (want ? '收藏失败：' : '取消收藏失败：') + ((r && r.error) || '未知原因');
      return;
    }
    item.favorite = want;
    const row = stickerList.find((x) => x && x.id === item.id);
    if (row) row.favorite = want;
    paintStickerStar(star, want);
    if (stickerEls.hint) stickerEls.hint.textContent = want ? `已收藏「${label}」★` : `已取消收藏「${label}」`;
    if (stickerFavOnly && !want) renderStickerGrid(stickerList.filter((x) => x && x.favorite));
  } catch (err) {
    if (stickerEls.hint) stickerEls.hint.textContent = '收藏失败：' + ((err && err.message) || err);
  }
}

/** 模型回了 [收藏这张]：把刚发出去的那张收进收藏夹（名字用当前 mood）。 */
async function favoriteSentSticker(item) {
  const name = item.mood || item.name || '';
  try {
    const r = await apiJson('/api/stickers/favorite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, name }),
    });
    if (!r || !r.ok) {
      if (stickerEls.hint) stickerEls.hint.textContent = '收藏失败：' + ((r && r.error) || '未知原因');
      return false;
    }
    item.favorite = true;
    const row = stickerList.find((x) => x && x.id === item.id);
    if (row) row.favorite = true;
    if (stickerEls.hint) stickerEls.hint.textContent = `已收藏「${name || item.id}」★`;
    return true;
  } catch (err) {
    if (stickerEls.hint) stickerEls.hint.textContent = '收藏失败：' + ((err && err.message) || err);
    return false;
  }
}

/** 交给 io 的表情目录：模型看到 id 才可能输出 [sticker:<id>]（没加载就不传）。 */
function stickerCatalog() {
  if (!Array.isArray(stickerList) || !stickerList.length) return undefined;
  return stickerList.slice(0, 80).map((it) => ({ id: it.id, name: it.mood || it.name || it.id }));
}

/** 面板没打开过时也先悄悄拉一份目录，正常聊天才能带上表情 id（失败就静默）。 */
async function preloadStickerCatalog() {
  if (stickerList.length) return;
  try {
    const data = await apiJson('/api/stickers?limit=300');
    // 期间用户可能已经打开面板搜过一次，别拿旧结果盖掉
    if (stickerList.length) return;
    if (data && data.ok && Array.isArray(data.items) && data.items.length) stickerList = data.items;
  } catch (err) {
    /* 表情模块没起就保持空目录，不影响聊天 */
  }
}

async function loadStickers(q) {
  stickerQuery = q || '';
  if (stickerEls.hint) stickerEls.hint.textContent = stickerFavOnly ? '正在找收藏…' : '正在找…';
  try {
    const fav = stickerFavOnly ? '&favorite=1' : '';
    const data = await apiJson(`/api/stickers?q=${encodeURIComponent(stickerQuery)}&limit=300${fav}`);
    if (!data || !data.ok) {
      if (stickerEls.hint) stickerEls.hint.textContent = '表情包服务没响应（模块可能没起）';
      return;
    }
    stickerList = Array.isArray(data.items) ? data.items : [];
    // 服务端约定 favorite=1 时收藏在前；收藏页只显示收藏，兜底自己再筛一遍
    const view = stickerFavOnly ? stickerList.filter((it) => it && it.favorite) : stickerList;
    renderStickerGrid(view);
  } catch (err) {
    if (stickerEls.hint) stickerEls.hint.textContent = '加载失败：' + ((err && err.message) || err);
  }
}

/**
 * 点一张表情：只是放进输入框上方当 chip，跟文字一起发。
 * 以前「点一下 = 单独发一轮」，正是"文字 + 表情要回两次"的根因。
 */
function pickSticker(item) {
  if (!item || !item.id) return;
  pickedSticker = { id: item.id, mood: item.mood || item.name || '' };
  renderAttachChips();
  toggleStickerPanel(false);
  if (currentUser) inputEl.focus();
}

/** 全部 / 收藏 两个小标签页：切页只换请求参数，不改发送逻辑。 */
function setStickerTab(fav) {
  stickerFavOnly = Boolean(fav);
  if (stickerEls.tabAll) stickerEls.tabAll.classList.toggle('active', !stickerFavOnly);
  if (stickerEls.tabFav) stickerEls.tabFav.classList.toggle('active', stickerFavOnly);
  loadStickers(stickerQuery);
}

function toggleStickerPanel(show) {
  if (!stickerEls.panel) return;
  const next = show === undefined ? stickerEls.panel.classList.contains('hidden') : show;
  stickerEls.panel.classList.toggle('hidden', !next);
  if (next) loadStickers(stickerQuery);
}

if (stickerEls.btn) stickerEls.btn.addEventListener('click', () => toggleStickerPanel());
if (stickerEls.close) stickerEls.close.addEventListener('click', () => toggleStickerPanel(false));
if (stickerEls.search) {
  stickerEls.search.addEventListener('input', () => {
    clearTimeout(stickerTimer);
    stickerTimer = setTimeout(() => loadStickers(stickerEls.search.value.trim()), 300);
  });
}
if (stickerEls.tabAll) stickerEls.tabAll.addEventListener('click', () => setStickerTab(false));
if (stickerEls.tabFav) stickerEls.tabFav.addEventListener('click', () => setStickerTab(true));
