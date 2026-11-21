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
      if (!data.ok) return reject(new Error(data.error || `HTTP ${xhr.status}`));
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

// ------------------------------------------------- 视频创作（studio）----
/**
 * 三种创作入口共用一套分镜状态：
 *   写稿   POST /api/studio/script → 拆场（不渲染）
 *   分镜   POST /api/studio/scenes → 把「画什么」翻译成 manim 代码
 *   全自动 POST /api/studio/create → 写分镜并直接出片
 *
 * 底部那条操作栏对三者都有效：[预览分镜] [渲染] + 预估。
 * 渲染不是一次性黑箱：先建项目（拿到稳定 id），再发渲染请求，同时轮询
 * /api/studio/progress 显示「第 3/8 场 manim 渲染中…」。
 */

const studioEls = {
  binding: document.getElementById('studioBinding'),
  tabs: Array.from(document.querySelectorAll('.studio-tab')),
  panes: {
    script: document.getElementById('paneScript'),
    scenes: document.getElementById('paneScenes'),
    auto: document.getElementById('paneAuto'),
  },
  script: document.getElementById('studioScript'),
  scriptSeconds: document.getElementById('scriptSeconds'),
  scriptStyle: document.getElementById('scriptStyle'),
  scriptVoice: document.getElementById('scriptVoice'),
  scriptGo: document.getElementById('studioScriptGo'),
  scriptHint: document.getElementById('studioScriptHint'),
  prompt: document.getElementById('studioPrompt'),
  autoSeconds: document.getElementById('autoSeconds'),
  autoStyle: document.getElementById('autoStyle'),
  autoVoice: document.getElementById('autoVoice'),
  sceneList: document.getElementById('sceneList'),
  sceneAdd: document.getElementById('sceneAdd'),
  fill: document.getElementById('studioFill'),
  sceneHint: document.getElementById('sceneHint'),
  editMeta: document.getElementById('studioEditMeta'),
  progress: document.getElementById('studioProgress'),
  progressFill: document.getElementById('studioProgressFill'),
  progressText: document.getElementById('studioProgressText'),
  plan: document.getElementById('studioPlan'),
  raw: document.getElementById('studioRaw'),
  video: document.getElementById('studioVideo'),
  resultHint: document.getElementById('studioResultHint'),
  download: document.getElementById('studioDownload'),
  preview: document.getElementById('studioPreview'),
  render: document.getElementById('studioRender'),
  estimate: document.getElementById('studioEstimate'),
  resultCard: document.getElementById('studioResultCard'),
};

let studioMode = 'script';
let studioTitle = '';
// 每一场：{text, narration, seconds, visual_hint, tool, kind, manim, status, dirty}
// tool 是用户的选择（manim / text / ''=自动），manim 是补全后拿到的代码。
let studioScenes = [];
let studioProjectId = '';
let studioBusy = false;
// 本集配置：风格/音色为空串 = 跟人设，交给 studio 决定
let studioConfig = { seconds: 60, style: '', voice: '' };
let studioPollTimer = null;
let studioPollInFlight = false;
let studioBindingInfo = null;
let studioOptionsLoaded = false;

const SCENE_SECONDS_MIN = 2;
const SCENE_SECONDS_MAX = 12;
const SCENE_GAP_SECONDS = 0.4;

function studioSceneSeconds(scene) {
  const n = Number(scene && scene.seconds);
  if (!Number.isFinite(n)) return 5;
  return Math.min(SCENE_SECONDS_MAX, Math.max(SCENE_SECONDS_MIN, n));
}

function studioSecondsTotal() {
  const count = studioScenes.length;
  if (!count) return 0;
  const sum = studioScenes.reduce((acc, s) => acc + studioSceneSeconds(s), 0);
  return Math.max(0, Math.round((sum - SCENE_GAP_SECONDS * (count - 1)) * 10) / 10);
}

/** 切子标签：三个面板只显示一个；场景表格在"分镜"标签里。 */
function setStudioMode(mode) {
  studioMode = ['script', 'scenes', 'auto'].includes(mode) ? mode : 'script';
  for (const tab of studioEls.tabs) {
    const on = tab.dataset.mode === studioMode;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const [key, pane] of Object.entries(studioEls.panes)) {
    if (pane) pane.classList.toggle('hidden', key !== studioMode);
  }
  updateStudioEstimate();
}

/** 当前标签页的秒数/风格/音色。分镜标签没有自己的选择器，沿用上一次的配置。 */
function readStudioConfig() {
  if (studioMode === 'script') {
    return {
      seconds: Number(studioEls.scriptSeconds && studioEls.scriptSeconds.value) || 60,
      style: studioEls.scriptStyle ? studioEls.scriptStyle.value : '',
      voice: studioEls.scriptVoice ? studioEls.scriptVoice.value : '',
    };
  }
  if (studioMode === 'auto') {
    return {
      seconds: Number(studioEls.autoSeconds && studioEls.autoSeconds.value) || 60,
      style: studioEls.autoStyle ? studioEls.autoStyle.value : '',
      voice: studioEls.autoVoice ? studioEls.autoVoice.value : '',
    };
  }
  return Object.assign({}, studioConfig);
}

