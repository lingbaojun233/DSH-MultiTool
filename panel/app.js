'use strict';

const logEl = document.getElementById('log');
const emptyEl = document.getElementById('empty');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const memBtn = document.getElementById('mem');
const drawer = document.getElementById('drawer');
const drawerClose = document.getElementById('drawerClose');

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
  memBtn.disabled = locked;
  clearBtn.disabled = locked;
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
  drawer.classList.add('hidden');
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
  const card = document.getElementById('adminCard');
  if (!card) return;
  if (!currentUser || currentUser.role !== 'admin') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
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
function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function addMessage(role, text, meta) {
  if (emptyEl && emptyEl.parentNode) emptyEl.remove();

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
        addMessage('assistant', m.text || '', meta + usageNote(m.usage));
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

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  if (!currentUser) {
    showAuth('login', '请先登录');
    return;
  }

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
      addMessage('assistant', data.answer || '（空答案）', `${(ms / 1000).toFixed(1)} 秒${usageNote(data.usage)} · ${formatClock(Date.now())}`);
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

clearBtn.addEventListener('click', async () => {
  if (!window.confirm('清空历史记录？清空后刷新也不会恢复。')) return;
  try {
    await apiFetch('/api/history', { method: 'DELETE' });
  } catch (err) {
    /* nothing to do */
  }
  showEmpty();
  inputEl.focus();
});

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

/** 抽屉：人格 + 记忆库统计 + 最近事件。打开时现拉，不常驻轮询。 */
async function loadDrawer() {
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

  if (!currentUser) return;
  try {
    const s = await apiJson('/api/memory/stats');
    if (s && s.ok) {
      const c = s.counts || {};
      const rows = [
        ['事件', c.events], ['事实', c.facts], ['冲突', c.conflicts],
        ['实体', c.entities], ['已删', c.deletedEvents],
      ];
      document.getElementById('memStats').innerHTML = rows
        .map(([k, v]) => '<div class="stat"><b>' + (v == null ? 0 : v) + '</b><span>' + k + '</span></div>')
        .join('');
    }
  } catch (err) {
    /* 忽略 */
  }

  if (!currentUser) return;
  try {
    const e = await apiJson('/api/memory/events?limit=20');
    if (e && e.ok) {
      const list = (e.events || []).slice().reverse();
      document.getElementById('memEvents').innerHTML = list
        .map((ev) => '<li><div>' + escapeHtml(ev.content) + '</div><div class="ev-meta">'
          + escapeHtml(ev.actor) + ' · ' + escapeHtml(ev.ts) + ' · ' + escapeHtml(ev.evidence) + '</div></li>')
        .join('') || '<li class="ev-meta">（暂无事件）</li>';
    }
  } catch (err) {
    /* 忽略 */
  }
}

memBtn.addEventListener('click', () => {
  if (!currentUser) {
    showAuth('login', '请先登录');
    return;
  }
  drawer.classList.remove('hidden');
  loadDrawer();
});
drawerClose.addEventListener('click', () => drawer.classList.add('hidden'));

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
