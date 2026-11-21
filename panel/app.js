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

// ------------------------------------------------- 视频创作（studio）----
/**
 * 默认只有三样：一个输入框、一个时长、一个「开始做」。其它能力都收进「高级」和「历史」。
 *
 * 输入框自动判断怎么走（不跟用户提"模式"两个字）：
 *   短句（像题目）    → 交 prompt，它自己写分镜再出片
 *   大段（像稿子）    → 交 script，先把稿子拆成场再出片
 *   高级区里改过分镜  → 交 scenes，按改过的分镜做
 *
 * 提交后立刻出现一张任务卡（后台跑，不等接口返回）：
 *   每 2 秒问一次 GET /api/studio/jobs/:id，卡片上更新「阶段 3/8」「已用 1 分 12 秒」。
 *   studio 还没有这套接口（回 404）时，回退老流程「拆分镜 → 补动画 → 建项目 → 渲染」，不白屏。
 *
 * 刷新不丢：GET /api/studio/jobs 恢复任务卡，GET /api/studio/library 恢复历史（重做/删除）。
 */

const studioEls = {
  input: document.getElementById('studioInput'),
  seconds: document.getElementById('studioSeconds'),
  go: document.getElementById('studioGo'),
  hint: document.getElementById('studioHint'),
  startError: document.getElementById('studioStartError'),
  redoNote: document.getElementById('studioRedoNote'),
  advToggle: document.getElementById('studioAdvToggle'),
  advBody: document.getElementById('studioAdvBody'),
  binding: document.getElementById('studioBinding'),
  style: document.getElementById('studioStyle'),
  voice: document.getElementById('studioVoice'),
  scenesBox: document.getElementById('studioScenesBox'),
  sceneList: document.getElementById('sceneList'),
  sceneAdd: document.getElementById('sceneAdd'),
  sceneRedoBar: document.getElementById('sceneRedoBar'),
  sceneRedoFrom: document.getElementById('sceneRedoFrom'),
  sceneRedoRun: document.getElementById('sceneRedoRun'),
  sceneTotal: document.getElementById('sceneTotal'),
  fill: document.getElementById('studioFill'),
  sceneHint: document.getElementById('sceneHint'),
  editMeta: document.getElementById('studioEditMeta'),
  jobs: document.getElementById('studioJobs'),
  jobsEmpty: document.getElementById('studioJobsEmpty'),
  libToggle: document.getElementById('studioLibToggle'),
  libBody: document.getElementById('studioLibBody'),
  libList: document.getElementById('studioLibList'),
  libEmpty: document.getElementById('studioLibEmpty'),
  refBtn: document.getElementById('studioRefBtn'),
  refThumb: document.getElementById('studioRefThumb'),
  refImg: document.getElementById('studioRefImg'),
  refClear: document.getElementById('studioRefClear'),
  refHint: document.getElementById('studioRefHint'),
  imageInput: document.getElementById('studioImageInput'),
};

// 分镜表情选择器（给"某一场"加 GIF 表情）：和聊天那个表情面板分开，
// 那边是"发一张给模型看"，这边是"叠到这一场的画面上"。
const sceneStickerEls = {
  modal: document.getElementById('sceneStickerModal'),
  title: document.getElementById('sceneStickerTitle'),
  close: document.getElementById('sceneStickerClose'),
  grid: document.getElementById('sceneStickerGrid'),
  search: document.getElementById('sceneStickerSearch'),
  hint: document.getElementById('sceneStickerHint'),
  tabAll: document.getElementById('sceneStickerTabAll'),
  tabFav: document.getElementById('sceneStickerTabFav'),
};
let sceneStickerTarget = -1;    // 正在给第几场挑表情（-1 = 没开）
let sceneStickerList = [];      // 表情目录缓存（打开选择器才拉）
let sceneStickerQuery = '';
let sceneStickerFavOnly = false;
let sceneStickerTimer = null;

let studioTitle = '';
// 每一场：{text, narration, seconds, visual_hint, tool, kind, manim, status, dirty}
// tool 是用户的选择（manim / text / aivideo / ''=自动），manim 是补全后拿到的代码。
let studioScenes = [];
let studioProjectId = '';      // 老流程（studio 没有 job 接口）用的项目 id
let studioBindingInfo = null;
let studioOptionsLoaded = false;
let studioBusy = false;
// 用户动过分镜表格 → 「开始做」就用它，而不是把输入框重新解释一遍
let studioScenesTouched = false;
// 产出当前分镜时输入框里的字：没变过就还是用那份分镜
let studioScenesFromText = '';
let studioAdvOpen = false;

const studioJobs = new Map();      // jobId -> 任务状态
const studioJobCards = new Map();  // jobId -> {el, sig}：卡片按签名增量更新，别每 2 秒重建
let studioPollTimer = null;
let studioPollBusy = false;
let legacyProgressTimer = null;

let studioLibrary = [];
let studioLibBusy = false;
// 重做模式：从任务卡/历史把分镜载入表格后进入，等用户改完再点「开始做」。
// 来源记下来，给表格上方的「不改，直接重跑」用；recipe 是没有历史条目时的兜底配方。
let studioRedoLibraryId = '';
let studioRedoRecipe = null;
let studioRedoTitle = '';
let studioRedoChanged = false;
// 首屏那张可选参考图：{ uploadId, name } —— 有图就挂到第一场，也放一份在请求体顶层
let studioRefImage = null;

const SCENE_SECONDS_MIN = 2;
const SCENE_SECONDS_MAX = 12;
const SCENE_GAP_SECONDS = 0.4;

// AI 视频额度用完了（网关 429 Throttling.AllocationQuota，12-03 16:00 UTC 重置）。
// 选它不会报错，但那一场会降级成文字卡：先在界面上说清楚，别让人白等一百秒。
const STUDIO_AI_QUOTA_NOTE = 'AI 视频额度已用完（12-03 16:00 UTC 重置）：这一场会降级成文字卡，改用 manim 或文字卡吧。';

function studioSceneSeconds(scene) {
  const n = Number(scene && scene.seconds);
  if (!Number.isFinite(n)) return 5;
  return Math.min(SCENE_SECONDS_MAX, Math.max(SCENE_SECONDS_MIN, n));
}

/** 每场标题那行：`第 3 场 · 约 6.2 秒`（改秒数时跟着更新）。 */
function studioSceneLabel(scene, index) {
  return `第 ${Number(index) + 1} 场 · 约 ${studioSceneSeconds(scene).toFixed(1)} 秒`;
}

function studioSecondsTotal() {
  const count = studioScenes.length;
  if (!count) return 0;
  const sum = studioScenes.reduce((acc, s) => acc + studioSceneSeconds(s), 0);
  return Math.max(0, Math.round((sum - SCENE_GAP_SECONDS * (count - 1)) * 10) / 10);
}

// ---- 小数助手（卡片上的时间 / 体积 / 时间戳）-------------------------------

