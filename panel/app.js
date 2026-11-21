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
  inputEl.placeholder = locked ? '请先登录后再输入…' : '输入内容…';
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('读不到录音'));
    reader.readAsDataURL(blob);
  });
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
      const blob = new Blob(recordChunks, { type: recorder.mimeType || 'audio/webm' });
      recorder = null;
      try {
        const audioBase64 = await blobToBase64(blob);
        const r = await apiJson('/api/asr', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audioBase64, mime: blob.type || 'audio/webm' }),
        });
        if (r && r.ok && r.text) {
          inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + r.text;
          autoGrow();
          inputEl.focus();
          micBtn.title = `识别用时 ${r.ms || '?'}ms`;
        } else {
          micBtn.title = '没听清：' + ((r && r.error) || '未知');
        }
      } catch (err) {
        micBtn.title = '听写出错：' + (err && err.message || err);
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

/** 按"多条消息"渲染；只有最后一条挂朗读按钮，读的是整段。 */
async function addReplySeries(text, meta, options = {}) {
  const parts = splitBubbles(text);
  if (!parts.length) return addMessage('assistant', '（空答案）', meta);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    last = addMessage('assistant', parts[i], isLast ? meta : '', { noSpeak: !isLast });
    if (isLast) {
      const btn = last.querySelector('.msg-tools .iconbtn');
      if (btn) {
        btn.title = '读出来（整段）';
        btn.replaceWith(btn.cloneNode(true));
        const fresh = last.querySelector('.msg-tools .iconbtn');
        fresh.addEventListener('click', () => speakText(text, fresh));
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

  const html = role === 'assistant' ? renderMarkdown(text) : null;
  if (html !== null) {
    bubble.classList.add('md');
    bubble.innerHTML = html;
  } else {
    bubble.textContent = text;
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
  div.textContent = '在下面输入一段文本，交给核心处理，答案会显示在这里。';
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
        addReplySeries(m.text || '', meta + usageNote(m.usage), { instant: true });
      } else if (m.role === 'user') {
        addMessage('user', m.text || '', formatClock(m.ts));
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

// ------------------------------------------------------- 聊天里的附件（视频） --

const attachBtn = document.getElementById('attach');
const attachFile = document.getElementById('attachFile');
const attachList = document.getElementById('attachList');
let pendingVideo = null;

function renderAttachChip() {
  if (!attachList) return;
  attachList.innerHTML = '';
  if (!pendingVideo) {
    attachList.classList.add('hidden');
    return;
  }
  attachList.classList.remove('hidden');

  const chip = document.createElement('div');
  chip.className = 'attach-chip';

  const name = document.createElement('span');
  name.className = 'attach-name';
  name.textContent = `🎬 ${pendingVideo.name} · ${(pendingVideo.size / 1048576).toFixed(1)} MB`;
  chip.appendChild(name);

  const barWrap = document.createElement('div');
  barWrap.className = 'attach-bar';
  const bar = document.createElement('div');
  bar.className = 'attach-bar-fill';
  barWrap.appendChild(bar);
  chip.appendChild(barWrap);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'attach-x';
  remove.textContent = '×';
  remove.title = '移除';
  remove.onclick = () => { pendingVideo = null; renderAttachChip(); };
  chip.appendChild(remove);

  attachList.appendChild(chip);
}

function updateAttachProgress(frac) {
  const bar = attachList && attachList.querySelector('.attach-bar-fill');
  if (bar) bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}

/** 把附件小条塞进这条用户消息的气泡里（刷新历史后就没有了，历史只存文字）。 */
function attachChipTo(wrap, label) {
  const bubble = wrap.querySelector('.bubble');
  if (!bubble) return;
  const chip = document.createElement('div');
  chip.className = 'bubble-attach';
  chip.textContent = '🎬 ' + label;
  bubble.insertBefore(chip, bubble.firstChild);
}

/** 回复下面挂一份"模型看到的/听到的"，默认收起。 */
function attachVideoDetails(wrap, analysis) {
  if (!analysis || !wrap) return;
  const box = document.createElement('details');
  box.className = 'msg-details';
  const sum = document.createElement('summary');
  sum.textContent = '它看到了什么';
  box.appendChild(sum);

  const body = document.createElement('div');
  body.className = 'muted';
  const lines = [];
  if (analysis.synopsis) lines.push('画面：' + analysis.synopsis);
  if (analysis.audio && analysis.audio.ok) {
    if (analysis.audio.transcript) lines.push('听到的话：' + analysis.audio.transcript);
    if (analysis.audio.summary) lines.push('声音：' + analysis.audio.summary);
  }
  if (Array.isArray(analysis.timeline) && analysis.timeline.length) {
    lines.push('时间线：' + analysis.timeline.map((t) => `${t.t} ${t.what}`).join('；'));
  }
  body.textContent = lines.join('\n');
  box.appendChild(body);
  wrap.appendChild(box);
}

async function sendWithVideo(text) {
  const file = pendingVideo;
  busy = true;
  sendBtn.disabled = true;
  inputEl.value = '';
  autoGrow();

  const userWrap = addMessage('user', text || '（发了段视频）', formatClock(Date.now()));
  attachChipTo(userWrap, file.name);
  const pending = addPending();
  const started = performance.now();

  try {
    setStatus('busy', '上传视频 0%…');
    const up = await uploadVideoFile(file, (frac) => {
      updateAttachProgress(frac);
      setStatus('busy', `上传视频 ${Math.round(frac * 100)}%…`);
    });
    setStatus('busy', '抽帧、听声音、让它看…');
    updateAttachProgress(1);

    const data = await apiJson('/api/video/analyze-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: up.uploadId, text, frames: 6 }),
    });
    pending.remove();

    if (data && data.ok) {
      const ms = Math.round(performance.now() - started);
      const replyWrap = await addReplySeries(data.reply || '（空答案）',
        `${(ms / 1000).toFixed(1)} 秒${data.tokens ? ' · ' + data.tokens.total + ' token' : ''} · ${formatClock(Date.now())}`);
      attachVideoDetails(replyWrap, data.analysis);
    } else {
      addMessage('error', (data && (data.error || data.code)) || '看视频失败');
    }
  } catch (err) {
    pending.remove();
    addMessage('error', String(err && err.message ? err.message : err));
  } finally {
    pendingVideo = null;
    renderAttachChip();
    busy = false;
    sendBtn.disabled = !currentUser;
    setStatus('', '');
    refreshHealth();
    if (currentUser) inputEl.focus();
  }
}

if (attachBtn) {
  attachBtn.addEventListener('click', () => attachFile.click());
  attachFile.addEventListener('change', () => {
    const f = attachFile.files && attachFile.files[0];
    if (f) { pendingVideo = f; renderAttachChip(); }
    attachFile.value = '';
  });
}

async function send() {
  const text = inputEl.value.trim();
  if ((!text && !pendingVideo) || busy) return;
  if (!currentUser) {
    showAuth('login', '请先登录');
    return;
  }
  if (pendingVideo) return sendWithVideo(text);

  busy = true;
  sendBtn.disabled = true;
  setStatus('busy', '处理中…');
  inputEl.value = '';
  autoGrow();

  // 把最近几轮带上去，模型才能读出指代与言外之意
  const history = recentTurns.slice(-6);
  addMessage('user', text, formatClock(Date.now()));
  recentTurns.push({ role: 'user', text });
  const pending = addPending();
  const started = performance.now();

  try {
    const res = await apiFetch('/api/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, sessionId: getSessionId(), history }),
    });

    if (res.status === 401) {
      pending.remove();
      // 这轮没送到核心，别留在上下文里
      if (recentTurns.length && recentTurns[recentTurns.length - 1].text === text) recentTurns.pop();
      handleUnauthorized('会话过期，请重新登录');
      return;
    }

    const data = await res.json().catch(() => ({ ok: false, error: '无法解析响应' }));
    pending.remove();

    if (data.ok) {
      const ms = typeof data.ms === 'number' ? data.ms : Math.round(performance.now() - started);
      recentTurns.push({ role: 'assistant', text: data.answer || '' });
      if (recentTurns.length > 12) recentTurns.splice(0, recentTurns.length - 12);
      addReplySeries(data.answer || '（空答案）', `${(ms / 1000).toFixed(1)} 秒${usageNote(data.usage)} · ${formatClock(Date.now())}`);
    } else {
      const detail = data.exitCode != null ? `exit=${data.exitCode}` : '';
      addMessage('error', data.error || data.code || '请求失败', detail);
    }
  } catch (err) {
    pending.remove();
    addMessage('error', String(err && err.message ? err.message : err));
  } finally {
    busy = false;
    sendBtn.disabled = !currentUser;
    refreshHealth();
    if (currentUser) inputEl.focus();
  loadAdminPanel();
  }
}

function autoGrow() {
  inputEl.style.height = 'auto';
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
// ---------------------------------------------------------------- 视频视图 --

const videoEls = {
  drop: document.getElementById('videoDrop'),
  file: document.getElementById('videoFile'),
  pick: document.getElementById('videoPick'),
  hint: document.getElementById('videoDropHint'),
  text: document.getElementById('videoText'),
  frames: document.getElementById('videoFrames'),
  go: document.getElementById('videoGo'),
  url: document.getElementById('videoUrl'),
  urlGo: document.getElementById('videoUrlGo'),
  strip: document.getElementById('videoFramesStrip'),
  framesCard: document.getElementById('videoFramesCard'),
  resultCard: document.getElementById('videoResultCard'),
  reply: document.getElementById('videoReply'),
  synopsis: document.getElementById('videoSynopsis'),
  timeline: document.getElementById('videoTimeline'),
  onScreen: document.getElementById('videoOnScreen'),
  audio: document.getElementById('videoAudio'),
  progress: document.getElementById('videoProgress'),
  bar: document.getElementById('videoBar'),
};

let pickedVideo = null;

/** 原片直传：XHR 边发边报进度，不经过 base64。 */
function uploadVideoFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = `name=${encodeURIComponent(file.name || 'video.bin')}&size=${file.size}`;
    xhr.open('PUT', `/api/video/upload?${qs}`);
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
    xhr.send(file);
  });
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function seekVideo(v, t) {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('seeked', done); resolve(); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.max(0, Math.min(t, (v.duration || 0) - 0.05));
  });
}