/** 选择器里的 "跟人设" 选项文案要带上人设实际会选什么，用户才知道空着意味着什么。 */
function studioPersonaStyleLabel() {
  const name = studioBindingInfo && studioBindingInfo.style && studioBindingInfo.style.name;
  return name ? `跟人设（${name}）` : '跟人设';
}

function studioPersonaVoiceLabel() {
  const name = studioBindingInfo && studioBindingInfo.voice && studioBindingInfo.voice.name;
  return name ? `跟人设（${name}）` : '跟人设';
}

function fillStudioSelect(select, items, personaLabel, current) {
  if (!select) return;
  const want = current == null ? '' : String(current);
  select.textContent = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = personaLabel;
  select.append(first);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item.id || item.value || '');
    option.textContent = String(item.name || item.label || item.voiceId || option.value);
    select.append(option);
  }
  select.value = want;
  if (select.value !== want) select.value = '';
}

/** 风格/音色下拉：一次拉齐，之后不再重复请求。 */
async function loadStudioOptions() {
  if (studioOptionsLoaded) return;
  const [styles, voices] = await Promise.all([
    apiJson('/api/studio/styles'),
    apiJson('/api/studio/voices'),
  ]);
  const styleItems = (styles && styles.ok && Array.isArray(styles.styles))
    ? styles.styles.map((s) => ({ id: s.id, name: s.name }))
    : [];
  const voiceItems = (voices && voices.ok && Array.isArray(voices.voices))
    ? voices.voices.map((v) => ({ id: v.voiceId, name: v.name || v.voiceId }))
    : [];
  const keep = {
    scriptStyle: studioEls.scriptStyle ? studioEls.scriptStyle.value : '',
    scriptVoice: studioEls.scriptVoice ? studioEls.scriptVoice.value : '',
    autoStyle: studioEls.autoStyle ? studioEls.autoStyle.value : '',
    autoVoice: studioEls.autoVoice ? studioEls.autoVoice.value : '',
  };
  fillStudioSelect(studioEls.scriptStyle, styleItems, studioPersonaStyleLabel(), keep.scriptStyle);
  fillStudioSelect(studioEls.autoStyle, styleItems, studioPersonaStyleLabel(), keep.autoStyle);
  fillStudioSelect(studioEls.scriptVoice, voiceItems, studioPersonaVoiceLabel(), keep.scriptVoice);
  fillStudioSelect(studioEls.autoVoice, voiceItems, studioPersonaVoiceLabel(), keep.autoVoice);
  studioOptionsLoaded = styleItems.length > 0 || voiceItems.length > 0;
}

/** 面板上那行"当前：大肥鱼（迷糊版）· 白板讲解 · 温柔口语"。 */
async function loadStudioBinding() {
  const data = await apiJson('/api/studio/binding');
  if (!data || !data.ok) {
    if (studioEls.binding) {
      studioEls.binding.textContent = '人设绑定暂时读不到：音色和风格会用默认值。';
    }
    return;
  }
  studioBindingInfo = data;
  if (studioEls.binding) {
    studioEls.binding.textContent = `当前：${data.summary}`;
    const tone = (data.tone && data.tone.tags) || [];
    studioEls.binding.title = [
      `音色：${data.voice.name}${data.voice.reason ? '（' + data.voice.reason + '）' : ''}`,
      `风格：${data.style.name}${data.style.reason ? '（' + data.style.reason + '）' : ''}`,
      `语气：${tone.join('+') || (data.tone && data.tone.label) || ''}`,
    ].join('\n');
  }
  // 人设可用后，"跟人设"那一项才写得清具体是什么
  studioOptionsLoaded = false;
  await loadStudioOptions();
}

async function loadStudioView() {
  if (!studioOptionsLoaded) {
    await loadStudioBinding();
  }
  if (!studioScenes.length) updateStudioMeta();
  updateStudioEstimate();
}

function studioSetHint(el, text) {
  if (el) el.textContent = text;
}