/** 毫秒 → 人话：58 秒 / 1 分 12 秒 / 1 小时 3 分。 */
function studioFmtSpan(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function studioFmtMB(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  return (n / 1048576).toFixed(1);
}

/** 时间戳可能是毫秒数，也可能是 ISO 串：统一成毫秒。 */
function studioTimeOf(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
}

function studioFmtWhen(ts) {
  const when = studioTimeOf(ts);
  if (!when) return '';
  const d = new Date(when);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- 三个提示位 ------------------------------------------------------------

function setStudioHintText(text) {
  if (studioEls.hint) studioEls.hint.textContent = text;
}

function setStudioSceneHint(text) {
  if (studioEls.sceneHint) studioEls.sceneHint.textContent = text;
}

function setStudioStartError(text) {
  if (!studioEls.startError) return;
  studioEls.startError.textContent = text || '';
  studioEls.startError.classList.toggle('hidden', !text);
}

// ---- 请求：面板自己的 JSON 转发（非 2xx 也把 body 读出来，原因都写在 body 里）--

/**
 * 返回 {status, data}。分不清 404 就分不清"要不要回退老流程"，所以状态码要留。
 * 401 统一弹登录，返回 status=401 让调用方安静退出。
 */
async function studioRequest(url, payload, method) {
  const options = { method: method || (payload ? 'POST' : 'GET') };
  if (payload) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(payload);
  }
  const res = await apiFetch(url, options);
  if (res.status === 401) {
    handleUnauthorized('会话过期，请重新登录');
    return { status: 401, data: { ok: false, error: '登录已过期，请重新登录' } };
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data: data || { ok: false, error: `面板回了 HTTP ${res.status}` } };
}

/** 成功判定：studio 的新建任务回 202，别的口回 200 —— 只要 2xx 都算成。 */
function studioOk(status) {
  return Number(status) >= 200 && Number(status) < 300;
}

/** 失败要说人话：错误码翻成用户能行动的一句话，缺哪几句也点出来。 */
function studioErrorText(r) {
  const error = String((r && (r.error || r.code)) || '');
  const speak = String((r && r.speakError) || '');
  const attempts = Number(r && r.attempts) || 0;
  if (error === 'VOICE_UNAVAILABLE') {
    if (speak === 'QUEUE_TIMEOUT') return '配音排队超时了：另一个任务正占着音色队列，过一会儿再试。';
    if (speak === 'BREEZEBLUE_UNAVAILABLE') {
      return attempts > 0
        ? `配音服务暂时不可用，已重试 ${attempts} 次，请稍后重试。`
        : '配音服务暂时不可用，请稍后重试。';
    }
    if (speak) return `配音失败（${speak}），请稍后重试。`;
    return '配音服务暂时不可用（连不上配音服务），检查服务后再试。';
  }
  if (error === 'QUEUE_TIMEOUT') return '配音排队超时了，过一会儿再试。';
  if (error === 'NO_SCENES' || error === 'SCENES_REQUIRED') return '分镜是空的，先写几场。';
  if (error === 'SCRIPT_REQUIRED' || error === 'PROMPT_REQUIRED') return '先把内容写进去。';
  if (error === 'PLAN_NOT_JSON') return '模型没按格式写分镜，再试一次。';
  if (error === 'IO_FAILED') return '核心没响应（写分镜要用它），稍后再试。';
  if (error === 'UNREACHABLE') return '连不上服务，稍后再试。';
  if (error === 'TIMEOUT') return '请求超时了，稍后再试。';
  if (error === 'NOT_FOUND') return '这个任务找不到了，重新做一次。';
  return error || '未知原因（返回里没有 error 字段）';
}

/** 任务卡上的失败原因：能认的错误码翻成人话，认不出就把原文摆出来。 */
function studioJobErrorText(job) {
  const raw = String((job && (job.error || job.reason)) || '').trim();
  if (!raw) return '没做成，原因没写；过一会儿再点「重做」试一次。';
  const key = raw.toUpperCase();
  // studio 的失败码就这几种，认得出来的都翻成能行动的一句话
  if (key.startsWith('SPEAK_')) return `配音出错了（${raw}），稍后再点「重做」。`;
  const rules = [
    [/BREEZEBLUE|SPEAK_UNAVAILABLE|VOICE_UNAVAILABLE/, '配音服务不可用，已重试过；稍后再点「重做」。'],
    [/QUEUE_TIMEOUT|SPEAK_QUEUE/, '配音排队超时了：别的任务正占着音色，过一会儿再试。'],
    [/NO_SCENES|SCENES_REQUIRED/, '分镜是空的：先在高级区写几场。'],
    [/SCRIPT_REQUIRED|PROMPT_REQUIRED|INPUT_REQUIRED/, '先把要做什么写进输入框。'],
    [/PLAN_NOT_JSON|PLAN_INVALID/, '模型没按格式写分镜，再点一次「重做」试试。'],
    [/IO_FAILED|UNREACHABLE|ECONNREFUSED|ECONNRESET/, '连不上服务，稍后再试。'],
    [/TIMEOUT/, '等太久了，超时；稍后再点「重做」。'],
    [/NOT_FOUND/, '这条任务服务端已经没有了。'],
    [/CANCEL/, '任务被取消了。'],
    [/JOB_CRASHED|INTERNAL/, '任务崩了（服务端异常），点「重做」再试一次。'],
    [/MANIM|PYPLOT/, '这一场的动画生成失败（manim 那边出错），换一场「画什么」再试。'],
    [/WAN_|AIVIDEO|AI_VIDEO/, 'AI 画面生成失败（额度或服务问题）：改用 manim 或文字卡。'],
    [/PERSONA_/, '读不到人设（音色/风格），稍后再试。'],
    [/FFMPEG|RENDER_FAILED|RENDER_ERROR/, '渲染失败（ffmpeg 那边报错了）。'],
  ];
  for (const [re, text] of rules) if (re.test(key)) return text;
  return raw;
}

// ---- 人设绑定 / 风格 / 音色（都在高级区里）--------------------------------

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

/** 历史里存的是具体风格/音色 id：有就选上，没有（服务端改过名）就退回"跟人设"。 */
function setStudioSelectValue(select, value) {
  if (!select || value == null) return;
  const want = String(value);
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
  const keepStyle = studioEls.style ? studioEls.style.value : '';
  const keepVoice = studioEls.voice ? studioEls.voice.value : '';
  fillStudioSelect(studioEls.style, styleItems, studioPersonaStyleLabel(), keepStyle);
  fillStudioSelect(studioEls.voice, voiceItems, studioPersonaVoiceLabel(), keepVoice);
  studioOptionsLoaded = styleItems.length > 0 || voiceItems.length > 0;
}

/** 原「当前：大肥鱼（迷糊版）· 白板讲解 · 温柔口语」那行：现在只在高级区当只读说明。 */
async function loadStudioBinding() {
  const data = await apiJson('/api/studio/binding');
  if (!data || !data.ok) {
    if (studioEls.binding) studioEls.binding.textContent = '人设绑定暂时读不到：音色和风格会用默认值。';
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

// ---- 分镜表格（高级区里的老能力，默认折叠）--------------------------------

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

/** 工具下拉。AI 视频额度已经用完，选项上直接标出来，别让人选了才发现。 */
function studioToolSelect(value) {
  const select = document.createElement('select');
  select.dataset.field = 'tool';
  const options = [
    ['', '自动'],
    ['manim', 'manim（公式/图表）'],
    ['aivideo', 'AI 视频（额度用完）'],
    ['text', '文字卡'],
  ];
  for (const [val, label] of options) {
    const option = document.createElement('option');
    option.value = val;
    option.textContent = label;
    if (val === 'aivideo') option.title = STUDIO_AI_QUOTA_NOTE;
    select.append(option);
  }
  select.value = value || '';
  return select;
}

/** 状态就一个字符：✓ 好 / ↓ 降级成文字卡 / ✗ 还没好。详细解释放 title 里。 */
function studioStatusChar(scene) {
  if (scene.status === 'fallback') return '↓';
  if (scene.tool === 'text' || scene.status === 'text') return '✓';
  if (scene.tool === 'aivideo') return (scene.video && scene.video.prompt) ? '✓' : '✗';
  if (scene.manim && scene.manim.code && !scene.dirty) return '✓';
  return '✗';
}

function studioStatusTitle(scene) {
  const mark = studioStatusChar(scene);
  if (mark === '↓') return '降级成文字卡（生成失败）';
  if (mark === '✓') {
    if (scene.tool === 'aivideo') return 'AI 画面提示词已就绪';
    if (scene.tool === 'text' || scene.status === 'text') return '文字卡';
    return '已生成动画代码';
  }
  return scene.dirty ? '改过了，要重新生成' : '还没生成：点「补全动画」，或直接「开始做」';
}

function studioStatusClass(scene) {
  const mark = studioStatusChar(scene);
  if (mark === '↓') return 'bad';
  if (mark === '✓') return (scene.tool === 'text' || scene.status === 'text') ? 'plain' : 'good';
  return 'wait';
}

/**
 * 一场里的表情：只留渲染层认识的字段，id 统一小写（文件名是 sha1 的小写）。
 * 上限 4 个和 studio/lib/project.js 的 normalizeScene 对齐，超了后端也会截掉。
 */
function studioStickersOf(raw) {
  const out = [];
  for (const s of (Array.isArray(raw) ? raw : [])) {
    const id = String((s && s.id) || '').toLowerCase();
    if (!/^[0-9a-f]{6,40}$/.test(id)) continue;
    out.push({
      id,
      at: Math.max(0, Number(s.at) || 0),
      duration: Math.min(10, Math.max(0.4, Number(s.duration) || 1.6)),
      x: Math.min(1, Math.max(0, s.x == null ? 0.82 : Number(s.x))),
      y: Math.min(1, Math.max(0, s.y == null ? 0.18 : Number(s.y))),
      scale: Math.min(0.6, Math.max(0.08, s.scale == null ? 0.2 : Number(s.scale))),
    });
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * 新加一个表情时的默认落点：中后段起、右上/左下交替、1.6 秒、0.2 屏高。
 * 手动加的表情不需要用户填时间 —— 先给一个"不挡主体、能看清"的位置，
 * 真想改再改 scenes JSON（面板不把这件事做成表单）。
 */
function studioStickerPlacement(scene, ordinal) {
  const seconds = studioSceneSeconds(scene);
  const baseAt = Math.min(Math.max(0.5, seconds * 0.5), Math.max(0.5, seconds - 1.1));
  const at = Math.min(Math.max(0.5, baseAt + (ordinal % 2) * 0.6), Math.max(0.5, seconds - 0.8));
  const duration = Math.max(0.8, Math.min(1.6, seconds - at - 0.1));
  const corner = ordinal % 2 === 0 ? { x: 0.82, y: 0.18 } : { x: 0.16, y: 0.80 };
  return {
    at: Math.round(at * 10) / 10,
    duration: Math.round(duration * 10) / 10,
    x: corner.x,
    y: corner.y,
    scale: 0.2,
  };
}

/**
 * 一场空白分镜：追加（「加一场」）和中间插入共用一份。
 * dirty=true：这场还没生成过动画，提交时不会带 kind / manim 代码，
 * studio 看到"没有成品"就会重新生成，不会被当成"没改"复用旧缓存。
 */
function studioBlankScene() {
  return {
    text: '',
    narration: '',
    seconds: 5,
    visual_hint: '',
    tool: '',
    kind: 'text',
    manim: null,
    status: 'pending',
    note: '',
    image: '',
    stickers: [],
    dirty: true,
  };
}

/** 相邻卡片之间的插入条：平时是一条细线，移上去才露出「+ 在这里插入一场」。 */
function studioInsertBar(at) {
  const wrap = document.createElement('div');
  wrap.className = 'scene-insert';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'scene-insert-btn';
  btn.dataset.insertAt = String(at);
  btn.title = at >= studioScenes.length
    ? '在最后追加一场空白分镜'
    : `在第 ${Number(at) + 1} 场前面插入一场空白分镜`;
  const label = document.createElement('span');
  label.textContent = '+ 在这里插入一场';
  btn.append(label);
  wrap.append(btn);
  return wrap;
}

/**
 * 把焦点放到第 index 场的「标题」，并把它滚到看得见的位置。
 * 插入/追加之后都走这里：别让人自己往下找新加的那一场。
 */
function focusStudioScene(index) {
  if (!studioEls.sceneList) return;
  const row = studioEls.sceneList.querySelector(`.scene[data-index="${index}"]`);
  if (!row) return;
  const title = row.querySelector('.scene-text');
  if (title) {
    // preventScroll：滚动交给下面的 scrollIntoView，别两边同时抢
    try { title.focus({ preventScroll: true }); } catch (err) { title.focus(); }
  }
  if (row.scrollIntoView) {
    try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { row.scrollIntoView(); }
  }
  row.classList.add('scene-fresh');
  setTimeout(() => row.classList.remove('scene-fresh'), 1600);
}

/** 整块重建。只在增删场次 / 换新分镜时调用，输入过程中绝不重排 DOM。 */
function renderStudioScenes() {
  if (!studioEls.sceneList) return;
  studioEls.sceneList.textContent = '';
  if (!studioScenes.length) {
    const tip = document.createElement('p');
    tip.className = 'muted';
    tip.textContent = '还没有分镜：在上面写一句点「开始做」，它自己会写；也可以点「加一场」自己写。';
    studioEls.sceneList.append(tip);
    return;
  }

  studioScenes.forEach((scene, index) => {
    // 每张卡片前面一条插入条：第 N 条 = 插到第 N 场之前（最后一条 = 追加到末尾）
    studioEls.sceneList.append(studioInsertBar(index));
    const row = document.createElement('div');
    row.className = 'scene';
    row.dataset.index = String(index);

    const head = document.createElement('div');
    head.className = 'scene-head';
    const no = document.createElement('span');
    no.className = 'scene-no';
    no.textContent = studioSceneLabel(scene, index);
    const badge = document.createElement('span');
    badge.className = `scene-badge ${studioStatusClass(scene)}`;
    badge.textContent = studioStatusChar(scene);
    badge.title = studioStatusTitle(scene);
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
    hint.placeholder = scene.tool === 'aivideo'
      ? 'AI 生成画面的提示词：主体+动作+风格+镜头，比如 anime style, two girls facing off in snow, wide shot'
      : '自然语言描述要画什么，比如：画坐标轴、曲线上两个点，连线，然后让点靠近变成切线';
    hint.value = scene.visual_hint || '';
    row.append(studioField(scene.tool === 'aivideo' ? '画什么（AI 生成画面的提示词）' : '画什么（会翻译成 manim 代码）', hint));
    // 空的时候不能只留一个空框：旧配方 / 写稿拆出来的场次都可能没有「画什么」，
    // 用户看到的应该是一句可操作的提示，而不是一片空白。
    if (!String(scene.visual_hint || '').trim()) {
      const empty = document.createElement('p');
      empty.className = 'scene-visual-empty muted';
      empty.textContent = scene.tool === 'aivideo'
        ? '还没写「画什么」：这一场会按标题/旁白自动写 AI 画面描述。'
        : '还没写「画什么」：这一场会按标题/旁白自动决定画什么；想指定就写一句（图形/标注/动作）。';
      row.append(empty);
    }

    // 这一场的参考图（可选）：按钮 + 缩略图 + 去掉
    const imageBox = document.createElement('div');
    imageBox.className = 'scene-image';
    imageBox.dataset.imageFor = String(index);
    row.append(imageBox);
    renderSceneImageBox(imageBox, scene, index);

    // 这一场的 GIF 表情（可选）：手动加，和自动分镜用的是同一套 stickers 字段
    const stickerBox = document.createElement('div');
    stickerBox.className = 'scene-stickers';
    stickerBox.dataset.stickerFor = String(index);
    row.append(stickerBox);
    renderSceneStickerBox(stickerBox, scene, index);

    if (scene.note) {
      const note = document.createElement('p');
      note.className = 'scene-warning muted';
      note.textContent = scene.note;
      row.append(note);
    }
    studioEls.sceneList.append(row);
  });
  studioEls.sceneList.append(studioInsertBar(studioScenes.length));
}

/** 分镜框那一行的标题：标题 + 场数 + 总时长。编辑时只动这行字。 */
function updateStudioMeta() {
  if (studioEls.sceneTotal) {
    const count = studioScenes.length;
    studioEls.sceneTotal.textContent = count
      ? `共 ${count} 场 · 约 ${studioSecondsTotal().toFixed(1)} 秒`
      : '共 0 场';
  }
  // 增删场后顶部的「已载入 N 场」也要跟着变
  if (studioRedoActive()) updateStudioRedoUi();
  if (!studioEls.editMeta) return;
  const count = studioScenes.length;
  if (!count) {
    studioEls.editMeta.textContent = studioTitle ? `《${studioTitle}》· 还没有分镜` : '还没有分镜';
    return;
  }
  const manim = studioScenes.filter((s) => s.manim && s.manim.code).length;
  const ai = studioScenes.filter((s) => s.tool === 'aivideo').length;
  const title = studioTitle ? `《${studioTitle}》` : '未命名';
  studioEls.editMeta.textContent = `${title} · ${count} 场 · 总时长 ${studioSecondsTotal().toFixed(1)} 秒 · 动画 ${manim} 场`
    + (ai ? ` · AI 画面 ${ai} 场` : '');
}

/** 只更新这一行的警告行，不重建整行（光标不跳）。 */
function applySceneNote(row, scene) {
  if (!row) return;
  let note = row.querySelector('.scene-warning');
  if (!scene.note) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement('p');
    note.className = 'scene-warning muted';
    row.append(note);
  }
  note.textContent = scene.note;
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
      // 「画什么」或工具变了，旧代码就过时了：下次会用新的重新生成。
      scene.dirty = true;
      scene.status = field === 'tool' && control.value === 'text' ? 'text' : 'pending';
      // 关键一行：把旧 manim 代码丢掉。不清的话提交时会原样带回 studio，
      // studio 看到 code 就沿用 —— 用户改了描述却还是按上一次的画（实测 bug）。
      if (field === 'visual_hint') scene.manim = null;
      // AI 生成场的旧英文 prompt 也不再对应用户新写的描述，清掉才会重新翻译
      if (field === 'visual_hint' && scene.tool === 'aivideo') scene.video = null;
    }
    if (field === 'tool') {
      // 额度已用完：选了就先说清楚，别等渲染时才降级
      if (control.value === 'aivideo' && !scene.note) scene.note = STUDIO_AI_QUOTA_NOTE;
      if (control.value !== 'aivideo' && scene.note === STUDIO_AI_QUOTA_NOTE) scene.note = '';
      applySceneNote(row, scene);
    }
  }
  // 用户动过表格 → 以后「开始做」优先用这份分镜
  studioScenesTouched = true;
  const no = row.querySelector('.scene-no');
  if (no) no.textContent = studioSceneLabel(scene, row.dataset.index);
  markStudioRedoChanged();
  updateStudioMeta();
  updateStudioHint();
  // 状态标记跟着变（只更新这一行那个字符，不重建行）
  const badge = row.querySelector('.scene-badge');
  if (badge) {
    badge.textContent = studioStatusChar(scene);
    badge.title = studioStatusTitle(scene);
    badge.className = `scene-badge ${studioStatusClass(scene)}`;
  }
}

// ---- 参考图（复用聊天那套 PUT /api/upload，不新造上传口）------------------

function studioImageUrl(uploadId) {
  return `/api/upload/${encodeURIComponent(uploadId)}`;
}

/** 一场的参考图那一行：选图按钮 + 缩略图 + 去掉。 */
function renderSceneImageBox(box, scene, index) {
  if (!box) return;
  box.textContent = '';
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'scene-image-pick';
  pick.dataset.act = 'pick-image';
  pick.dataset.index = String(index);
  pick.textContent = scene.image ? '换参考图' : '参考图';
  pick.title = '给这一场挂一张参考图（可选）';
  box.append(pick);
  if (scene.image) {
    const thumb = document.createElement('span');
    thumb.className = 'scene-image-thumb';
    const img = document.createElement('img');
    img.src = studioImageUrl(scene.image);
    img.alt = `第 ${index + 1} 场参考图`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'scene-image-x';
    del.dataset.act = 'clear-image';
    del.dataset.index = String(index);
    del.textContent = '×';
    del.title = '去掉这张图';
    thumb.append(img, del);
    box.append(thumb);
  } else {
    const hint = document.createElement('span');
    hint.className = 'scene-image-hint muted';
    hint.textContent = '可选：让这一场照着这张图画';
    box.append(hint);
  }
}

/** 这一场的表情那一行：按钮 + 已选数量 + 小缩略图（点 × 删）。 */
function renderSceneStickerBox(box, scene, index) {
  if (!box) return;
  box.textContent = '';
  const stickers = studioStickersOf(scene.stickers);
  scene.stickers = stickers; // 顺手规范一份，提交时用的就是它
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'scene-sticker-pick';
  pick.dataset.act = 'pick-sticker';
  pick.dataset.index = String(index);
  pick.textContent = stickers.length ? '加表情' : '表情';
  pick.title = '给这一场加 GIF 表情（最多 4 个，渲染时叠在画面上）';
  box.append(pick);

  if (!stickers.length) {
    const hint = document.createElement('span');
    hint.className = 'scene-sticker-hint muted';
    hint.textContent = '可选：只加在情绪点上，别每场都放';
    box.append(hint);
    return;
  }

  const count = document.createElement('span');
  count.className = 'scene-sticker-count muted';
  count.textContent = `已选 ${stickers.length}/4`;
  box.append(count);

  stickers.forEach((st, si) => {
    const thumb = document.createElement('span');
    thumb.className = 'scene-sticker-thumb';
    thumb.title = `第 ${si + 1} 个 · ${st.at}s 起，持续 ${st.duration}s`;
    const img = document.createElement('img');
    img.src = `/api/stickers/gif?id=${encodeURIComponent(st.id)}`;
    img.alt = `第 ${index + 1} 场的表情`;
    img.loading = 'lazy';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'scene-sticker-x';
    del.dataset.act = 'clear-sticker';
    del.dataset.index = String(index);
    del.dataset.sticker = String(si);
    del.textContent = '×';
    del.title = '去掉这个表情';
    thumb.append(img, del);
    box.append(thumb);
  });
}

// ---- 分镜表情选择器（浮层）------------------------------------------------

function openSceneStickerPicker(index) {
  if (!studioScenes[index]) return;
  sceneStickerTarget = index;
  if (sceneStickerEls.title) {
    sceneStickerEls.title.textContent = `给第 ${index + 1} 场挑个表情`;
  }
  if (sceneStickerEls.modal) {
    sceneStickerEls.modal.classList.remove('hidden');
    sceneStickerEls.modal.setAttribute('aria-hidden', 'false');
  }
  if (sceneStickerEls.search) sceneStickerEls.search.value = sceneStickerQuery;
  // 目录已经拉过就直接画，没拉过才请求：来回给多场加表情时不再等一次网络
  if (sceneStickerList.length) renderSceneStickerModal();
  else loadSceneStickers('');
}

function closeSceneStickerPicker() {
  if (sceneStickerEls.modal) {
    sceneStickerEls.modal.classList.add('hidden');
    sceneStickerEls.modal.setAttribute('aria-hidden', 'true');
  }
  sceneStickerTarget = -1;
}

async function loadSceneStickers(q) {
  sceneStickerQuery = q || '';
  if (sceneStickerEls.hint) {
    sceneStickerEls.hint.textContent = sceneStickerFavOnly ? '正在找收藏…' : '正在找…';
  }
  try {
    // 复用聊天那套表情代理：/api/stickers 已经带 favorite 字段，图走 /api/stickers/gif
    const fav = sceneStickerFavOnly ? '&favorite=1' : '';
    const data = await apiJson(`/api/stickers?q=${encodeURIComponent(sceneStickerQuery)}&limit=120${fav}`);
    if (!data || !data.ok) {
      if (sceneStickerEls.hint) sceneStickerEls.hint.textContent = '表情包服务没响应（模块可能没起）';
      return;
    }
    sceneStickerList = Array.isArray(data.items) ? data.items : [];
    renderSceneStickerModal();
  } catch (err) {
    if (sceneStickerEls.hint) sceneStickerEls.hint.textContent = '加载失败：' + ((err && err.message) || err);
  }
}

/** 画选择器网格：点一张加到目标场；右上角 ★ 只切收藏。 */
function renderSceneStickerModal() {
  const grid = sceneStickerEls.grid;
  if (!grid) return;
  grid.textContent = '';
  const scene = studioScenes[sceneStickerTarget];
  if (!scene) return;
  const picked = studioStickersOf(scene.stickers);
  const items = sceneStickerFavOnly
    ? sceneStickerList.filter((it) => it && it.favorite)
    : sceneStickerList;
  if (!items.length) {
    if (sceneStickerEls.hint) {
      sceneStickerEls.hint.textContent = sceneStickerFavOnly
        ? '还没有收藏，点右上角 ★ 收一张'
        : '没找到，换个词试试';
    }
    return;
  }
  if (sceneStickerEls.hint) {
    sceneStickerEls.hint.textContent = `共 ${items.length} 张 · 点一张加到第 ${sceneStickerTarget + 1} 场（这一场 ${picked.length}/4）`;
  }
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-cell';
    const label = it.mood || it.name || it.id;
    const already = picked.some((st) => st.id === String(it.id || '').toLowerCase());
    if (already) btn.classList.add('picked');
    btn.title = already ? `${label}（这一场已经加过）` : label;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/api/stickers/gif?id=${encodeURIComponent(it.id)}`;
    img.alt = label;
    btn.appendChild(img);

    // 和聊天那个面板同一种星星：只切收藏，不触发"选中"
    const star = document.createElement('span');
    star.className = 'sticker-star';
    star.setAttribute('role', 'button');
    star.tabIndex = 0;
    paintStickerStar(star, it.favorite);
    const toggle = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleSceneStickerFavorite(it);
    };
    star.addEventListener('click', toggle);
    star.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') toggle(ev);
    });
    btn.appendChild(star);

    btn.addEventListener('click', () => addSceneSticker(it));
    grid.appendChild(btn);
  }
}

/** 选中一张：给目标场追加一个表情（默认落点见 studioStickerPlacement）。 */
function addSceneSticker(item) {
  const scene = studioScenes[sceneStickerTarget];
  if (!scene || !item || !item.id) return;
  const stickers = studioStickersOf(scene.stickers);
  if (stickers.length >= 4) {
    if (sceneStickerEls.hint) sceneStickerEls.hint.textContent = '这一场已经 4 个了（渲染层上限 4 个）';
    return;
  }
  const id = String(item.id).toLowerCase();
  stickers.push(Object.assign({ id }, studioStickerPlacement(scene, stickers.length)));
  scene.stickers = stickers;
  studioScenesTouched = true;
  markStudioRedoChanged();

  // 只重画这一行的表情条，不重建整张表（输入框光标不跳）
  const row = studioEls.sceneList
    ? studioEls.sceneList.querySelector(`.scene[data-index="${sceneStickerTarget}"]`)
    : null;
  const box = row ? row.querySelector('.scene-stickers') : null;
  if (box) renderSceneStickerBox(box, scene, sceneStickerTarget);
  renderSceneStickerModal();
  if (sceneStickerEls.hint) {
    sceneStickerEls.hint.textContent = `已加「${item.mood || item.name || id}」，这一场 ${stickers.length}/4`;
  }
  setStudioSceneHint(`第 ${sceneStickerTarget + 1} 场加了表情：${stickers.length} 个。改完回上面点「开始做」。`);
  updateStudioMeta();
  updateStudioHint();
}

/** 选择器里的 ★：收藏 / 取消收藏（失败只提示，不影响已选表情）。 */
async function toggleSceneStickerFavorite(item) {
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
      if (sceneStickerEls.hint) {
        sceneStickerEls.hint.textContent = (want ? '收藏失败：' : '取消收藏失败：') + ((r && r.error) || '未知原因');
      }
      return;
    }
    item.favorite = want;
    const row = sceneStickerList.find((x) => x && x.id === item.id);
    if (row) row.favorite = want;
    renderSceneStickerModal();
    if (sceneStickerEls.hint) {
      sceneStickerEls.hint.textContent = want ? `已收藏「${label}」★` : `已取消收藏「${label}」`;
    }
  } catch (err) {
    if (sceneStickerEls.hint) sceneStickerEls.hint.textContent = '收藏失败：' + ((err && err.message) || err);
  }
}

/** 全部 / 收藏 两个标签页。 */
function setSceneStickerTab(fav) {
  sceneStickerFavOnly = Boolean(fav);
  if (sceneStickerEls.tabAll) sceneStickerEls.tabAll.classList.toggle('active', !sceneStickerFavOnly);
  if (sceneStickerEls.tabFav) sceneStickerEls.tabFav.classList.toggle('active', sceneStickerFavOnly);
  loadSceneStickers(sceneStickerQuery);
}

/** 首屏那张参考图：没图就只显示一行小字，有图才出缩略图。 */
function renderStudioRefBox() {
  const has = Boolean(studioRefImage && studioRefImage.uploadId);
  if (studioEls.refThumb) studioEls.refThumb.classList.toggle('hidden', !has);
  if (studioEls.refImg) {
    if (has) studioEls.refImg.src = studioImageUrl(studioRefImage.uploadId);
    else studioEls.refImg.removeAttribute('src');
  }
  if (studioEls.refHint) {
    studioEls.refHint.textContent = has
      ? `已挂：${studioRefImage.name || '参考图'}`
      : '画面会参考这张图';
  }
  if (studioEls.refBtn) studioEls.refBtn.textContent = has ? '换一张图' : '+ 参考图（可选）';
}

/** 挑图：只打开那个共用的 file input，把"挂给谁"记在 data-target 上。 */
function pickStudioImage(target) {
  const input = studioEls.imageInput;
  if (!input) return;
  input.dataset.target = String(target || 'ref');
  input.value = '';
  input.click();
}

/** 选好图就传：成功把 uploadId 记进那一场（或首屏那张）。 */
async function onStudioImagePicked(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  const target = String(input.dataset.target || 'ref');
  input.value = '';
  if (!file) return;
  if (!/^image\//i.test(String(file.type || '')) && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || '')) {
    setStudioStartError('这不是图片：选 png / jpg / webp 这类文件。');
    return;
  }
  setStudioStartError('');
  const index = target.startsWith('scene:') ? Number(target.slice('scene:'.length)) : -1;
  if (index >= 0) setStudioSceneHint('正在上传参考图…');
  else setStudioHintText('正在上传参考图…');
  try {
    // 和聊天同一个上传口：PUT /api/upload（XHR 直传，带上 Bearer）
    const data = await uploadFile({ file, name: file.name || 'image.png', size: Number(file.size) || 0, kindHint: 'image' });
    if (!data || !data.ok || !data.uploadId) throw new Error((data && (data.error || data.message)) || '上传没成功');
    if (index >= 0) {
      const scene = studioScenes[index];
      if (scene) {
        scene.image = String(data.uploadId);
        studioScenesTouched = true;
        markStudioRedoChanged();
        const row = studioEls.sceneList ? studioEls.sceneList.querySelector(`.scene[data-index="${index}"]`) : null;
        const box = row ? row.querySelector('.scene-image') : null;
        if (box) renderSceneImageBox(box, scene, index);
      }
      setStudioSceneHint('图片挂上了：这一场会参考它。改完回上面点「开始做」。');
    } else {
      studioRefImage = { uploadId: String(data.uploadId), name: String(data.name || file.name || '') };
      renderStudioRefBox();
      updateStudioHint();
    }
  } catch (err) {
    // 上传口也要认登录态：401 说明会话没了，直接把登录层拉起来，别只说"上传失败"
    if (err && (err.status === 401 || err.code === 'E_UNAUTHORIZED')) {
      handleUnauthorized('会话过期，请重新登录');
      setStudioStartError('登录已过期：重新登录后就能传图了。');
      if (index >= 0) setStudioSceneHint('登录已过期：重新登录后就能传图了。');
      return;
    }
    const reason = (err && err.message) || String(err);
    setStudioStartError('参考图上传失败：' + reason);
    if (index >= 0) setStudioSceneHint('参考图上传失败：' + reason);
  }
}

/** 分镜行里的「参考图 / 去掉」（事件委托）。 */
function onStudioSceneImageClick(event) {
  const pick = event.target.closest('[data-act="pick-image"]');
  if (pick) {
    const index = Number(pick.dataset.index);
    if (Number.isFinite(index)) pickStudioImage(`scene:${index}`);
    return;
  }
  const clear = event.target.closest('[data-act="clear-image"]');
  if (!clear) return;
  const index = Number(clear.dataset.index);
  const scene = studioScenes[index];
  if (!scene) return;
  scene.image = '';
  studioScenesTouched = true;
  markStudioRedoChanged();
  const row = clear.closest('.scene');
  const box = row ? row.querySelector('.scene-image') : null;
  if (box) renderSceneImageBox(box, scene, index);
}

/** 分镜行里的「表情 / 删掉某个表情」（事件委托）。 */
function onStudioSceneStickerClick(event) {
  const pick = event.target.closest('[data-act="pick-sticker"]');
  if (pick) {
    const index = Number(pick.dataset.index);
    if (Number.isFinite(index)) openSceneStickerPicker(index);
    return;
  }
  const clear = event.target.closest('[data-act="clear-sticker"]');
  if (!clear) return;
  const index = Number(clear.dataset.index);
  const si = Number(clear.dataset.sticker);
  const scene = studioScenes[index];
  if (!scene || !Array.isArray(scene.stickers) || !Number.isInteger(si)) return;
  scene.stickers.splice(si, 1);
  studioScenesTouched = true;
  markStudioRedoChanged();
  const row = clear.closest('.scene');
  const box = row ? row.querySelector('.scene-stickers') : null;
  if (box) renderSceneStickerBox(box, scene, index);
  setStudioSceneHint(scene.stickers.length
    ? `第 ${index + 1} 场还有 ${scene.stickers.length} 个表情。`
    : `第 ${index + 1} 场的表情已经全部去掉了。`);
  updateStudioMeta();
  updateStudioHint();
}

/** 去掉首屏那张参考图。 */
function clearStudioRefImage() {
  studioRefImage = null;
  renderStudioRefBox();
  updateStudioHint();
}

function studioDeleteScene(event) {
  const del = event.target.closest('.scene-del');
  if (!del) return;
  const row = del.closest('.scene');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) return;
  studioScenes.splice(index, 1);
  studioScenesTouched = true;
  markStudioRedoChanged();
  renderStudioScenes();
  updateStudioMeta();
  updateStudioHint();
}

/**
 * 在第 at 场前面插入一场空白分镜（at = 数组长度就是追加到末尾）。
 * 直接改数组再整块重建：所有「第 N 场」「约 X 秒」「共 N 场」都按新顺序重算。
 */
function studioInsertScene(at) {
  const total = studioScenes.length;
  let pos = Math.floor(Number(at));
  if (!Number.isFinite(pos)) pos = total;
  pos = Math.max(0, Math.min(total, pos));
  studioScenes.splice(pos, 0, studioBlankScene());
  studioScenesTouched = true;
  markStudioRedoChanged();
  renderStudioScenes();
  updateStudioMeta();
  updateStudioHint();
  focusStudioScene(pos);
  setStudioSceneHint(`已在第 ${pos + 1} 场插入一场空白分镜，改完点「开始做」。`);
}

/** 插入条上的点击：data-insert-at 就是这个位置在数组里的下标。 */
function onStudioSceneInsert(event) {
  const btn = event.target.closest('[data-insert-at]');
  if (!btn) return;
  const at = Number(btn.dataset.insertAt);
  if (!Number.isFinite(at)) return;
  studioInsertScene(at);
}

function studioAddScene() {
  studioScenes.push(studioBlankScene());
  studioScenesTouched = true;
  markStudioRedoChanged();
  renderStudioScenes();
  updateStudioMeta();
  updateStudioHint();
  focusStudioScene(studioScenes.length - 1);
}

/** 分镜 → 交给 studio 的场景数组。tool=text 时把旧代码丢掉，别让文字卡带着动画。 */
function studioPlanFromScenes() {
  const scenes = studioScenes.map((s) => {
    // 改过「画什么」的场（dirty）一定不能把旧代码带回去：studio 看到有 code 就会直接沿用，
    // 结果就是"改了描述、成片还是上一次的画"。清掉 code + 不传 kind，让 studio 重新生成。
    const useManim = !s.dirty && s.tool !== 'text' && s.tool !== 'aivideo' && s.manim && s.manim.code;
    if (s.tool === 'aivideo') {
      // AI 生成场：已经翻好的 video.prompt 原样带回；只有中文「画什么」时只传 visual_hint，
      // 让 studio 负责翻英文（它才有模型），别把中文当英文 prompt 直接塞给生成接口。
      const out = {
        kind: 'aivideo',
        text: String(s.text || ''),
        narration: String(s.narration || ''),
        seconds: Number(s.seconds) || 5,
        tool: 'aivideo',
        visual_hint: String(s.visual_hint || '').trim(),
      };
      const videoPrompt = String((s.video && s.video.prompt) || '').trim();
      if (videoPrompt && !s.dirty) out.video = { prompt: videoPrompt, size: (s.video && s.video.size) || '1280*720' };
      if (s.image) out.image = String(s.image);
      // 表情跟着场景走：选了就要渲进画面，不能在上交这一步悄悄丢掉
      const aiStickers = studioStickersOf(s.stickers);
      if (aiStickers.length) out.stickers = aiStickers;
      return out;
    }
    const out = {
      text: String(s.text || '').trim(),
      narration: String(s.narration || '').trim(),
      seconds: studioSceneSeconds(s),
      visual_hint: String(s.visual_hint || '').trim(),
      tool: String(s.tool || ''),
      manim: useManim ? s.manim : null,
    };
    if (useManim) out.manimHint = String(s.manimHint || '');
    // 没改过的场照旧带上 kind（studio 可直通，不重算引擎）；改过的场故意不带：
    // 否则 kind:'text' 会让 studio 的 scenesLookFinal 误判成"已经补全"，又跳过重新生成。
    if (!s.dirty) out.kind = useManim ? 'manim' : 'text';
    // 参考图只在真有的时候才带：删掉图，请求体里就不该再有这个字段
    if (s.image) out.image = String(s.image);
    const stickers = studioStickersOf(s.stickers);
    if (stickers.length) out.stickers = stickers;
    return out;
  });
  return { title: studioTitle, scenes };
}

/** 服务端返回的分镜 → 内存状态。不同接口拿到的形状略有不同，在这里收口。 */
function adoptStudioScenes(data) {
  if (!data) return;
  // 写稿/分镜把场景放在顶层 scenes；全自动的 plan 放在 plan.scenes
  const list = Array.isArray(data.scenes)
    ? data.scenes
    : (data.plan && Array.isArray(data.plan.scenes) ? data.plan.scenes : []);
  const fallbackTitle = data.plan && data.plan.title ? data.plan.title : '';
  studioTitle = String(data.title || fallbackTitle || studioTitle || '').slice(0, 60) || studioTitle;
  studioScenes = list.map((s) => {
    const hasManim = Boolean(s && s.manim && s.manim.code);
    // 代码是按哪句「画什么」生成的（studio 存成场景级 manimHint；老数据在 manim.hint）
    const manimHint = hasManim
      ? String((s.manimHint != null ? s.manimHint : (s.manim.hint != null ? s.manim.hint : (s.visual_hint || ''))) || '')
      : '';
    // aivideo 必须整块带回来：kind/tool 丢了，下一次 studioPlanFromScenes 就会把它当文字卡。
    const wantsAi = Boolean(s && (s.kind === 'aivideo' || s.tool === 'aivideo'));
    const videoPrompt = String((s && s.video && s.video.prompt) || '').trim();
    const hasVideo = wantsAi && Boolean(videoPrompt);
    const tool = wantsAi
      ? 'aivideo'
      : (s && s.tool === 'text'
        ? 'text'
        : (s && s.tool === 'manim' ? 'manim' : (s && s.kind === 'text' && !hasManim ? 'text' : (hasManim ? 'manim' : ''))));
    return {
      text: String((s && s.text) || ''),
      narration: String((s && s.narration) || ''),
      seconds: studioSceneSeconds(s),
      // 只有 video.prompt 没有「画什么」时，把英文 prompt 显示在输入框里，
      // 让用户看得见真正会送去生成的那句话（改它就会重新翻译）。
      visual_hint: String((s && s.visual_hint) || (hasVideo ? videoPrompt : '')),
      tool,
      kind: hasManim ? 'manim' : (wantsAi ? 'aivideo' : 'text'),
      // 顺手带上代码对应的「画什么」戳：studio 靠它判断这段代码有没有过期。
      // 场景级字段（不进 manim 对象），不会改变 studio 的画面缓存键。
      manim: hasManim ? { code: s.manim.code, scene: s.manim.scene || null } : null,
      manimHint,
      video: hasVideo ? { prompt: videoPrompt, size: (s.video && s.video.size) || '1280*720' } : null,
      status: (s && s.status) || (hasManim ? 'manim' : (hasVideo ? 'aivideo' : 'pending')),
      note: String((s && s.note) || ''),
      image: String((s && s.image) || ''),
      // 自动分镜挑的表情要带回表格里：用户看得见、能删，重渲时也还在
      stickers: studioStickersOf(s && s.stickers),
      dirty: false,
    };
  });
  if (data.project && data.project.id) studioProjectId = String(data.project.id);
  renderStudioScenes();
  updateStudioMeta();
  if (studioRedoActive()) updateStudioRedoUi();
}

/** 这些场需要重新翻译成动画：选了 manim（或自动）但还没有代码，或「画什么」被改过。 */
function scenesNeedFill() {
  return studioScenes.some((s) => {
    if (s.tool === 'text') return false;
    // AI 生成场：改过「画什么」(dirty) 或还没有英文 prompt，都要回 studio 重翻一次
    if (s.tool === 'aivideo') return Boolean(s.dirty) || !(s.video && String(s.video.prompt || '').trim());
    if (!(s.manim && s.manim.code)) return true;
    return Boolean(s.dirty);
  });
}

// ---- 输入框自动判断（三件事，用户不用选）----------------------------------

/**
 * 字数 + 换行 + 句号数量决定"这像什么"：
 *   超过 80 字，或者 3 行以上，或者又长又有好几个句号 → 稿子：先拆场
 *   其余（≤30 字的短句、一句话的题目）              → 题目：直接写分镜出片
 * 只用来决定请求体里放 prompt 还是 script，界面上不提"模式"。
 */
function classifyStudioInput(text) {
  const t = String(text || '').trim();
  const len = Array.from(t).length;
  if (!len) return '';
  const lines = t.split(/\r?\n/).filter((line) => line.trim()).length;
  const sentences = (t.match(/[。！？?!；;]/g) || []).length;
  if (len > 80) return 'script';
  if (lines >= 3) return 'script';
  if (len > 40 && sentences >= 2) return 'script';
  return 'prompt';
}

/** 卡片上那行标题：短句直接用，长稿子取第一句（最多 24 字）。 */
function studioTitleOfText(text, kind) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (kind !== 'script') return t.slice(0, 40);
  const first = t.split(/[。！？!?\n]/).map((s) => s.trim()).find(Boolean) || t;
  return first.slice(0, 24);
}

/** 输入框下面那行解释：只说"它打算怎么干"，不出现"模式"两个字。 */
function updateStudioHint() {
  if (!studioEls.hint) return;
  const text = studioEls.input ? studioEls.input.value.trim() : '';
  const usesScenes = studioScenes.length > 0 && (studioScenesTouched || (text && text === studioScenesFromText));
  const withRef = studioRefImage ? '（会带上参考图）' : '';
  if (usesScenes) {
    // 重做模式：这次要跑的是载入进来的分镜，输入框里写别的不会覆盖它
    if (studioRedoActive()) {
      setStudioHintText(`这次按高级区的 ${studioScenes.length} 场分镜跑；输入框里写别的不影响它。`);
      return;
    }
    setStudioHintText(`会用高级区里的分镜（${studioScenes.length} 场）${withRef}；想重新写就把输入框改一句再点。`);
    return;
  }
  if (!text) {
    setStudioHintText('一句话说题目就行；贴整段稿子也行，它自己看得出来。' + withRef);
    return;
  }
  setStudioHintText((classifyStudioInput(text) === 'script'
    ? '看着像一段稿子：先拆成分镜，再出片。'
    : '看着像个题目：它自己写分镜，然后出片。') + withRef);
}

// ---- 高级 / 历史 两个折叠区 -------------------------------------------------

function setStudioAdvanced(open) {
  studioAdvOpen = Boolean(open);
  if (studioEls.advBody) studioEls.advBody.classList.toggle('hidden', !studioAdvOpen);
  if (studioEls.advToggle) {
    studioEls.advToggle.setAttribute('aria-expanded', studioAdvOpen ? 'true' : 'false');
  }
}

function setStudioLibrary(open) {
  if (studioEls.libBody) studioEls.libBody.classList.toggle('hidden', !open);
  if (studioEls.libToggle) {
    studioEls.libToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

function setStudioBusy(on) {
  studioBusy = Boolean(on);
  const buttons = [studioEls.go, studioEls.fill, studioEls.sceneAdd];
  for (const el of buttons) if (el) el.disabled = studioBusy;
  document.body.classList.toggle('studio-busy', studioBusy);
  updateStudioRedoUi();
}

// ---- 重做模式（两步式：先载入分镜给人改，再跑）-----------------------------

function studioRedoActive() {
  return Boolean(studioRedoLibraryId || studioRedoRecipe);
}

/**
 * 重做模式的界面：顶部一行提示、表格上方「不改，直接重跑」、主按钮文案。
 * 只改界面，不碰分镜内容。
 */
function updateStudioRedoUi() {
  const active = studioRedoActive();
  if (studioEls.sceneRedoBar) studioEls.sceneRedoBar.classList.toggle('hidden', !active);
  if (studioEls.sceneRedoFrom) {
    studioEls.sceneRedoFrom.textContent = active ? `重做《${studioRedoTitle || '未命名'}》` : '';
  }
  if (studioEls.redoNote) {
    studioEls.redoNote.classList.toggle('hidden', !active);
    if (active) {
      // 末尾那句是给用户的约定：改了「画什么」才会重新生成动画，没改的场复用上次画面。
      studioEls.redoNote.textContent = (studioRedoChanged
        ? `已载入 ${studioScenes.length} 场分镜 · 改过了：点「按修改重做」就按你改的跑。`
        : `已载入 ${studioScenes.length} 场分镜，改完点「开始做」就按你改的跑。`)
        + '改了「画什么」的场会重新生成动画，其它场复用上次的画面。';
    }
  }
  if (studioEls.go) {
    studioEls.go.textContent = active && studioRedoChanged ? '按修改重做' : '开始做';
  }
  if (studioEls.sceneRedoRun) studioEls.sceneRedoRun.disabled = !active || studioBusy;
}

/** 进入重做模式：记下来源（历史 id 或浏览器配方），界面切成可改的状态。 */
function enterStudioRedo(info) {
  studioRedoLibraryId = String((info && info.libraryId) || '');
  studioRedoRecipe = (info && info.recipe) || null;
  studioRedoTitle = String((info && info.title) || studioTitle || '');
  studioRedoChanged = false;
  updateStudioRedoUi();
}

/** 退出重做模式：提交出去之后就不再是"正在重做"。 */
function exitStudioRedo() {
  if (!studioRedoActive()) return;
  studioRedoLibraryId = '';
  studioRedoRecipe = null;
  studioRedoTitle = '';
  studioRedoChanged = false;
  updateStudioRedoUi();
}

/** 改了任一场：主按钮从「开始做」变成「按修改重做」，提示条也跟着变。 */
function markStudioRedoChanged() {
  if (!studioRedoActive() || studioRedoChanged) return;
  studioRedoChanged = true;
  updateStudioRedoUi();
}

/**
 * 点了「重做」是想改东西：展开高级区 + 分镜表格，再滚到表格。
 * 绝不在这里自动开始渲染。
 */
function revealStudioScenes() {
  setStudioAdvanced(true);
  if (studioEls.scenesBox) studioEls.scenesBox.open = true;
  const scroll = () => {
    if (!studioEls.scenesBox || typeof studioEls.scenesBox.scrollIntoView !== 'function') return;
    studioEls.scenesBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.setTimeout(scroll, 80)));
  } else {
    scroll();
  }
}

// ---- 任务卡：排队 / 进行 / 完成 / 失败 -------------------------------------

function studioJobsRunning() {
  return [...studioJobs.values()].filter((job) => job.status !== 'done' && job.status !== 'failed');
}

/** 任务卡右上角那句话。 */
function studioJobStateText(job) {
  const status = String(job.status || '');
  if (status === 'done') return '✓ 完成';
  if (status === 'failed') return '✗ 失败';
  if (status === 'queued') {
    const pos = Number(job.queuePosition) || 0;
    return pos > 0 ? `排队中（前面 ${pos} 个）` : '排队中';
  }
  const total = Number(job.total) || 0;
  const done = Number(job.done) || 0;
  const label = String(job.label || job.phase || '渲染中');
  return total > 0 ? `${label} ${done}/${total}` : label;
}

/** 成片地址：走面板转发（<video>/下载都带不了 Bearer，job id 就是凭据）。
 *  老流程自己知道成片 id，所以用 videoPath 直接指过去。 */
function studioJobVideoUrl(job) {
  if (job && job.videoPath) return job.videoPath;
  return `/api/studio/jobs/${encodeURIComponent(job.id)}/video`;
}

/** 卡片要不要重建：只认会影响显示的那几个字段，免得每 2 秒把 <video> 重建一次。 */
function studioJobSignature(job) {
  const terminal = job.status === 'done' || job.status === 'failed';
  return [
    String(job.status || ''),
    String(job.label || ''),
    Number(job.done) || 0,
    Number(job.total) || 0,
    Number(terminal ? (job.ms || job.elapsedMs) : job.elapsedMs) || 0,
    Number(job.bytes) || 0,
    Number(job.queuePosition) || 0,
    String(job.error || ''),
    (job.warnings || []).join('|'),
    String(job.title || ''),
    String(job.seconds || ''),
    job.hasVideo ? '1' : '0',
    // 历史拉回来之后「重做」才可能出现：这个也要进签名，否则卡片不会重建
    job.canRerun ? '1' : '0',
  ].join('\u0001');
}

function studioActionButton(act, text, extraClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `job-btn ${extraClass}` : 'job-btn';
  btn.dataset.act = act;
  btn.textContent = text;
  return btn;
}

/** 造一张任务卡：四种状态共用一套结构，只是显示的东西不同。 */
function buildStudioJobCard(job) {
  const status = String(job.status || 'queued');
  const card = document.createElement('article');
  card.className = `job job-${status}`;
  card.dataset.jobId = job.id;

  const head = document.createElement('div');
  head.className = 'job-head';
  const dot = document.createElement('span');
  dot.className = 'job-dot';
  dot.textContent = status === 'done' ? '✓' : (status === 'failed' ? '✗' : '●');
  const title = document.createElement('span');
  title.className = 'job-title';
  title.textContent = job.title || '（没写标题）';
  const state = document.createElement('span');
  state.className = 'job-state';
  state.textContent = studioJobStateText(job);
  head.append(dot, title);
  if (status === 'done' && job.seconds) {
    const dur = document.createElement('span');
    dur.className = 'job-dur';
    dur.textContent = `${Math.round(Number(job.seconds))} 秒`;
    head.append(dur);
  }
  head.append(state);
  card.append(head);

  // 进行中：已用 X 分 Y 秒（用服务端给的 elapsedMs，不自己数秒）
  if (status !== 'done' && status !== 'failed') {
    const sub = document.createElement('p');
    sub.className = 'job-sub';
    sub.textContent = job.elapsedMs ? `已用 ${studioFmtSpan(job.elapsedMs)}` : '已经开工，等它回话…';
    card.append(sub);
  }

  // 失败：一句能行动的失败原因
  if (status === 'failed') {
    const why = document.createElement('p');
    why.className = 'job-error';
    why.textContent = '原因：' + studioJobErrorText(job);
    card.append(why);
  }

  // 完成：播放 / 下载 / 耗时 / 体积 / 警告
  if (status === 'done') {
    const actions = document.createElement('div');
    actions.className = 'job-actions';
    const play = studioActionButton('play', '播放');
    const download = document.createElement('a');
    download.className = 'job-btn';
    download.dataset.act = 'download';
    const url = studioJobVideoUrl(job);
    download.href = url;
    download.setAttribute('download', `studio-${job.id}.mp4`);
    download.textContent = '下载';
    actions.append(play, download);

    const meta = document.createElement('span');
    meta.className = 'job-meta';
    const bits = [];
    if (job.ms) bits.push(`耗时 ${studioFmtSpan(job.ms)}`);
    const mb = studioFmtMB(job.bytes);
    if (mb) bits.push(`${mb} MB`);
    meta.textContent = bits.join(' · ');
    actions.append(meta);

    if (job.canRerun) actions.append(studioActionButton('rerun', '重做'));
    card.append(actions);

    if (Array.isArray(job.warnings) && job.warnings.length) {
      const warn = document.createElement('p');
      warn.className = 'job-warn';
      warn.textContent = job.warnings.join('；');
      card.append(warn);
    }
  }

  if (status === 'failed' && job.canRerun) {
    const actions = document.createElement('div');
    actions.className = 'job-actions';
    actions.append(studioActionButton('rerun', '重做'));
    card.append(actions);
  }

  return card;
}

/** 增量更新任务列表：签名没变就只挪位置，已经展开的 <video> 不会被重建。 */
function renderStudioJobs() {
  const box = studioEls.jobs;
  if (!box) return;
  const ids = [...studioJobs.keys()].sort((a, b) => {
    const ja = studioJobs.get(a);
    const jb = studioJobs.get(b);
    return (Number(jb.createdAt) || 0) - (Number(ja.createdAt) || 0);
  });
  for (const [id, card] of studioJobCards) {
    if (!studioJobs.has(id)) {
      card.el.remove();
      studioJobCards.delete(id);
    }
  }
  for (const id of ids) {
    const job = studioJobs.get(id);
    job.canRerun = Boolean(studioLibraryIdForJob(job) || studioRecipe(id));
    const sig = studioJobSignature(job);
    const had = studioJobCards.get(id);
    if (had && had.sig === sig) continue;
    const el = buildStudioJobCard(job);
    if (had) had.el.replaceWith(el);
    studioJobCards.set(id, { el, sig });
  }
  // 新的排在最上面：append 已有节点等于"挪过去"，不会重载视频
  for (const id of ids) {
    const card = studioJobCards.get(id);
    if (card) box.append(card.el);
  }
  if (studioEls.jobsEmpty) studioEls.jobsEmpty.classList.toggle('hidden', ids.length > 0);
}

/** 把详情合进卡片状态。看到终态就顺手刷新历史，让「重做」有配方可用。 */
function applyStudioJobDetail(jobId, detail) {
  const job = studioJobs.get(jobId);
  if (!job || !detail || typeof detail !== 'object') return false;
  const before = studioJobSignature(job);
  const status = String(detail.status || '').toLowerCase();
  if (status) job.status = status;
  if (detail.label != null) job.label = String(detail.label);
  if (detail.phase != null) job.phase = String(detail.phase);
  if (Number.isFinite(Number(detail.done))) job.done = Number(detail.done);
  if (Number.isFinite(Number(detail.total))) job.total = Number(detail.total);
  if (Number.isFinite(Number(detail.elapsedMs))) {
    job.elapsedMs = Number(detail.elapsedMs);
  } else if (job.status !== 'done' && job.status !== 'failed') {
    // 服务端没给已用时间就自己按提交时刻算：卡片上的「已用 1 分 12 秒」不能一直空着
    const since = Number(job.startedAt) || Number(job.createdAt) || Date.now();
    job.elapsedMs = Math.max(job.elapsedMs, Date.now() - since);
  }
  if (Number.isFinite(Number(detail.ms)) && Number(detail.ms) > 0) job.ms = Number(detail.ms);
  if (Number.isFinite(Number(detail.bytes))) job.bytes = Number(detail.bytes);
  if (Number.isFinite(Number(detail.queuePosition))) job.queuePosition = Number(detail.queuePosition);
  if (detail.videoUrl) job.videoUrl = String(detail.videoUrl);
  if (detail.error) job.error = String(detail.error);
  if (Array.isArray(detail.warnings)) job.warnings = detail.warnings.map(String);
  if (detail.title && !job.title) job.title = String(detail.title);
  if (Number(detail.seconds) > 0) job.seconds = Number(detail.seconds);
  if (job.status === 'done') {
    job.hasVideo = Boolean(job.videoUrl || job.ms || job.bytes) || job.hasVideo;
    if (!job.elapsedMs) job.elapsedMs = job.ms;
  }
  if ((job.status === 'done' || job.status === 'failed') && !job._libraryRefreshed) {
    job._libraryRefreshed = true;
    loadStudioLibrary();
  }
  return studioJobSignature(job) !== before;
}

/** 新建或更新一条任务卡。返回任务对象。 */
function adoptStudioJob(jobId, meta) {
  const id = String(jobId || '').trim();
  if (!id) return null;
  const prev = studioJobs.get(id) || {};
  const job = Object.assign({
    id,
    title: '',
    status: 'queued',
    phase: '',
    label: '排队中',
    done: 0,
    total: 0,
    elapsedMs: 0,
    ms: 0,
    bytes: 0,
    videoUrl: '',
    warnings: [],
    error: '',
    queuePosition: 0,
    createdAt: Date.now(),
    seconds: 0,
  }, prev, meta || {});
  job.title = String(job.title || '').trim();
  studioJobs.set(id, job);
  renderStudioJobs();
  if (job.status !== 'done' && job.status !== 'failed') startStudioPoll();
  return job;
}

/** 只轮询还在跑的任务，2 秒一次；都结束了就停表。 */
function startStudioPoll() {
  if (studioPollTimer) return;
  studioPollTimer = setInterval(pollStudioJobs, 2000);
}

function stopStudioPoll() {
  if (studioPollTimer) {
    clearInterval(studioPollTimer);
    studioPollTimer = null;
  }
}

async function pollStudioJobs() {
  const running = studioJobsRunning().filter((job) => !String(job.id).startsWith('local-'));
  if (!running.length) {
    stopStudioPoll();
    return;
  }
  if (studioPollBusy) return;
  studioPollBusy = true;
  let changed = false;
  try {
    await Promise.all(running.map(async (job) => {
      const r = await studioRequest(`/api/studio/jobs/${encodeURIComponent(job.id)}`, null, 'GET');
      if (!studioOk(r.status) || !r.data) return;
      if (applyStudioJobDetail(job.id, r.data.job || r.data)) changed = true;
    }));
  } catch (err) {
    /* 轮询是旁路：抖一下就跳过这一轮，别打断已经在跑的任务 */
  } finally {
    studioPollBusy = false;
  }
  if (changed) renderStudioJobs();
  if (!studioJobsRunning().filter((job) => !String(job.id).startsWith('local-')).length) stopStudioPoll();
}

// ---- 浏览器本地记住"任务是怎么做出来的"（刷新后重做要用）------------------

const STUDIO_RECIPES_KEY = 'dsh-studio-recipes';
const STUDIO_RECIPES_MAX = 20;

function readStudioRecipes() {
  try {
    const list = JSON.parse(window.localStorage.getItem(STUDIO_RECIPES_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function writeStudioRecipes(list) {
  try {
    window.localStorage.setItem(STUDIO_RECIPES_KEY, JSON.stringify(list.slice(0, STUDIO_RECIPES_MAX)));
  } catch (err) {
    /* 存不下就算了：任务本身在服务端，重做还有历史那条路 */
  }
}

function rememberStudioRecipe(jobId, recipe) {
  if (!jobId) return;
  const list = readStudioRecipes().filter((it) => it && it.id !== jobId);
  list.unshift(Object.assign({ id: jobId, at: Date.now() }, recipe || {}));
  writeStudioRecipes(list);
}

function studioRecipe(jobId) {
  return readStudioRecipes().find((it) => it && it.id === jobId) || null;
}

/** 存起来的配方只要重做要用的字段，不带 manim 代码（重做本来就会重新生成）。 */
function slimStudioPayload(payload) {
  const out = {
    seconds: Number(payload && payload.seconds) || 60,
    style: (payload && payload.style) || '',
    voice: (payload && payload.voice) || '',
  };
  if (payload && payload.prompt) out.prompt = String(payload.prompt).slice(0, 4000);
  if (payload && payload.script) out.script = String(payload.script).slice(0, 20000);
  if (payload && payload.image) out.image = String(payload.image);
  if (payload && Array.isArray(payload.scenes)) {
    out.scenes = payload.scenes.map((s) => {
      const one = {
        text: String((s && s.text) || ''),
        narration: String((s && s.narration) || ''),
        seconds: Number(s && s.seconds) || 5,
        visual_hint: String((s && s.visual_hint) || ''),
        tool: String((s && s.tool) || ''),
      };
      if (s && s.image) one.image = String(s.image);
      return one;
    });
  }
  return out;
}

// ---- 历史（library）：重做（先载入分镜再改）/ 删除 -------------------------

/** 任务卡和历史条目怎么对上：有 id 用 id，没有就按标题 + 时间就近认一条。 */
function studioLibraryIdForJob(job) {
  if (!job || !studioLibrary.length) return '';
  const wanted = String(job.libraryId || job.itemId || job.id || '');
  const byId = studioLibrary.find((it) => it && String(it.id) === wanted);
  if (byId) return String(byId.id);
  const title = String(job.title || '').trim();
  if (!title) return '';
  const at = Number(job.createdAt) || 0;
  let best = null;
  let bestGap = Infinity;
  for (const it of studioLibrary) {
    if (!it || String(it.title || '').trim() !== title) continue;
    const gap = at ? Math.abs((studioTimeOf(it.createdAt) || 0) - at) : 0;
    if (at && gap > 30 * 60 * 1000) continue;
    if (gap < bestGap) {
      best = it;
      bestGap = gap;
    }
  }
  return best ? String(best.id) : '';
}

async function loadStudioLibrary() {
  const r = await studioRequest('/api/studio/library', null, 'GET');
  if (r.status === 404) {
    // 老 studio 没有历史接口：不报错，安静地空着（重做还有本地配方那条路）
    studioLibrary = [];
    renderStudioLibrary();
    return;
  }
  if (!studioOk(r.status) || !r.data || !r.data.ok) {
    studioLibrary = [];
    renderStudioLibrary('历史暂时读不到（studio 没回话）。');
    return;
  }
  const items = Array.isArray(r.data.items) ? r.data.items : (Array.isArray(r.data.jobs) ? r.data.jobs : []);
  studioLibrary = items.slice(0, 50);
  renderStudioLibrary();
  renderStudioJobs();
}

function libActionButton(act, text, extraClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `lib-btn ${extraClass}` : 'lib-btn';
  btn.dataset.act = act;
  btn.textContent = text;
  return btn;
}

function renderStudioLibrary(note) {
  const list = studioEls.libList;
  if (!list) return;
  list.textContent = '';
  if (studioEls.libEmpty) {
    studioEls.libEmpty.textContent = note || '还没有存过的分镜。';
    studioEls.libEmpty.classList.toggle('hidden', studioLibrary.length > 0);
  }
  for (const item of studioLibrary.slice(0, 50)) {
    const li = document.createElement('li');
    li.className = 'lib-item';
    li.dataset.libId = String(item && item.id ? item.id : '');

    const row = document.createElement('div');
    row.className = 'lib-row';

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'lib-title';
    title.dataset.act = 'open';
    title.title = '点一下看分镜（只读）';
    title.textContent = String((item && item.title) || '未命名');

    const meta = document.createElement('span');
    meta.className = 'lib-meta';
    const bits = [];
    if (Number(item && item.sceneCount) > 0) bits.push(`${Number(item.sceneCount)} 场`);
    if (Number(item && item.seconds) > 0) bits.push(`${Math.round(Number(item.seconds))} 秒`);
    const when = studioFmtWhen(item && item.createdAt);
    if (when) bits.push(when);
    if (item && item.status === 'failed') bits.push('上次没做成');
    meta.textContent = bits.join(' · ');

    const ops = document.createElement('span');
    ops.className = 'lib-ops';
    ops.append(libActionButton('rerun', '重做'), libActionButton('del', '删除', 'danger'));
    row.append(title, meta, ops);
    li.append(row);

    const detail = document.createElement('div');
    detail.className = 'lib-detail hidden';
    li.append(detail);
    list.append(li);
  }
}

/** 点标题：展开/收起这一条的分镜（只读）。 */
async function toggleStudioLibItem(li, id) {
  const detail = li.querySelector('.lib-detail');
  if (!detail) return;
  if (!detail.classList.contains('hidden')) {
    detail.classList.add('hidden');
    detail.textContent = '';
    return;
  }
  detail.classList.remove('hidden');
  detail.textContent = '读取中…';
  const r = await studioRequest(`/api/studio/library/${encodeURIComponent(id)}`, null, 'GET');
  if (!studioOk(r.status) || !r.data || !r.data.ok || !r.data.item) {
    detail.textContent = '读不到这条（可能已经删了）。';
    return;
  }
  const item = r.data.item;
  const scenes = Array.isArray(item.scenes) ? item.scenes : [];
  detail.textContent = '';
  if (!scenes.length) {
    detail.textContent = '这一条没有分镜。';
    return;
  }
  scenes.forEach((scene, index) => {
    const p = document.createElement('p');
    p.className = 'lib-scene';
    const head = document.createElement('b');
    head.textContent = `${index + 1}. `;
    p.append(head, document.createTextNode(
      `${String((scene && scene.text) || '（没标题）')} · ${studioSceneSeconds(scene)} 秒`,
    ));
    if (scene && scene.narration) {
      const line = document.createElement('span');
      line.className = 'lib-scene-line';
      line.textContent = `旁白：${scene.narration}`;
      p.append(line);
    }
    if (scene && scene.visual_hint) {
      const line = document.createElement('span');
      line.className = 'lib-scene-line';
      line.textContent = `画什么：${scene.visual_hint}`;
      p.append(line);
    }
    detail.append(p);
  });
}

/** 「不改，直接重跑」：让 studio 用历史里保存的配方原样再跑一遍，生成一张新任务卡。 */
async function rerunStudioLibrary(id) {
  if (studioBusy) return;
  setStudioBusy(true);
  setStudioStartError('');
  try {
    const r = await studioRequest(`/api/studio/library/${encodeURIComponent(id)}/rerun`, {}, 'POST');
    if (studioOk(r.status) && r.data && r.data.ok && r.data.jobId) {
      const found = studioLibrary.find((it) => String(it.id) === String(id));
      adoptStudioJob(r.data.jobId, {
        title: (found && found.title) || '重做',
        seconds: Number(found && found.seconds) || 0,
        status: 'queued',
        createdAt: Date.now(),
      });
      setStudioHintText('已经按原样重跑了一份，新任务在最上面。');
      return;
    }
    setStudioStartError('重跑没成功：' + ((r.data && (r.data.error || r.data.message)) || `HTTP ${r.status}`));
  } catch (err) {
    setStudioStartError('重跑失败：' + ((err && err.message) || err));
  } finally {
    setStudioBusy(false);
  }
}

/**
 * 把历史里的分镜放回高级区表格（两步式重做的第一步）。
 *  - {redo:true}：从「重做」进来 —— 进入重做模式、展开并滚到表格，不自动开跑
 *  - 缺省：只载入（给别的入口复用）
 * 输入框里已经有别的主题就不覆盖：这次要跑的是表格里的分镜。
 */
async function loadStudioLibraryItem(id, options) {
  if (studioLibBusy) return;
  studioLibBusy = true;
  const redo = Boolean(options && options.redo);
  setStudioStartError('');
  try {
    const r = await studioRequest(`/api/studio/library/${encodeURIComponent(id)}`, null, 'GET');
    if (!studioOk(r.status) || !r.data || !r.data.ok || !r.data.item) {
      setStudioStartError('这条历史读不到（可能已经删了）。');
      return;
    }
    const item = r.data.item;
    const request = item.request || {};
    const scenes = Array.isArray(item.scenes) ? item.scenes : [];
    if (!scenes.length) {
      setStudioStartError('这条历史没有分镜，没法载入。');
      return;
    }
    studioTitle = String(item.title || request.title || '').slice(0, 60);
    // 记下原项目 id：重做提交时带回 studio，才会复用同一份项目缓存
    // （片段/旁白/拼接都命中），只重渲真正改过的那一场。
    if (item.projectId) studioProjectId = String(item.projectId);
    adoptStudioScenes({ title: studioTitle, scenes });
    studioScenesTouched = true;
    studioScenesFromText = studioEls.input ? studioEls.input.value.trim() : '';
    if (studioEls.input && !studioEls.input.value.trim()) studioEls.input.value = studioTitle;
    const seconds = Number(request.seconds || item.seconds);
    if (studioEls.seconds && seconds > 0) studioEls.seconds.value = String(seconds);
    if (request.style) setStudioSelectValue(studioEls.style, request.style);
    if (request.voice) setStudioSelectValue(studioEls.voice, request.voice);
    if (redo) enterStudioRedo({ libraryId: String(item.id || id), title: studioTitle });
    updateStudioHint();
    setStudioSceneHint(`已载入《${studioTitle || '未命名'}》的 ${scenes.length} 场：改完回上面点「开始做」，就用这份分镜。`);
    if (redo) {
      // 用户点「重做」是想改东西：把表格摆到眼前，但不自动开始
      revealStudioScenes();
    }
  } catch (err) {
    setStudioStartError('载入失败：' + ((err && err.message) || err));
  } finally {
    studioLibBusy = false;
  }
}

/** 「重做」（两步式）：先把分镜载入表格给用户改，绝不自动开跑。 */
async function redoStudioLibrary(id) {
  return loadStudioLibraryItem(id, { redo: true });
}

/**
 * 没有历史条目时的重做：用浏览器存的配方把分镜放回表格。
 * 当时若是一句话/稿子直接做的，就没有分镜可改 —— 把原话放回输入框，让用户改一句。
 */
function redoStudioFromRecipe(recipe) {
  const payload = (recipe && recipe.payload) || null;
  if (!payload) return false;
  const scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  if (!scenes.length) {
    const text = String(payload.prompt || payload.script || '');
    const hasText = Boolean(studioEls.input && studioEls.input.value.trim());
    // 输入框里有别的主题就不动它
    if (studioEls.input && text && !hasText) studioEls.input.value = text;
    if (studioEls.seconds && Number(payload.seconds) > 0) studioEls.seconds.value = String(payload.seconds);
    if (payload.style) setStudioSelectValue(studioEls.style, payload.style);
    if (payload.voice) setStudioSelectValue(studioEls.voice, payload.voice);
    updateStudioHint();
    setStudioHintText(hasText
      ? '这条任务当时是直接按文字做的，没留分镜；输入框里已有别的主题，就没覆盖它。'
      : '这条任务当时是直接按文字做的，没留分镜；原话已经填回输入框，改一句再点「开始做」。');
    return false;
  }
  studioTitle = String(recipe.title || studioTitle || '').slice(0, 60);
  // 浏览器配方里没有 projectId：别把上一次载入的项目 id 用到这一份分镜上
  studioProjectId = '';
  adoptStudioScenes({ title: studioTitle, scenes });
  studioScenesTouched = true;
  studioScenesFromText = studioEls.input ? studioEls.input.value.trim() : '';
  if (studioEls.input && !studioEls.input.value.trim()) studioEls.input.value = studioTitle;
  if (studioEls.seconds && Number(payload.seconds) > 0) studioEls.seconds.value = String(payload.seconds);
  if (payload.style) setStudioSelectValue(studioEls.style, payload.style);
  if (payload.voice) setStudioSelectValue(studioEls.voice, payload.voice);
  enterStudioRedo({ recipe: payload, title: studioTitle });
  updateStudioHint();
  setStudioSceneHint(`已载入 ${scenes.length} 场分镜：改完回上面点「开始做」，就用你改过的分镜。`);
  revealStudioScenes();
  return true;
}

/** 「重做」任务卡（两步式）：优先用 studio 历史里那条分镜，其次浏览器存的配方。 */
async function redoStudioJob(job) {
  if (!job || studioBusy || studioLibBusy) return;
  setStudioStartError('');
  const libId = studioLibraryIdForJob(job);
  if (libId) return loadStudioLibraryItem(libId, { redo: true });
  const recipe = studioRecipe(job.id);
  if (recipe && recipe.payload) {
    redoStudioFromRecipe(recipe);
    return;
  }
  setStudioStartError('这条任务没留下分镜：用上面的输入框再写一次，或者从历史里重做。');
}

/** 「不改，直接重跑」：按进入重做时记下的来源原样跑，表格里的修改都不算。 */
async function rerunStudioRedoSource() {
  if (studioBusy) return;
  if (studioRedoLibraryId) return rerunStudioLibrary(studioRedoLibraryId);
  if (studioRedoRecipe) return submitStudioJob(studioRedoRecipe, studioRedoTitle || '重做');
  setStudioStartError('没有可原样重跑的做法：改完点「开始做」就行。');
}

/** 删除历史里的这一条（成片不动，生成的 mp4 照样能下载）。 */
async function deleteStudioLibraryItem(id) {
  setStudioStartError('');
  try {
    const r = await studioRequest(`/api/studio/library/${encodeURIComponent(id)}`, null, 'DELETE');
    if (studioOk(r.status) && r.data && r.data.ok) {
      studioLibrary = studioLibrary.filter((it) => String(it.id) !== String(id));
      renderStudioLibrary();
      renderStudioJobs();
      return;
    }
    setStudioStartError('删除没成功：' + ((r.data && (r.data.error || r.data.message)) || `HTTP ${r.status}`));
  } catch (err) {
    setStudioStartError('删除失败：' + ((err && err.message) || err));
  }
}

/** 历史区的点击：展开 / 重做（载入分镜再改）/ 删除（删除要点两下，免得误删）。 */
async function onStudioLibClick(event) {
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('.lib-item');
  const id = li ? li.dataset.libId : '';
  if (!id) return;
  const act = btn.dataset.act;
  if (act === 'open') return toggleStudioLibItem(li, id);
  if (act === 'rerun') return redoStudioLibrary(id);
  if (act === 'del') {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = '确认删?';
      window.setTimeout(() => {
        btn.dataset.confirm = '';
        btn.textContent = '删除';
      }, 4000);
      return;
    }
    return deleteStudioLibraryItem(id);
  }
}

// ---- 提交：一个入口干三种事 ------------------------------------------------

/** 「开始做」的请求体：分镜改过就用分镜，否则按字数判断是题目还是稿子。 */
function studioBuildPayload() {
  const text = studioEls.input ? studioEls.input.value.trim() : '';
  const seconds = Number(studioEls.seconds && studioEls.seconds.value) || 60;
  const style = studioEls.style ? studioEls.style.value : '';
  const voice = studioEls.voice ? studioEls.voice.value : '';
  // 首屏那张参考图：有分镜就挂到第一场（那一场自己已经有图就不动），
  // 同时留一份在请求体顶层 —— 题目/稿子没有 scenes 可挂，后端认哪个都能用上。
  const refImage = studioRefImage && studioRefImage.uploadId ? String(studioRefImage.uploadId) : '';
  const usesScenes = studioScenes.length > 0 && (studioScenesTouched || (text && text === studioScenesFromText));
  if (usesScenes) {
    const scenes = studioPlanFromScenes().scenes;
    if (refImage && scenes.length && !scenes[0].image) scenes[0].image = refImage;
    const payload = { scenes, seconds, style, voice };
    // 重做：带上原项目 id。studio 靠它复用同一份项目缓存（片段/旁白/拼接），
    // 只重渲真正变了的那一场；不带就是新项目、缓存为空、全部重渲。
    if (studioRedoActive() && studioProjectId) payload.projectId = String(studioProjectId);
    if (refImage) payload.image = refImage;
    return { payload, title: studioTitle || text, kind: 'scenes' };
  }
  if (!text && !refImage) return { payload: null, title: '', kind: '' };
  const kind = classifyStudioInput(text);
  const title = studioTitleOfText(text, kind);
  const payload = kind === 'script'
    ? { script: text, seconds, style, voice }
    : { prompt: text, seconds, style, voice };
  if (refImage) payload.image = refImage;
  return { payload, title, kind };
}

async function studioStart() {
  if (studioBusy) return;
  const built = studioBuildPayload();
  if (!built.payload) {
    setStudioStartError('先写一句要做什么，再点「开始做」。');
    if (studioEls.input) studioEls.input.focus();
    return;
  }
  await submitStudioJob(built.payload, built.title);
}

/** 这次提交里有没有「AI 视频」场：有就先提醒额度用完了（会降级成文字卡）。 */
function studioPayloadHasAiVideo(payload) {
  if (!payload || !Array.isArray(payload.scenes)) return false;
  return payload.scenes.some((s) => s && (s.tool === 'aivideo' || s.kind === 'aivideo'));
}

/** 提交：先把任务卡放上去（看着有反应），再等接口回 jobId。 */
async function submitStudioJob(payload, title) {
  if (studioBusy) return null;
  setStudioBusy(true);
  setStudioStartError('');
  try {
    const r = await studioRequest('/api/studio/jobs', payload, 'POST');
    if (studioOk(r.status) && r.data && r.data.ok && r.data.jobId) {
      const job = adoptStudioJob(r.data.jobId, {
        title: title || '未命名',
        seconds: Number(payload.seconds) || 0,
        status: 'queued',
        createdAt: Date.now(),
      });
      rememberStudioRecipe(r.data.jobId, {
        title: title || '未命名',
        seconds: Number(payload.seconds) || 0,
        payload: slimStudioPayload(payload),
      });
      setStudioHintText('开工了。下面那张卡会自己更新，不用守在这儿。'
        + (studioPayloadHasAiVideo(payload) ? ' 注意：AI 视频额度已用完，标了 AI 画面的场会降级成文字卡。' : ''));
      if (studioEls.startError) studioEls.startError.classList.add('hidden');
      // 已经提交出去了：重做模式到此结束，主按钮回到「开始做」
      exitStudioRedo();
      return job;
    }
    // studio 还没这套接口 → 回退老流程（拆分镜 → 补动画 → 建项目 → 渲染），不白屏
    if (r.status === 404 || r.status === 501
      || (r.data && (r.data.error === 'JOBS_UNAVAILABLE' || r.data.code === 'JOBS_UNAVAILABLE'))) {
      return legacyStudioRun(payload, title);
    }
    // 其它失败：也放一张失败卡，让人看得见原因，而不是什么都没发生
    return adoptStudioJob(`local-${Date.now().toString(36)}`, {
      title: title || '未命名',
      seconds: Number(payload.seconds) || 0,
      status: 'failed',
      createdAt: Date.now(),
      error: (r.data && (r.data.error || r.data.message)) || `面板回了 HTTP ${r.status}`,
    });
  } catch (err) {
    setStudioStartError('提交失败：' + ((err && err.message) || err));
    return null;
  } finally {
    setStudioBusy(false);
  }
}

/** 卡片的点击：播放 / 下载 / 重做（重做走两步式：先载入分镜给人改）。 */
async function onStudioJobClick(event) {
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.job');
  const job = card ? studioJobs.get(card.dataset.jobId) : null;
  if (!job) return;
  const act = btn.dataset.act;
  if (act === 'rerun') return redoStudioJob(job);
  if (act === 'play') {
    let video = card.querySelector('.job-video');
    if (!video) {
      video = document.createElement('video');
      video.className = 'job-video';
      video.controls = true;
      video.preload = 'metadata';
      card.append(video);
    }
    const url = studioJobVideoUrl(job);
    if (video.getAttribute('src') !== url) video.src = url;
    video.classList.remove('hidden');
    const played = video.play();
    if (played && played.catch) played.catch(() => { /* 自动播放被挡：控件还在，用户自己点 */ });
  }
}

// ---- 老流程（studio 没有 /v1/jobs 时的回退）--------------------------------

function stopLegacyProgress() {
  if (legacyProgressTimer) {
    clearInterval(legacyProgressTimer);
    legacyProgressTimer = null;
  }
}

/** 老流程的进度只有"第几场"，照样写进卡片，让用户看着是同一回事。 */
function startLegacyProgress(jobId, projectId) {
  stopLegacyProgress();
  legacyProgressTimer = setInterval(async () => {
    try {
      const res = await apiFetch(`/api/studio/progress?id=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;
      const p = await res.json().catch(() => null);
      const job = studioJobs.get(jobId);
      if (!job || !p || !p.ok || p.status === 'idle') return;
      if (p.status === 'running') {
        job.label = p.label || '渲染中';
        job.done = Number(p.done) || 0;
        job.total = Number(p.total) || 0;
        job.elapsedMs = Number(p.elapsedMs) || job.elapsedMs;
      }
      renderStudioJobs();
    } catch (err) {
      /* 进度是旁路信息 */
    }
  }, 2000);
}