/** 本地视频不上传：浏览器解码后只把 N 张 JPEG 送去分析。 */
async function sampleVideoFrames(file, count) {
  const objUrl = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.src = objUrl;
  try {
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = () => resolve();
      v.onerror = () => reject(new Error('浏览器解不了这个格式'));
      setTimeout(() => reject(new Error('读视频超时')), 20000);
    });
    const duration = v.duration;
    if (!duration || !isFinite(duration)) throw new Error('读不到视频时长');

    const maxSide = 896;
    const scale = Math.min(1, maxSide / Math.max(v.videoWidth || maxSide, v.videoHeight || maxSide));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((v.videoWidth || maxSide) * scale));
    canvas.height = Math.max(1, Math.round((v.videoHeight || maxSide) * scale));
    const ctx = canvas.getContext('2d');

    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = duration * (i + 0.5) / count;
      await seekVideo(v, t);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      frames.push({ t: fmtClock(t), dataUrl: canvas.toDataURL('image/jpeg', 0.8) });
    }
    return frames;
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

function renderFrameStrip(frames) {
  if (!videoEls.strip) return;
  videoEls.strip.innerHTML = '';
  for (const f of frames) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const img = document.createElement('img');
    img.src = f.dataUrl;
    img.alt = f.t;
    const cap = document.createElement('span');
    cap.textContent = f.t;
    wrap.append(img, cap);
    videoEls.strip.appendChild(wrap);
  }
  videoEls.framesCard.classList.remove('hidden');
}