/** 失败要说人话：错误码翻成用户能行动的一句话，缺哪几句也点出来。 */
function studioErrorText(r) {
  const error = String((r && (r.error || r.code)) || '');
  const speak = String((r && r.speakError) || '');
  const attempts = Number(r && r.attempts) || 0;
  if (error === 'VOICE_UNAVAILABLE') {
    if (speak === 'QUEUE_TIMEOUT') return '配音排队超时了：另一个任务正占着音色队列，过一会儿再渲染。';
    if (speak === 'BREEZEBLUE_UNAVAILABLE') {
      return attempts > 0
        ? `配音服务暂时不可用，已重试 ${attempts} 次，请稍后重试。`
        : '配音服务暂时不可用，请稍后重试。';
    }
    if (speak) return `配音失败（${speak}），请稍后重试。`;
    return '配音服务暂时不可用（连不上配音服务），检查服务后再试。';
  }
  if (error === 'QUEUE_TIMEOUT') return '配音排队超时了，过一会儿再渲染。';
  if (error === 'NO_SCENES' || error === 'SCENES_REQUIRED') return '分镜是空的，先写几场。';
  if (error === 'SCRIPT_REQUIRED' || error === 'PROMPT_REQUIRED') return '先把内容写进去。';
  if (error === 'PLAN_NOT_JSON') return '模型没按格式写分镜，再试一次。';
  if (error === 'IO_FAILED') return '核心没响应（写分镜要用它），稍后再试。';
  if (error === 'UNREACHABLE') return '连不上服务，稍后再试。';
  if (error === 'TIMEOUT') return '请求超时了，稍后再试。';
  if (error === 'NOT_FOUND') return '这个项目找不到了，重新生成一次分镜。';
  return error || '未知原因';
}

/** 失败统一处理：一句话原因 + 缺了哪几句 + 原始输出（有的话）。 */
function studioFailure(r, hintEl) {
  let reason = studioErrorText(r);
  if (r && Array.isArray(r.scenes) && r.scenes.length) {
    const idx = r.scenes.map((s) => (Number(s.index) || 0) + 1).join('、');
    reason += `（第 ${idx} 句旁白没合成出来）`;
  }
  studioSetHint(hintEl, '没做成：' + reason);
  if (!studioEls.raw) return;
  const raw = r && (r.raw || r.detail);
  if (raw) {
    studioEls.raw.textContent = '服务返回：' + String(raw).slice(0, 2000);
    studioEls.raw.classList.remove('hidden');
  } else {
    studioEls.raw.textContent = '';
    studioEls.raw.classList.add('hidden');
  }
}

/** 面板自己的 JSON POST：非 2xx 也把 body 读出来（原因都写在 body 里）。 */
async function studioPost(url, payload) {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    handleUnauthorized('会话过期，请重新登录');
    return { ok: false, error: '登录已过期，请重新登录' };
  }
  const data = await res.json().catch(() => null);
  return data || { ok: false, error: `面板回了 HTTP ${res.status}` };
}

/** 忙的时候所有入口一起锁：写分镜 / 补全 / 渲染 是互斥的。 */
function setStudioBusy(on) {
  studioBusy = Boolean(on);
  const buttons = [studioEls.scriptGo, studioEls.fill, studioEls.preview, studioEls.render];
  for (const el of buttons) {
    if (el) el.disabled = studioBusy;
  }
  document.body.classList.toggle('studio-busy', studioBusy);
}

/** 分镜 → 交给 studio 的场景数组。tool=text 时把旧代码丢掉，别让文字卡带着动画。 */
function studioPlanFromScenes() {
  const scenes = studioScenes.map((s) => {
    const useManim = s.tool !== 'text' && s.manim && s.manim.code;
    return {
      text: String(s.text || '').trim(),
      narration: String(s.narration || '').trim(),
      seconds: studioSceneSeconds(s),
      visual_hint: String(s.visual_hint || '').trim(),
      tool: String(s.tool || ''),
      kind: useManim ? 'manim' : 'text',
      manim: useManim ? s.manim : null,
    };
  });
  return { title: studioTitle, scenes };
}

/** 服务端返回的分镜 → 内存状态。三种入口拿到的东西形状略有不同，在这里收口。 */
function adoptStudioScenes(data) {
  if (!data) return;
  // 写稿/分镜把场景放在顶层 scenes；全自动的 /v1/plan 与 /v1/create 放在 plan.scenes
  const list = Array.isArray(data.scenes)
    ? data.scenes
    : (data.plan && Array.isArray(data.plan.scenes) ? data.plan.scenes : []);
  const fallbackTitle = data.plan && data.plan.title ? data.plan.title : '';
  studioTitle = String(data.title || fallbackTitle || studioTitle || '').slice(0, 60);
  studioScenes = list.map((s) => {
    const hasManim = Boolean(s && s.manim && s.manim.code);
    const tool = s && s.tool === 'text'
      ? 'text'
      : (s && s.tool === 'manim' ? 'manim' : (s && s.kind === 'text' && !hasManim ? 'text' : (hasManim ? 'manim' : '')));
    return {
      text: String((s && s.text) || ''),
      narration: String((s && s.narration) || ''),
      seconds: studioSceneSeconds(s),
      visual_hint: String((s && s.visual_hint) || ''),
      tool,
      kind: hasManim ? 'manim' : 'text',
      manim: hasManim ? { code: s.manim.code, scene: s.manim.scene || null } : null,
      status: (s && s.status) || (hasManim ? 'manim' : 'pending'),
      note: String((s && s.note) || ''),
      dirty: false,
    };
  });
  if (data.project && data.project.id) studioProjectId = String(data.project.id);
  renderStudioScenes();
  updateStudioMeta();
  updateStudioEstimate();
  renderStudioPlan();
}