/**
 * 回退流程：拆分镜 → 补动画 → 建项目 → 渲染。
 * 卡片照样先出现、照样更新，所以用户看着和正常任务一样（只是没有那么细的阶段）。
 */
async function legacyStudioRun(payload, title) {
  const jobId = `local-${Date.now().toString(36)}`;
  adoptStudioJob(jobId, {
    title: title || '未命名',
    seconds: Number(payload.seconds) || 60,
    status: 'running',
    label: '写分镜',
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
  const patch = (fields) => {
    const job = studioJobs.get(jobId);
    if (!job) return;
    Object.assign(job, fields);
    if (!job.elapsedMs || fields.status === 'failed' || fields.status === 'done') {
      job.elapsedMs = Date.now() - (Number(job.startedAt) || Date.now());
    }
    renderStudioJobs();
  };
  const fail = (reason) => patch({ status: 'failed', error: String(reason || '未知原因'), canRerun: Boolean(studioRecipe(jobId)) });
  const seconds = Number(payload.seconds) || 60;
  const style = payload.style || '';
  const voice = payload.voice || '';
  try {
    let scenes = Array.isArray(payload.scenes) && payload.scenes.length ? payload.scenes : null;
    let projectTitle = title || '';
    if (!scenes) {
      const r = payload.script
        ? await studioRequest('/api/studio/script', { script: payload.script, seconds, style, voice }, 'POST')
        : await studioRequest('/api/studio/plan', { prompt: payload.prompt, seconds, style, voice }, 'POST');
      if (!studioOk(r.status) || !r.data || !r.data.ok) return fail(studioErrorText(r.data || {}));
      adoptStudioScenes(r.data);
      projectTitle = studioTitle || projectTitle;
      scenes = studioPlanFromScenes().scenes;
    } else {
      adoptStudioScenes({ title: projectTitle, scenes });
    }
    if (scenesNeedFill()) {
      patch({ label: '生成动画' });
      const filled = await studioRequest('/api/studio/scenes', {
        title: projectTitle,
        projectId: studioProjectId,
        scenes,
        style,
        voice,
      }, 'POST');
      if (filled.status !== 200 || !filled.data || !filled.data.ok) return fail(studioErrorText(filled.data || {}));
      adoptStudioScenes(filled.data);
      scenes = studioPlanFromScenes().scenes;
    }
    patch({ label: '准备渲染' });
    const created = await studioRequest('/api/studio/project', {
      id: studioProjectId,
      title: projectTitle,
      scenes,
      style,
      voice,
    }, 'POST');
    if (created.status !== 200 || !created.data || !created.data.ok) return fail(studioErrorText(created.data || {}));
    if (created.data.project && created.data.project.id) studioProjectId = String(created.data.project.id);
    patch({ label: '渲染中' });
    startLegacyProgress(jobId, studioProjectId);
    const rendered = await studioRequest('/api/studio/project/render', {
      id: studioProjectId,
      scope: 'auto',
      style,
      voice,
    }, 'POST');
    stopLegacyProgress();
    if (rendered.status !== 200 || !rendered.data || !rendered.data.ok) return fail(studioErrorText(rendered.data || {}));
    const data = rendered.data;
    const videoId = String(data.jobId || data.renderId || data.id || '');
    patch({
      status: 'done',
      label: '完成',
      ms: Number(data.ms) || 0,
      bytes: Number(data.bytes) || 0,
      seconds: Number(data.seconds) || seconds,
      warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
      videoPath: videoId ? `/api/studio/video?id=${encodeURIComponent(videoId)}` : '',
      hasVideo: Boolean(videoId),
    });
    rememberStudioRecipe(jobId, { title: projectTitle, seconds, payload: slimStudioPayload(payload) });
    loadStudioLibrary();
    return studioJobs.get(jobId) || null;
  } catch (err) {
    stopLegacyProgress();
    return fail('出错：' + ((err && err.message) || err));
  }
}

/** 高级区专用：把每场的「画什么」翻译成动画代码（不渲染）。 */
async function studioFillScenes() {
  if (studioBusy) return;
  if (!studioScenes.length) {
    setStudioSceneHint('还没有分镜：先写一句点「开始做」，或者点「加一场」自己写。');
    return;
  }
  setStudioBusy(true);
  const manim = studioScenes.filter((s) => s.tool !== 'text').length;
  setStudioSceneHint(`正在生成动画代码：${manim} 场要画，可能要一两分钟…`);
  try {
    const r = await studioRequest('/api/studio/scenes', {
      title: studioTitle,
      projectId: studioProjectId,
      scenes: studioPlanFromScenes().scenes,
      style: studioEls.style ? studioEls.style.value : '',
      voice: studioEls.voice ? studioEls.voice.value : '',
    }, 'POST');
    if (!studioOk(r.status) || !r.data || !r.data.ok) {
      setStudioSceneHint('没做成：' + studioErrorText(r.data || {}));
      return;
    }
    adoptStudioScenes(r.data);
    studioScenesTouched = true;
    const stats = r.data.stats || {};
    setStudioSceneHint(
      `补全完成：动画 ${stats.manim || 0} 场 / 文字卡 ${stats.text || 0} 场`
      + (stats.fallback ? `（${stats.fallback} 场降级成文字卡）` : '') + '。回上面点「开始做」出片。',
    );
  } catch (err) {
    setStudioSceneHint('出错：' + ((err && err.message) || err));
  } finally {
    setStudioBusy(false);
  }
}

// ---- 进视频页时把状态补齐 --------------------------------------------------

/** 刷新后要恢复三样：任务卡、历史、人设绑定。 */
async function loadStudioView() {
  if (!studioOptionsLoaded) {
    try {
      await loadStudioBinding();
    } catch (err) {
      /* 人设读不到不影响做视频 */
    }
  }
  if (!studioScenes.length) updateStudioMeta();
  updateStudioHint();
  updateStudioRedoUi();
  renderStudioRefBox();
  await Promise.all([
    loadStudioJobs().catch(() => {}),
    loadStudioLibrary().catch(() => {}),
  ]);
}

/** 从服务端恢复任务列表（本地的配方只用来补标题和「重做」）。 */
async function loadStudioJobs() {
  const r = await studioRequest('/api/studio/jobs', null, 'GET');
  if (!studioOk(r.status) || !r.data || !r.data.ok) return; // 老 studio：没有就算了
  const list = Array.isArray(r.data.jobs) ? r.data.jobs : (Array.isArray(r.data.items) ? r.data.items : []);
  for (const raw of list.slice(0, 30)) {
    const id = String((raw && (raw.id || raw.jobId)) || '');
    if (!id) continue;
    const recipe = studioRecipe(id);
    adoptStudioJob(id, {
      title: String((raw && raw.title) || (recipe && recipe.title) || ''),
      status: String((raw && raw.status) || 'queued').toLowerCase(),
      label: raw && raw.label,
      done: raw && raw.done,
      total: raw && raw.total,
      elapsedMs: raw && raw.elapsedMs,
      ms: raw && raw.ms,
      bytes: raw && raw.bytes,
      videoUrl: raw && raw.videoUrl,
      warnings: raw && raw.warnings,
      error: raw && raw.error,
      queuePosition: raw && raw.queuePosition,
      seconds: Number((raw && raw.seconds) || (recipe && recipe.seconds) || 0),
      createdAt: studioTimeOf(raw && raw.createdAt) || (recipe && recipe.at) || Date.now(),
    });
  }
  renderStudioJobs();
  if (studioJobsRunning().length) startStudioPoll();
}

// ---- 绑定 ------------------------------------------------------------------

if (studioEls.go) studioEls.go.addEventListener('click', studioStart);
if (studioEls.input) {
  studioEls.input.addEventListener('input', () => {
    setStudioStartError('');
    updateStudioHint();
  });
  // Ctrl+Enter 直接开工：和聊天那边一个手感
  studioEls.input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      studioStart();
    }
  });
}
if (studioEls.seconds) studioEls.seconds.addEventListener('change', updateStudioHint);
if (studioEls.advToggle) studioEls.advToggle.addEventListener('click', () => setStudioAdvanced(!studioAdvOpen));
if (studioEls.libToggle) {
  studioEls.libToggle.addEventListener('click', () => {
    setStudioLibrary(studioEls.libBody ? studioEls.libBody.classList.contains('hidden') : true);
  });
}
if (studioEls.fill) studioEls.fill.addEventListener('click', studioFillScenes);
if (studioEls.sceneAdd) studioEls.sceneAdd.addEventListener('click', studioAddScene);
if (studioEls.sceneRedoRun) studioEls.sceneRedoRun.addEventListener('click', rerunStudioRedoSource);
if (studioEls.sceneList) {
  // 事件委托：行是动态生成的，绑一次就够。input 直接改数组，不重建 DOM。
  studioEls.sceneList.addEventListener('input', onStudioSceneEdit);
  studioEls.sceneList.addEventListener('change', onStudioSceneEdit);
  studioEls.sceneList.addEventListener('click', onStudioSceneImageClick);
  studioEls.sceneList.addEventListener('click', onStudioSceneStickerClick);
  studioEls.sceneList.addEventListener('click', studioDeleteScene);
  studioEls.sceneList.addEventListener('click', onStudioSceneInsert);
}
// 参考图：首屏那个小按钮和分镜行共用同一个 file input
if (studioEls.refBtn) studioEls.refBtn.addEventListener('click', () => pickStudioImage('ref'));
if (studioEls.refClear) studioEls.refClear.addEventListener('click', clearStudioRefImage);
if (studioEls.imageInput) studioEls.imageInput.addEventListener('change', onStudioImagePicked);
// 分镜表情选择器：关掉 / 点遮罩 / Esc / 搜索 / 全部-收藏
if (sceneStickerEls.close) sceneStickerEls.close.addEventListener('click', closeSceneStickerPicker);
if (sceneStickerEls.modal) {
  sceneStickerEls.modal.addEventListener('click', (event) => {
    if (event.target === sceneStickerEls.modal) closeSceneStickerPicker();
  });
}
document.addEventListener('keydown', (event) => {
  const open = sceneStickerEls.modal && !sceneStickerEls.modal.classList.contains('hidden');
  if (event.key === 'Escape' && open) closeSceneStickerPicker();
});
if (sceneStickerEls.search) {
  sceneStickerEls.search.addEventListener('input', () => {
    clearTimeout(sceneStickerTimer);
    sceneStickerTimer = setTimeout(() => loadSceneStickers(sceneStickerEls.search.value.trim()), 300);
  });
}
if (sceneStickerEls.tabAll) sceneStickerEls.tabAll.addEventListener('click', () => setSceneStickerTab(false));
if (sceneStickerEls.tabFav) sceneStickerEls.tabFav.addEventListener('click', () => setSceneStickerTab(true));
if (studioEls.jobs) studioEls.jobs.addEventListener('click', onStudioJobClick);
if (studioEls.libList) studioEls.libList.addEventListener('click', onStudioLibClick);



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