function renderVideoResult(r) {
  if (!videoEls.resultCard) return;
  if (!r || !r.ok) {
    videoEls.reply.textContent = '没看成：' + ((r && r.error) || '未知原因');
    videoEls.synopsis.textContent = '';
    videoEls.timeline.innerHTML = '';
    videoEls.onScreen.textContent = '';
  } else {
    videoEls.reply.textContent = r.reply || '（她没说话）';
    const a = r.analysis || {};
    videoEls.synopsis.textContent = a.synopsis || '';
    videoEls.onScreen.textContent = a.onScreen ? '画面文字：' + a.onScreen : '';
    videoEls.timeline.innerHTML = '';
    for (const t of (a.timeline || [])) {
      const li = document.createElement('li');
      li.textContent = `${t.t || '?'}  ${t.what || ''}`;
      videoEls.timeline.appendChild(li);
    }

    // 听出来的声音
    const audioEl = document.getElementById('videoAudio');
    if (audioEl) {
      const audio = a.audio;
      if (!audio || !audio.ok) {
        audioEl.textContent = '';
      } else {
        const bits = [];
        if (audio.transcript) bits.push('听到的话：' + audio.transcript);
        if (audio.summary) bits.push('声音概况：' + audio.summary);
        if (Array.isArray(audio.events) && audio.events.length) {
          bits.push('声音事件：' + audio.events.map((e) => `${e.t} ${e.desc}`).join('；'));
        }
        audioEl.textContent = bits.join('\n');
      }
    }
  }
  videoEls.resultCard.classList.remove('hidden');
}