/** 这些场需要重新翻译成动画：选了 manim（或自动）但还没有代码，或「画什么」被改过。 */
function scenesNeedFill() {
  return studioScenes.some((s) => {
    if (s.tool === 'text') return false;
    if (!(s.manim && s.manim.code)) return true;
    return Boolean(s.dirty);
  });
}

function studioStatusText(scene) {
  if (scene.status === 'fallback') return '降级文字卡（生成失败）';
  if (scene.tool === 'text' || scene.status === 'text') return '文字卡';
  if (scene.dirty) return '待重新生成';
  if (scene.manim && scene.manim.code) return '已生成 manim 代码';
  return '待补全';
}

function studioStatusClass(scene) {
  if (scene.status === 'fallback') return 'bad';
  if (scene.tool === 'text' || scene.status === 'text') return 'plain';
  if (scene.manim && scene.manim.code && !scene.dirty) return 'good';
  return 'wait';
}

/** 造一个 label + 控件（和旧分镜编辑区同一套写法，CSS 直接复用）。 */
function studioField(labelText, control, className) {
  const label = document.createElement('label');
  label.className = className ? `field ${className}` : 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

function studioInput(type, field, value, className) {
  const el = document.createElement('input');
  el.type = type;
  el.dataset.field = field;
  if (className) el.className = className;
  el.value = value == null ? '' : String(value);
  return el;
}

function studioToolSelect(value) {
  const select = document.createElement('select');
  select.dataset.field = 'tool';
  const options = [
    ['', '自动'],
    ['manim', 'manim'],
    ['text', '文字卡'],
  ];
  for (const [val, label] of options) {
    const option = document.createElement('option');
    option.value = val;
    option.textContent = label;
    select.append(option);
  }
  select.value = value || '';
  return select;
}

/** 整块重建。只在增删场次 / 换新分镜时调用，输入过程中绝不重排 DOM。 */
function renderStudioScenes() {
  if (!studioEls.sceneList) return;
  studioEls.sceneList.textContent = '';
  if (!studioScenes.length) {
    const tip = document.createElement('p');
    tip.className = 'muted';
    tip.textContent = '还没有分镜：先在「写稿」贴一段稿子，或者点「加一场」自己写。';
    studioEls.sceneList.append(tip);
    return;
  }

  studioScenes.forEach((scene, index) => {
    const row = document.createElement('div');
    row.className = 'scene';
    row.dataset.index = String(index);

    const head = document.createElement('div');
    head.className = 'scene-head';
    const no = document.createElement('span');
    no.className = 'scene-no';
    no.textContent = `第 ${index + 1} 场`;
    const badge = document.createElement('span');
    badge.className = `scene-badge ${studioStatusClass(scene)}`;
    badge.textContent = studioStatusText(scene);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'scene-del';
    del.textContent = '删除';
    head.append(no, badge, del);
    row.append(head);

    row.append(studioField('标题（画面上的字）', studioInput('text', 'text', scene.text, 'scene-text')));
    row.append(studioField('旁白（会念出来，留空则不出声）', studioInput('text', 'narration', scene.narration, 'scene-narration')));

    const grid = document.createElement('div');
    grid.className = 'scene-grid';
    const seconds = studioInput('number', 'seconds', studioSceneSeconds(scene), 'scene-seconds');
    seconds.min = String(SCENE_SECONDS_MIN);
    seconds.max = String(SCENE_SECONDS_MAX);
    seconds.step = '1';
    grid.append(studioField('秒数', seconds, 'small'));
    grid.append(studioField('工具', studioToolSelect(scene.tool), 'scene-tool'));
    row.append(grid);

    const hint = document.createElement('textarea');
    hint.dataset.field = 'visual_hint';
    hint.className = 'scene-visual-hint';
    hint.rows = 2;
    hint.placeholder = '自然语言描述要画什么，比如：画坐标轴、曲线上两个点，连线，然后让点靠近变成切线';
    hint.value = scene.visual_hint || '';
    row.append(studioField('画什么（会翻译成 manim 代码）', hint));

    if (scene.note) {
      const note = document.createElement('p');
      note.className = 'scene-warning muted';
      note.textContent = scene.note;
      row.append(note);
    }
    studioEls.sceneList.append(row);
  });
}

/** 顶部那行：标题 + 场数 + 总时长 + manim 占比。编辑时只动这行字。 */
function updateStudioMeta() {
  if (!studioEls.editMeta) return;
  const count = studioScenes.length;
  if (!count) {
    studioEls.editMeta.textContent = studioTitle ? `《${studioTitle}》· 还没有分镜` : '还没有分镜';
    return;
  }
  const manim = studioScenes.filter((s) => s.manim && s.manim.code).length;
  const title = studioTitle ? `《${studioTitle}》` : '未命名';
  studioEls.editMeta.textContent = `${title} · ${count} 场 · 总时长 ${studioSecondsTotal().toFixed(1)} 秒 · manim ${manim} 场`;
}

/** 底部预估：场数 / 秒数 / 渲染分钟 / credits。系数和 studio 的 estimateRender 一致。 */
function updateStudioEstimate() {
  if (!studioEls.estimate) return;
  if (!studioScenes.length) {
    studioEls.estimate.textContent = '预计：先写分镜';
    return;
  }
  let manim = 0;
  let text = 0;
  let chars = 0;
  for (const s of studioScenes) {
    // 还没补代码的场也要按 tool 预估，否则"写稿刚拆完"会显示成 0 场 manim。
    if (s.tool !== 'text' && (s.tool === 'manim' || (s.manim && s.manim.code))) manim += 1; else text += 1;
    chars += String(s.narration || '').length;
  }
  const seconds = studioSecondsTotal();
  const renderSeconds = Math.round(manim * 20 + text * 3 + chars * 0.22);
  const minutes = Math.max(0.1, Math.round((renderSeconds / 60) * 10) / 10);
  const credits = Math.round(chars * 0.185 * 10) / 10;
  studioEls.estimate.textContent = `预计：${studioScenes.length} 场 / ${seconds.toFixed(0)} 秒 / 约 ${minutes} 分钟 / 约 ${credits} credits`;
}

/** 分镜的纯文本预览（旧的 .plan 区，保留，方便一次看全）。 */
function renderStudioPlan() {
  if (!studioEls.plan) return;
  if (!studioScenes.length) {
    studioEls.plan.textContent = '';
    return;
  }
  const lines = [];
  lines.push(`${studioTitle ? '《' + studioTitle + '》' : '未命名'} ${studioSecondsTotal().toFixed(1)} 秒`);
  studioScenes.forEach((s, i) => {
    const tool = s.manim && s.manim.code ? 'manim' : (s.tool === 'text' ? '文字卡' : '待补全');
    lines.push(`  ${i + 1}. ${s.seconds}s [${tool}] ${s.text}${s.narration ? '  旁白：' + s.narration : ''}`);
    if (s.visual_hint) lines.push(`     画什么：${s.visual_hint}`);
  });
  studioEls.plan.textContent = lines.join('\n');
}

/** 输入事件：用 target 找到那一行，直接改数组元素；不重排 DOM，光标不跳。 */
function onStudioSceneEdit(event) {
  const control = event.target.closest('[data-field]');
  if (!control) return;
  const row = control.closest('.scene');
  if (!row) return;
  const scene = studioScenes[Number(row.dataset.index)];
  if (!scene) return;

  const field = control.dataset.field;
  if (field === 'seconds') {
    const n = Number(control.value);
    if (control.value !== '' && Number.isFinite(n)) scene.seconds = n;
    if (event.type === 'change') {
      scene.seconds = studioSceneSeconds(scene);
      control.value = String(scene.seconds);
    }
  } else {
    scene[field] = control.value;
    if (field === 'visual_hint' || field === 'tool') {
      // 「画什么」或工具变了，旧代码就过时了：下次渲染会重新补全。
      scene.dirty = true;
      scene.status = field === 'tool' && control.value === 'text' ? 'text' : 'pending';
    }
  }
  if (studioEls.plan && studioEls.plan.textContent) studioEls.plan.textContent = '';
  updateStudioMeta();
  updateStudioEstimate();
  // 状态徽标跟着变（只更新这一行的字，不重建行）
  const badge = row.querySelector('.scene-badge');
  if (badge) {
    badge.textContent = studioStatusText(scene);
    badge.className = `scene-badge ${studioStatusClass(scene)}`;
  }
}

function studioDeleteScene(event) {
  const del = event.target.closest('.scene-del');
  if (!del) return;
  const row = del.closest('.scene');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) return;
  studioScenes.splice(index, 1);
  renderStudioScenes();
  updateStudioMeta();
  updateStudioEstimate();
  renderStudioPlan();
}

