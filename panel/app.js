'use strict';

const logEl = document.getElementById('log');
const emptyEl = document.getElementById('empty');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');

const hasMarkdown = typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined';

if (hasMarkdown) {
  window.marked.setOptions({ gfm: true, breaks: true });
}

let busy = false;

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
    const res = await fetch('/api/history?limit=200', { cache: 'no-store' });
    const data = await res.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (!messages.length) return;

    logEl.innerHTML = '';
    for (const m of messages) {
      if (m.role === 'assistant') {
        const meta = typeof m.ms === 'number' ? `${(m.ms / 1000).toFixed(1)} 秒 · ${formatClock(m.ts)}` : formatClock(m.ts);
        addMessage('assistant', m.text || '', meta);
      } else if (m.role === 'user') {
        addMessage('user', m.text || '', formatClock(m.ts));
      } else {
        addMessage('error', m.text || '（错误）', formatClock(m.ts));
      }
    }
    logEl.scrollTop = logEl.scrollHeight;
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

  busy = true;
  sendBtn.disabled = true;
  setStatus('busy', '处理中…');
  inputEl.value = '';
  autoGrow();

  addMessage('user', text, formatClock(Date.now()));
  const pending = addPending();
  const started = performance.now();

  try {
    const res = await fetch('/api/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: '无法解析响应' }));
    pending.remove();

    if (data.ok) {
      const ms = typeof data.ms === 'number' ? data.ms : Math.round(performance.now() - started);
      addMessage('assistant', data.answer || '（空答案）', `${(ms / 1000).toFixed(1)} 秒 · ${formatClock(Date.now())}`);
    } else {
      const detail = data.exitCode != null ? `exit=${data.exitCode}` : '';
      addMessage('error', data.error || data.code || '请求失败', detail);
    }
  } catch (err) {
    pending.remove();
    addMessage('error', String(err && err.message ? err.message : err));
  } finally {
    busy = false;
    sendBtn.disabled = false;
    refreshHealth();
    inputEl.focus();
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
    await fetch('/api/history', { method: 'DELETE' });
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

refreshHealth();
setInterval(refreshHealth, 15000);
loadHistory();
inputEl.focus();