function acceptPickedFile(file) {
  if (!file) return;
  pickedVideo = file;
  videoEls.hint.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
  videoEls.go.disabled = false;
}

async function analyzePickedVideo() {
  if (!pickedVideo) return;
  const count = Number(videoEls.frames.value) || 8;
  const wantAudio = videoEls.audio ? videoEls.audio.checked : true;
  videoEls.go.disabled = true;
  try {
    let r;
    if (wantAudio) {
      // 传原片：服务器才能抽音轨（浏览器那条路只有帧，听不到声音）
      videoEls.hint.textContent = '正在上传原片…0%';
      setProgress(0);
      const up = await uploadVideoFile(pickedVideo, (frac) => {
        const pct = Math.round(frac * 100);
        videoEls.hint.textContent = `正在上传原片…${pct}%（${(pickedVideo.size / 1048576).toFixed(0)} MB）`;
        setProgress(frac);
      });
      videoEls.hint.textContent = '上传完了，服务器在抽帧、听音轨（几十秒）…';
      setProgress(0.99);
      r = await apiJson('/api/video/analyze-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: up.uploadId, text: videoEls.text.value.trim(), frames: count }),
      });
    } else {
      videoEls.hint.textContent = `正在本机抽 ${count} 帧…`;
      const frames = await sampleVideoFrames(pickedVideo, count);
      renderFrameStrip(frames);
      videoEls.hint.textContent = `抽到 ${frames.length} 帧，正在看（几十秒）…`;
      r = await apiJson('/api/video/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frames, text: videoEls.text.value.trim() }),
      });
    }
    renderVideoResult(r);
    videoEls.hint.textContent = r && r.ok ? '看完了' : '没看成';
  } catch (err) {
    videoEls.hint.textContent = '出错：' + (err && err.message || err);
  } finally {
    hideProgress();
    videoEls.go.disabled = false;
  }
}

function setProgress(frac) {
  if (!videoEls.progress || !videoEls.bar) return;
  videoEls.progress.classList.remove('hidden');
  videoEls.bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}

function hideProgress() {
  if (!videoEls.progress || !videoEls.bar) return;
  videoEls.progress.classList.add('hidden');
  videoEls.bar.style.width = '0%';
}

async function analyzeUrlVideo() {
  const link = videoEls.url.value.trim();
  if (!/^https?:\/\//i.test(link)) {
    videoEls.hint.textContent = '链接要 http(s) 开头';
    return;
  }
  const count = Number(videoEls.frames.value) || 8;
  videoEls.urlGo.disabled = true;
  videoEls.hint.textContent = '服务器正在下载并抽帧（可能要一分钟）…';
  try {
    const r = await apiJson('/api/video/url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: link, text: videoEls.text.value.trim(), frames: count }),
    });
    renderVideoResult(r);
    videoEls.hint.textContent = r && r.ok ? '看完了' : '没看成';
  } catch (err) {
    videoEls.hint.textContent = '出错：' + (err && err.message || err);
  } finally {
    videoEls.urlGo.disabled = false;
  }
}

if (videoEls.pick) {
  videoEls.pick.addEventListener('click', () => videoEls.file.click());
  videoEls.file.addEventListener('change', () => {
    acceptPickedFile(videoEls.file.files && videoEls.file.files[0]);
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    videoEls.drop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoEls.drop.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    videoEls.drop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoEls.drop.classList.remove('over');
    });
  });
  videoEls.drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    acceptPickedFile(f);
  });
  videoEls.go.addEventListener('click', analyzePickedVideo);
  videoEls.urlGo.addEventListener('click', analyzeUrlVideo);
}

/** 切栏：聊天 / 记忆 / 人格 / 账号。 */
function setView(name) {
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const titles = { chat: '聊天', memory: '记忆', video: '视频', persona: '人格', admin: '账号' };
  if (viewTitle) viewTitle.textContent = titles[name] || '';
  if (name === 'memory') loadMemoryView();
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
      body: JSON.stringify(register ? { username, password, displayName } : { username, password }),
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