function studioAddScene() {
  studioScenes.push({
    text: '',
    narration: '',
    seconds: 5,
    visual_hint: '',
    tool: '',
    kind: 'text',
    manim: null,
    status: 'pending',
    note: '',
    dirty: true,
  });
  renderStudioScenes();
  updateStudioMeta();
  updateStudioEstimate();
  const texts = studioEls.sceneList ? studioEls.sceneList.querySelectorAll('.scene-text') : [];
  if (texts.length) texts[texts.length - 1].focus();
}

// ---------------------------------------------------------------- 进度 --

function studioProgressShow(on) {
  if (studioEls.progress) studioEls.progress.classList.toggle('hidden', !on);
}

function studioProgressSet(text, ratio) {
  if (studioEls.progressText) studioEls.progressText.textContent = text;
  if (studioEls.progressFill) {
    const pct = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100)));
    studioEls.progressFill.style.width = pct + '%';
  }
}

function stopStudioPoll() {
  if (studioPollTimer) {
    clearInterval(studioPollTimer);
    studioPollTimer = null;
  }
  studioPollInFlight = false;
}

/** 每 1.5 秒问一次进度。渲染请求本身还在飞，所以这里只读旁路信息。 */
function startStudioPoll(projectId) {
  stopStudioPoll();
  const tick = async () => {
    if (studioPollInFlight || !projectId) return;
    studioPollInFlight = true;
    try {
      const res = await apiFetch(`/api/studio/progress?id=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const p = await res.json().catch(() => null);
        if (p && p.ok && p.status !== 'idle') {
          const total = Number(p.total) || studioScenes.length || 0;
          const done = Number(p.done) || 0;
          const elapsed = Math.round((Number(p.elapsedMs) || 0) / 1000);
          if (p.status === 'running') {
            const label = p.label || '渲染中';
            const suffix = total ? `（${done}/${total}）` : '';
            studioProgressSet(`${label}${suffix} · 已用 ${elapsed} 秒`, total ? done / total : 0.05);
          } else if (p.status === 'done') {
            studioProgressSet(`渲染完成 · 用时 ${Math.round((Number(p.ms) || 0) / 1000)} 秒`, 1);
          } else if (p.status === 'failed') {
            studioProgressSet(`失败：${p.error || '渲染失败'}`, 1);
          }
        }
      }
    } catch {
      /* 进度是旁路信息，失败不影响正在跑的渲染 */
    } finally {
      studioPollInFlight = false;
    }
  };
  tick();
  studioPollTimer = setInterval(tick, 1500);
}

// ------------------------------------------------------------ 三个入口 --

/** 写稿：稿子 → 分镜表。只拆场，不渲染。 */
async function studioGenerateScript() {
  if (studioBusy) return;
  const script = studioEls.script ? studioEls.script.value.trim() : '';
  if (!script) {
    studioSetHint(studioEls.scriptHint, '先把稿子贴进来。');
    return;
  }
  const config = readStudioConfig();
  studioConfig = Object.assign({}, config);
  setStudioBusy(true);
  studioProgressShow(false);
  studioSetHint(studioEls.scriptHint, '正在拆场…（只写分镜，不渲染）');
  try {
    const r = await studioPost('/api/studio/script', {
      script,
      seconds: config.seconds,
      style: config.style,
      voice: config.voice,
      projectId: studioProjectId,
    });
    if (!r || !r.ok) return studioFailure(r, studioEls.scriptHint);
    adoptStudioScenes(r);
    setStudioMode('scenes');
    const stats = r.estimate || {};
    studioSetHint(studioEls.scriptHint, `拆好了：${studioScenes.length} 场 / 约 ${stats.seconds || studioSecondsTotal()} 秒。下面每一场都能改。`);
    if (Array.isArray(r.warnings) && r.warnings.length) {
      studioSetHint(studioEls.sceneHint, r.warnings.join(' '));
    } else {
      studioSetHint(studioEls.sceneHint, '接下来点「补全动画」，把「画什么」翻译成 manim 代码。');
    }
  } catch (err) {
    studioSetHint(studioEls.scriptHint, '出错：' + ((err && err.message) || err));
  } finally {
    setStudioBusy(false);
  }
}

/** 分镜：把每一场的「画什么」补成 manim 代码（同样不渲染）。 */
async function studioFillScenes() {
  if (studioBusy) return;
  if (!studioScenes.length) {
    studioSetHint(studioEls.sceneHint, '还没有分镜：先写稿，或者加一场。');
    return;
  }
  const config = readStudioConfig();
  studioConfig = Object.assign({}, config);
  setStudioBusy(true);
  studioProgressShow(false);
  const manim = studioScenes.filter((s) => s.tool !== 'text').length;
  studioSetHint(studioEls.sceneHint, `正在生成动画代码：${manim} 场要画，可能要一两分钟…`);
  try {
    const plan = studioPlanFromScenes();
    const r = await studioPost('/api/studio/scenes', {
      title: studioTitle,
      projectId: studioProjectId,
      scenes: plan.scenes,
      style: config.style,
      voice: config.voice,
    });
    if (!r || !r.ok) return studioFailure(r, studioEls.sceneHint);
    adoptStudioScenes(r);
    const stats = r.stats || {};
    studioSetHint(
      studioEls.sceneHint,
      `补全完成：manim ${stats.manim || 0} 场 / 文字卡 ${stats.text || 0} 场` +
      (stats.fallback ? `（${stats.fallback} 场生成失败，已降级）` : '') + '。点「渲染」出片。',
    );
  } catch (err) {
    studioSetHint(studioEls.sceneHint, '出错：' + ((err && err.message) || err));
  } finally {
    setStudioBusy(false);
  }
}

/** 全自动：给个主题，写分镜并直接出片（这一步是长请求，没有中间进度）。 */
async function studioAutoCreate() {
  if (studioBusy) return;
  const prompt = studioEls.prompt ? studioEls.prompt.value.trim() : '';
  if (!prompt) {
    studioSetHint(studioEls.resultHint, '先写一句想要什么。');
    return;
  }
  const config = readStudioConfig();
  studioConfig = Object.assign({}, config);
  setStudioBusy(true);
  studioProgressShow(true);
  studioProgressSet('全自动：写分镜并渲染，可能要 1~3 分钟…', 0.05);
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const sec = Math.round((Date.now() - startedAt) / 1000);
    studioProgressSet(`全自动：写分镜并渲染中… 已用 ${sec} 秒`, 0.08);
  }, 1000);
  try {
    const r = await studioPost('/api/studio/create', {
      prompt,
      seconds: config.seconds,
      style: config.style,
      voice: config.voice,
    });
    if (!r || !r.ok) return studioFailure(r, studioEls.resultHint);
    adoptStudioScenes(r);
    studioRenderOk(r, '做好了：');
  } catch (err) {
    studioSetHint(studioEls.resultHint, '出错：' + ((err && err.message) || err));
  } finally {
    clearInterval(ticker);
    setStudioBusy(false);
  }
}

/** 预览分镜：三种模式各自的"只出分镜"。 */
async function studioPreview() {
  if (studioMode === 'script') return studioGenerateScript();
  if (studioMode === 'scenes') return studioFillScenes();
  if (studioBusy) return;
  const prompt = studioEls.prompt ? studioEls.prompt.value.trim() : '';
  if (!prompt) {
    studioSetHint(studioEls.resultHint, '先写一句想要什么。');
    return;
  }
  const config = readStudioConfig();
  studioConfig = Object.assign({}, config);
  setStudioBusy(true);
  studioSetHint(studioEls.resultHint, '正在写分镜…（只写不渲染）');
  try {
    const r = await studioPost('/api/studio/plan', {
      prompt,
      seconds: config.seconds,
      style: config.style,
      voice: config.voice,
    });
    if (!r || !r.ok) return studioFailure(r, studioEls.resultHint);
    adoptStudioScenes(r);
    studioSetHint(studioEls.resultHint, `分镜写好了：${studioScenes.length} 场，还没渲染。`);
  } catch (err) {
    studioSetHint(studioEls.resultHint, '出错：' + ((err && err.message) || err));
  } finally {
    setStudioBusy(false);
  }
}

// ---------------------------------------------------------------- 渲染 --

/** 渲染成功：<video> 走不可猜的 jobId，下载用同一个地址。 */
function studioRenderOk(r, prefix) {
  if (!r || !r.jobId) {
    studioFailure(r, studioEls.resultHint);
    return;
  }
  const url = `/api/studio/video?id=${encodeURIComponent(r.jobId)}`;
  if (studioEls.video) {
    studioEls.video.src = url;
    studioEls.video.classList.remove('hidden');
  }
  if (studioEls.download) {
    studioEls.download.href = url;
    studioEls.download.setAttribute('download', `studio-${r.jobId}.mp4`);
    studioEls.download.classList.remove('hidden');
  }
  const mb = typeof r.bytes === 'number' ? (r.bytes / 1048576).toFixed(1) : '?';
  const ms = Number(r.ms) || 0;
  const took = ms > 0 ? (ms / 1000).toFixed(1) + ' 秒' : '?';
  studioProgressShow(true);
  studioProgressSet('渲染完成', 1);
  studioSetHint(
    studioEls.resultHint,
    `${prefix || ''}${r.seconds} 秒 / ${mb} MB / 旁白 ${r.narrationCount || 0} 条 / 用时 ${took}`,
  );
}

/** 渲染：缺代码先补全，再建项目、发渲染请求、同时轮询进度。 */
async function studioRenderCurrent() {
  if (studioBusy) return;
  if (studioMode === 'auto') return studioAutoCreate();
  if (!studioScenes.length) {
    studioSetHint(studioEls.sceneHint, '还没有分镜：先写稿，或者加一场。');
    return;
  }
  if (!studioScenes.some((s) => String(s.text || '').trim() || String(s.narration || '').trim())) {
    studioSetHint(studioEls.sceneHint, '每场都空着，渲出来会是纯色块；先写点东西。');
    return;
  }
  const config = readStudioConfig();
  studioConfig = Object.assign({}, config);
  if (studioEls.video) studioEls.video.classList.add('hidden');
  if (studioEls.download) studioEls.download.classList.add('hidden');
  if (studioEls.raw) studioEls.raw.classList.add('hidden');
  setStudioBusy(true);
  studioProgressShow(true);
  try {
    if (scenesNeedFill()) {
      studioProgressSet('先把「画什么」翻译成动画代码…', 0.03);
      studioSetHint(studioEls.sceneHint, '正在补全动画代码…');
      const plan = studioPlanFromScenes();
      const filled = await studioPost('/api/studio/scenes', {
        title: studioTitle,
        projectId: studioProjectId,
        scenes: plan.scenes,
        style: config.style,
        voice: config.voice,
      });
      if (!filled || !filled.ok) return studioFailure(filled, studioEls.sceneHint);
      adoptStudioScenes(filled);
    }

    // 建/更新项目：拿到稳定 id，进度和成片都按这个 id 走
    studioProgressSet('正在准备渲染…', 0.06);
    const plan = studioPlanFromScenes();
    const created = await studioPost('/api/studio/project', {
      id: studioProjectId,
      title: studioTitle,
      scenes: plan.scenes,
      style: config.style,
      voice: config.voice,
    });
    if (!created || !created.ok) return studioFailure(created, studioEls.sceneHint);
    studioProjectId = String(created.project.id);

    startStudioPoll(studioProjectId);
    studioProgressSet('正在渲染…', 0.08);
    studioSetHint(studioEls.sceneHint, '渲染中：进度会显示第几场。');
    const r = await studioPost('/api/studio/project/render', {
      id: studioProjectId,
      scope: 'auto',
      style: config.style,
      voice: config.voice,
    });
    stopStudioPoll();
    if (!r || !r.ok) {
      studioProgressSet('渲染失败', 1);
      return studioFailure(r, studioEls.sceneHint);
    }
    studioRenderOk(r, '做好了：');
    studioSetHint(studioEls.sceneHint, `渲染完成：${r.seconds} 秒。改一句台词后可以再点渲染，画面会复用缓存。`);
  } catch (err) {
    studioProgressSet('渲染失败', 1);
    studioSetHint(studioEls.sceneHint, '出错：' + ((err && err.message) || err));
  } finally {
    stopStudioPoll();
    setStudioBusy(false);
  }
}

// ------------------------------------------------------------------ 绑定 --

for (const tab of studioEls.tabs) {
  tab.addEventListener('click', () => setStudioMode(tab.dataset.mode));
}
if (studioEls.scriptGo) studioEls.scriptGo.addEventListener('click', studioGenerateScript);
if (studioEls.fill) studioEls.fill.addEventListener('click', studioFillScenes);
if (studioEls.preview) studioEls.preview.addEventListener('click', studioPreview);
if (studioEls.render) studioEls.render.addEventListener('click', studioRenderCurrent);
if (studioEls.sceneAdd) studioEls.sceneAdd.addEventListener('click', studioAddScene);
if (studioEls.sceneList) {
  // 事件委托：行是动态生成的，绑一次就够。input 直接改数组，不重建 DOM。
  studioEls.sceneList.addEventListener('input', onStudioSceneEdit);
  studioEls.sceneList.addEventListener('change', onStudioSceneEdit);
  studioEls.sceneList.addEventListener('click', studioDeleteScene);
}
for (const sel of [studioEls.scriptStyle, studioEls.autoStyle, studioEls.scriptVoice, studioEls.autoVoice]) {
  if (sel) sel.addEventListener('change', () => { studioConfig = readStudioConfig(); updateStudioEstimate(); });
}

/** 切栏：聊天 / 记忆 / 人格 / 账号。 */
function setView(name) {
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const titles = { chat: '聊天', memory: '记忆', video: '做视频', persona: '人格', admin: '账号' };
  if (viewTitle) viewTitle.textContent = titles[name] || '';
  if (name === 'memory') loadMemoryView();
  if (name === 'video') loadStudioView();
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
    const data = await apiJson('/api/stickers?limit=80');
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
    const data = await apiJson(`/api/stickers?q=${encodeURIComponent(stickerQuery)}&limit=60${fav}`);
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
