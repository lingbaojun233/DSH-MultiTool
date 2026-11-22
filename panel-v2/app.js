'use strict';
/*
 * 视频面板 v2 —— 三个视图（做视频 / 任务 / 设置），原生 JS，没有框架、没有构建。
 * 后端 v2-core 契约见 README；本文件只跟 /api/studio/* 说话。
 */

const TOKEN_KEY = 'dsh-panel-token';
const PREFS_KEY = 'dsh-panel-v2-prefs';
const POLL_MS = 2000;
const TICK_MS = 1000;
const JOBS_LIMIT = 50;

/* 风格枚举跟 v2-core 对齐：空 = 跟人设（不传字段） */
const STYLE_OPTIONS = [
  { value: '', label: '跟人设' },
  { value: 'whiteboard', label: '白板讲解' },
  { value: 'blueprint', label: '工程蓝图' },
  { value: 'oscilloscope-math', label: '示波器数学' },
];

/* 音色 id 是云端动态的（voc_xxx），清单从 speak 拉；拉不到就只留「跟人设」 */
const DEFAULT_VOICE_OPTIONS = [{ value: '', label: '跟人设（推荐）' }];

/* 后端错误码 → 人能读懂的一句话（这是失败态唯一的展示来源） */
const ERROR_ZH = {
  VOICE_UNAVAILABLE: '配音服务不可用，已重试',
  MANIM_FAILED: '动画生成失败，已降级为文字卡',
  TEXT_FAILED: '文字卡生成失败，已重试',
  RENDER_FAILED: '视频合成失败，请重做',
  NO_SCENES: '没拆出分镜，换段更具体的稿子试试',
  TIMEOUT: '生成超时，已停止',
  JOB_NOT_FOUND: '任务不存在或已过期',
  UNAUTHORIZED: '未登录或登录已过期',
  RATE_LIMITED: '请求太频繁，等一会儿再试',
  BAD_REQUEST: '提交内容不完整，检查一下主题或分镜',
  UPSTREAM_DOWN: '视频服务没起来',
};

const PHASE_ZH = {
  queued: '排队中',
  plan: '规划分镜中',
  planning: '规划分镜中',
  script: '拆稿中',
  tts: '配音中',
  voice: '配音中',
  audio: '配音中',
  manim: 'manim 渲染中',
  render: '合成中',
  render_manim: 'manim 渲染中',
  compose: '合成中',
  upload: '上传中',
  retry: '重试中',
  done: '完成',
};

const STATUS_ZH = {
  queued: '排队中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  canceled: '已取消',
};

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.code = code || '';
  }
}

const state = {
  view: 'make',
  seconds: 45,
  prefs: { style: '', voice: '' },
  voiceOptions: DEFAULT_VOICE_OPTIONS.slice(),
  token: '',
  scenes: [],
  redoFrom: '',
  jobs: new Map(),
  currentJobId: '',
  cards: new Map(),
  current: null,
  currentId: '',
  submitting: false,
  polling: false,
  online: '',
  timers: { poll: 0, tick: 0 },
};

let els = {};

/* ---------- 小工具 ---------- */

function $(sel, root) {
  return (root || document).querySelector(sel);
}

function $$(sel, root) {
  return Array.from((root || document).querySelectorAll(sel));
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function charCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function isScript(text) {
  const raw = String(text || '');
  const lines = raw.split('\n').filter((line) => line.trim()).length;
  return charCount(raw) > 80 || lines >= 3;
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function authHeaders() {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  return headers;
}

function mediaHref(job, srt) {
  const base = `/api/studio/video/${encodeURIComponent(job.id)}`;
  const params = new URLSearchParams();
  if (srt) params.set('srt', '1');
  if (state.token) params.set('token', state.token);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/* ---------- 请求 ---------- */

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {}, authHeaders());
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body === undefined ? headers : Object.assign({ 'content-type': 'application/json' }, headers),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiError('连不上面板服务，确认 8775 在跑', 0, 'UPSTREAM_DOWN');
  }

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }

  if (!res.ok || !data || data.ok === false) {
    const code = (data && (data.error || data.code)) || '';
    throw new ApiError(code || `HTTP ${res.status}`, res.status, code);
  }
  return data;
}

function errText(err) {
  if (!err) return '出错了，请重试';
  if (!(err instanceof ApiError)) return err.message || '出错了，请重试';
  if (err.status === 401) return ERROR_ZH.UNAUTHORIZED;
  const code = String(err.code || '').toUpperCase();
  if (code && ERROR_ZH[code]) return ERROR_ZH[code];
  if (err.status === 0) return err.message;
  return err.message || '请求失败';
}

async function getJobDetail(id) {
  const data = await api(`/api/studio/jobs/${encodeURIComponent(id)}`);
  const job = data.job && typeof data.job === 'object' ? data.job : data;
  if (job && !job.id) job.id = id;
  return job;
}

/* ---------- 任务卡 ---------- */

function jobTitle(job) {
  const topic = String(job.topic || '').trim();
  if (topic) return topic;
  const script = String(job.script || '').trim();
  if (script) return `稿子 · ${charCount(script)} 字`;
  if (Array.isArray(job.scenes) && job.scenes.length) return `分镜 · ${job.scenes.length} 场`;
  return `任务 ${job.id}`;
}

function progressLine(job) {
  const total = Math.max(0, Number(job.total) || 0);
  const done = Math.max(0, Number(job.done) || 0);
  const phase = String(job.phase || (job.status === 'queued' ? 'queued' : ''));
  const zh = PHASE_ZH[phase] || String(job.label || '处理中');
  if (total > 0) {
    const current = Math.min(Math.max(done, 1), total);
    return `第 ${current}/${total} 场 ${zh}…`;
  }
  return `${zh}…`;
}

function errorLine(job) {
  const code = String(job.error || '').trim();
  if (!code) return '生成失败，请重试';
  const zh = ERROR_ZH[code.toUpperCase()];
  return zh || `生成失败：${code}`;
}

function buildStatusText(node) {
  const job = node.job;
  if (!job) return '';
  const status = String(job.status || 'queued').toLowerCase();
  if (status === 'failed') return errorLine(job);
  if (status === 'canceled') return '已取消';

  if (status === 'done') {
    const parts = ['已完成'];
    const scenes = Array.isArray(job.scenes) ? job.scenes.length : Number(job.total) || 0;
    if (scenes) parts.push(`${scenes} 场`);
    const ms = Number(job.elapsedMs) || Number(job.ms) || 0;
    if (ms) parts.push(`用时 ${formatElapsed(ms)}`);
    if (Array.isArray(job.warnings) && job.warnings.length) parts.push(`${job.warnings.length} 条提示`);
    return parts.join(' · ');
  }

  const ms = Number(job.elapsedMs) || Math.max(0, Date.now() - node.startedAt);
  return `${progressLine(job)}  已用 ${formatElapsed(ms)}`;
}

function createCard() {
  const root = el('article', 'card');
  const head = el('div', 'card-head');
  const title = el('h3', 'card-title');
  const chip = el('span', 'chip');
  const meta = el('div', 'card-meta');
  const status = el('p', 'card-status');
  const bar = el('div', 'bar');
  const fill = el('i');
  const actions = el('div', 'card-actions');
  const player = el('div', 'card-player hidden');

  head.appendChild(title);
  head.appendChild(chip);
  bar.appendChild(fill);
  root.appendChild(head);
  root.appendChild(meta);
  root.appendChild(status);
  root.appendChild(bar);
  root.appendChild(actions);
  root.appendChild(player);

  const node = {
    root,
    title,
    chip,
    meta,
    status,
    bar,
    fill,
    actions,
    player,
    job: null,
    startedAt: Date.now(),
    buttons: {},
  };

  const play = el('button', 'btn accent', '播放');
  play.type = 'button';
  play.dataset.act = 'play';
  const dlVideo = el('a', 'btn', '下载视频');
  dlVideo.setAttribute('download', '');
  const dlSrt = el('a', 'btn', '下载字幕');
  dlSrt.setAttribute('download', '');
  const redo = el('button', 'btn', '重做');
  redo.type = 'button';
  redo.dataset.act = 'redo';

  play.addEventListener('click', () => openPlayer(node));
  redo.addEventListener('click', () => onRedo(node.job));

  actions.appendChild(play);
  actions.appendChild(dlVideo);
  actions.appendChild(dlSrt);
  actions.appendChild(redo);
  node.buttons = { play, dlVideo, dlSrt, redo };

  return node;
}

function updateCard(node, job) {
  node.job = job;
  const status = String(job.status || 'queued').toLowerCase();
  const active = status === 'running' || status === 'queued';

  // 第一次看到这条任务时，用后端 elapsedMs 反推开始时间，本地每秒继续加
  const reportedMs = Number(job.elapsedMs) || Number(job.ms) || 0;
  if (!node.startedAt || node.startedAt > Date.now()) node.startedAt = Date.now();
  if (reportedMs > 0) {
    const guessed = Date.now() - reportedMs;
    if (Math.abs(guessed - node.startedAt) > 2500) node.startedAt = guessed;
  }
  node.lastElapsedMs = reportedMs;

  node.title.textContent = jobTitle(job);
  node.chip.textContent = STATUS_ZH[status] || status;
  node.chip.className = `chip ${status}`;

  const info = [];
  const seconds = Number(job.seconds);
  if (seconds) info.push(`${seconds} 秒`);
  const total = Number(job.total) || (Array.isArray(job.scenes) ? job.scenes.length : 0);
  if (total) info.push(`${total} 场`);
  if (job.id) info.push(`任务 ${job.id}`);
  node.meta.textContent = info.join(' · ');

  node.status.textContent = buildStatusText(node);
  node.status.className = `card-status${status === 'failed' ? ' failed' : ''}${status === 'done' ? ' done' : ''}`;

  let percent = 0;
  if (total > 0) percent = Math.min(100, Math.round(((Number(job.done) || 0) / total) * 100));
  if (status === 'done') percent = 100;
  if (!percent && active) percent = 8;
  node.fill.style.width = `${percent}%`;
  node.bar.className = `bar${status === 'failed' ? ' failed' : ''}`;

  const buttons = node.buttons;
  const done = status === 'done';
  const canRedo = done || status === 'failed' || status === 'canceled';
  buttons.play.classList.toggle('hidden', !done);
  buttons.dlVideo.classList.toggle('hidden', !done);
  buttons.dlSrt.classList.toggle('hidden', !done);
  buttons.redo.classList.toggle('hidden', !canRedo);
  if (done) {
    buttons.dlVideo.href = mediaHref(job, false);
    buttons.dlSrt.href = mediaHref(job, true);
  }
}

function openPlayer(node) {
  const job = node.job;
  if (!job) return;
  let video = node.player.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    node.player.appendChild(video);
  }
  video.src = mediaHref(job, false);
  node.player.classList.remove('hidden');
  const played = video.play();
  if (played && typeof played.catch === 'function') played.catch(() => {});
  node.player.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- 任务页 ---------- */

function renderJobs(jobs) {
  const list = (Array.isArray(jobs) ? jobs : []).slice(0, JOBS_LIMIT);
  const keep = new Set(list.map((job) => job.id));

  for (const [id, node] of state.cards) {
    if (!keep.has(id)) {
      node.root.remove();
      state.cards.delete(id);
    }
  }

  list.forEach((job, index) => {
    let node = state.cards.get(job.id);
    if (!node) {
      node = createCard();
      state.cards.set(job.id, node);
    }
    updateCard(node, job);
    const at = els.jobsList.children[index];
    if (at !== node.root) els.jobsList.insertBefore(node.root, at || null);
  });

  els.jobsEmpty.classList.toggle('hidden', list.length > 0);
  const running = list.filter((job) => job.status === 'running' || job.status === 'queued').length;
  els.jobsSummary.textContent = list.length
    ? `最近 ${list.length} 条${running ? ` · ${running} 条进行中` : ''}`
    : '最近 50 条';
}

function mountCurrent(job) {
  els.currentJob.classList.remove('hidden');
  if (!state.current || !state.current.root.parentNode || state.currentId !== job.id) {
    els.currentJob.textContent = '';
    const node = createCard();
    state.current = node;
    state.currentId = job.id;
    els.currentJob.appendChild(node.root);
  }
  updateCard(state.current, job);
  state.jobs.set(job.id, job);
}

function updateCurrent(job) {
  if (!state.current || state.currentId !== job.id) {
    mountCurrent(job);
    return;
  }
  updateCard(state.current, job);
  state.jobs.set(job.id, job);
}

function tickElapsed() {
  const nodes = [];
  if (state.current) nodes.push(state.current);
  for (const node of state.cards.values()) nodes.push(node);
  for (const node of nodes) {
    if (!node.job) continue;
    const status = String(node.job.status || '').toLowerCase();
    if (status !== 'running' && status !== 'queued') continue;
    node.status.textContent = buildStatusText(node);
  }
}

/* ---------- 轮询 ---------- */

async function pollJobs() {
  if (document.hidden || state.polling) return;
  state.polling = true;
  try {
    const data = await api('/api/studio/jobs');
    setOnline('online', '在线');
    const jobs = (Array.isArray(data.jobs) ? data.jobs : [])
      .filter((job) => job && job.id)
      .map((job) => {
        state.jobs.set(job.id, job);
        return job;
      });
    renderJobs(jobs);    if (state.currentJobId) {
      const known = state.jobs.get(state.currentJobId);
      const active = !known || known.status === 'running' || known.status === 'queued';
      if (active) await refreshCurrent();
      else if (state.current) updateCurrent(known);
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setOnline('auth', '未登录');
      els.jobsEmpty.textContent = '需要登录才能看任务';
    } else {
      setOnline('offline', '服务未就绪');
    }
  } finally {
    state.polling = false;
  }
}

async function refreshCurrent() {
  if (!state.currentJobId) return;
  try {
    const job = await getJobDetail(state.currentJobId);
    updateCurrent(job);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) setOnline('auth', '未登录');
  }
}

function setOnline(mode, text) {
  if (state.online === mode) return;
  state.online = mode;
  els.status.className = `status ${mode}`;
  els.statusText.textContent = text;
}

/* ---------- 分镜表 ---------- */

function blankScene() {
  return {
    text: '',
    narration: '',
    seconds: 5,
    hint: '',
    tool: 'auto',
    stickers: [],
    image: '',
    manim: null,
    status: '',
    note: '',
  };
}

function loadScenes(scenes) {
  state.scenes = (Array.isArray(scenes) ? scenes : []).map((scene) => {
    const source = scene && typeof scene === 'object' ? scene : {};
    const tool = source.tool === 'manim' || source.tool === 'text' ? source.tool : 'auto';
    return {
      text: String(source.text || ''),
      narration: String(source.narration || ''),
      seconds: Math.min(15, Math.max(1, Number(source.seconds) || 5)),
      hint: String(source.hint || ''),
      tool,
      stickers: Array.isArray(source.stickers) ? source.stickers.slice() : [],
      image: String(source.image || ''),
      manim: source.manim && typeof source.manim === 'object' ? source.manim : null,
      status: String(source.status || ''),
      note: String(source.note || ''),
    };
  });
  renderScenes();
}

function sceneCountBadge() {
  const n = state.scenes.filter((scene) => String(scene.text || '').trim()).length;
  els.sceneCount.textContent = `${n} 场`;
  els.sceneCount.classList.toggle('hidden', !n);
  els.scenesEmpty.classList.toggle('hidden', state.scenes.length > 0);
  els.scenesTable.classList.toggle('hidden', state.scenes.length === 0);
}

function renderScenes() {
  const tpl = $('#sceneRowTpl');
  els.scenesBody.textContent = '';
  state.scenes.forEach((scene, index) => {
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.dataset.i = String(index);
    row.querySelector('.scene-idx').textContent = String(index + 1);
    const text = row.querySelector('[data-field="text"]');
    const seconds = row.querySelector('[data-field="seconds"]');
    const tool = row.querySelector('[data-field="tool"]');
    const hint = row.querySelector('[data-field="hint"]');
    text.value = scene.text;
    seconds.value = String(Math.round(scene.seconds));
    tool.value = scene.tool;
    hint.value = scene.hint;
    els.scenesBody.appendChild(row);
  });
  sceneCountBadge();
}

function readSceneInput(target) {
  const row = target.closest('.scene-row');
  if (!row) return;
  const index = Number(row.dataset.i);
  const scene = state.scenes[index];
  const field = target.dataset.field;
  if (!scene || !field) return;
  if (field === 'seconds') {
    const n = Number(target.value);
    scene.seconds = Math.min(15, Math.max(1, Number.isFinite(n) && n > 0 ? n : 5));
  } else if (field === 'tool') {
    scene.tool = target.value === 'manim' || target.value === 'text' ? target.value : 'auto';
  } else if (field === 'text' || field === 'hint') {
    scene[field] = target.value;
  }
  sceneCountBadge();
}

function collectScenes() {
  return state.scenes
    .filter((scene) => String(scene.text || '').trim())
    .map((scene) => ({
      text: String(scene.text).trim(),
      narration: String(scene.narration || ''),
      seconds: Math.min(15, Math.max(1, Number(scene.seconds) || 5)),
      hint: String(scene.hint || ''),
      tool: scene.tool === 'manim' || scene.tool === 'text' ? scene.tool : 'auto',
      stickers: Array.isArray(scene.stickers) ? scene.stickers : [],
      image: String(scene.image || ''),
      manim: scene.manim && typeof scene.manim === 'object' ? scene.manim : null,
    }));
}

/* ---------- 提交 / 重做 ---------- */

function showHint(text, isError) {
  els.submitHint.textContent = text || '';
  els.submitHint.className = `hint${isError ? ' error' : ''}`;
}

function updateModeHint() {
  const text = els.topicInput.value.trim();
  const sceneCount = state.scenes.filter((scene) => String(scene.text || '').trim()).length;
  if (state.redoFrom) {
    showHint(`重做任务 ${state.redoFrom}：提交用下面 ${sceneCount} 场分镜`);
    return;
  }
  if (sceneCount) {
    showHint(`分镜 ${sceneCount} 场 · 提交时用分镜（点「清空」改回文字）`);
    return;
  }
  if (!text) {
    showHint('');
    return;
  }
  const chars = charCount(text);
  showHint(isScript(text) ? `按稿子处理 · ${chars} 字` : `按主题处理 · ${chars} 字`);
}

function setBusy(busy) {
  els.startBtn.disabled = busy;
  els.startBtn.textContent = busy ? '提交中…' : '开始做';
}

function placeholderJob(id, body) {
  return {
    id,
    status: 'queued',
    phase: 'queued',
    done: 0,
    total: Array.isArray(body.scenes) ? body.scenes.length : 0,
    seconds: Number(body.seconds) || state.seconds,
    topic: body.topic || '',
    script: body.script || '',
    scenes: Array.isArray(body.scenes) ? body.scenes : null,
    elapsedMs: 0,
    bytes: 0,
    warnings: [],
    error: null,
  };
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.submitting) return;

  const text = els.topicInput.value.trim();
  const scenes = collectScenes();
  const seconds = state.seconds;
  let body;
  let path;
  let kind;

  if (state.redoFrom) {
    if (!scenes.length) {
      showHint('分镜是空的：至少留一场有文字的', true);
      return;
    }
    body = { scenes };
    path = `/api/studio/jobs/${encodeURIComponent(state.redoFrom)}/redo`;
    kind = 'redo';
  } else if (scenes.length) {
    body = { scenes, seconds };
    path = '/api/studio/jobs';
    kind = 'scenes';
  } else {
    if (!text) {
      showHint('先写点什么：一个主题，或者一段稿子', true);
      els.topicInput.focus();
      return;
    }
    body = isScript(text) ? { script: text, seconds } : { topic: text, seconds };
    path = '/api/studio/jobs';
    kind = isScript(text) ? 'script' : 'topic';
  }

  // 「跟人设」就省略，让后端按人设补；手工选了才带上
  if (kind !== 'redo') {
    if (state.prefs.style) body.style = state.prefs.style;
    if (state.prefs.voice) body.voice = state.prefs.voice;
  }

  state.submitting = true;
  setBusy(true);
  try {
    const data = await api(path, { method: 'POST', body });
    if (!data.jobId) throw new ApiError('服务没返回任务 id', 502, '');
    const job = placeholderJob(String(data.jobId), body);
    state.currentJobId = job.id;
    mountCurrent(job);
    setOnline('online', '在线');
    showHint(`已提交 · 任务 ${job.id}`);
    if (kind === 'redo') {
      // 重做已提交，旧分镜不能留着劫持下一次「开始做」
      state.redoFrom = '';
      hideRedoBanner();
      loadScenes([]);
      updateModeHint();
    }
    pollJobs();
    refreshCurrent();
  } catch (err) {
    showHint(errText(err), true);
    if (err instanceof ApiError && err.status === 401) setOnline('auth', '未登录');
  } finally {
    state.submitting = false;
    setBusy(false);
  }
}

function showRedoBanner(job) {
  els.redoText.textContent = `重做任务 ${job.id} · 分镜已载入，改完点「开始做」`;
  els.redoBanner.classList.remove('hidden');
}

function hideRedoBanner() {
  els.redoBanner.classList.add('hidden');
  els.redoText.textContent = '';
}

async function onRedo(job) {
  if (!job) return;
  try {
    let full = job;
    if (!Array.isArray(full.scenes) || !full.scenes.length) {
      full = await getJobDetail(job.id);
    }
    if (!Array.isArray(full.scenes) || !full.scenes.length) {
      toast('这条任务没有分镜，没法重做');
      return;
    }
    state.redoFrom = full.id;
    loadScenes(full.scenes);
    els.advanced.open = true;
    showRedoBanner(full);
    switchView('make');
    updateModeHint();
    els.advanced.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (window.innerWidth >= 900) {
      const first = els.scenesBody.querySelector('.scene-text');
      if (first) {
        first.focus({ preventScroll: true });
        if (first.select) first.select();
      }
    }
    toast('分镜已载入，改完点「开始做」');
  } catch (err) {
    toast(errText(err));
  }
}

/* ---------- 设置 ---------- */

function fillSelect(select, options, value) {
  select.textContent = '';
  options.forEach((option) => {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  });
  select.value = value;
}

function loadPrefs() {
  let raw = {};
  try {
    raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch (err) {
    raw = {};
  }
  const style = STYLE_OPTIONS.some((option) => option.value === raw.style) ? raw.style : '';
  // 音色 id 由 speak 动态给（voc_xxx），本地只做类型检查，具体是否存在等清单回来再对上
  const voice = typeof raw.voice === 'string' ? raw.voice : '';
  state.prefs = { style, voice };
}

function savePrefs() {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    els.saveHint.textContent = '已保存到本机';
  } catch (err) {
    els.saveHint.textContent = '这个浏览器存不了设置（隐私模式？）';
  }
}

function voiceChoices() {
  const options = state.voiceOptions.slice();
  const saved = state.prefs.voice;
  if (saved && !options.some((option) => option.value === saved)) {
    // 清单还没回来 / 这个音色已下架：保留本地选择，别把用户设置悄悄清掉
    options.push({ value: saved, label: `已保存音色（${saved}）` });
  }
  return options;
}

function applyPrefs() {
  fillSelect(els.styleSel, STYLE_OPTIONS, state.prefs.style);
  fillSelect(els.voiceSel, voiceChoices(), state.prefs.voice);
  fillSelect(els.setStyle, STYLE_OPTIONS, state.prefs.style);
  fillSelect(els.setVoice, voiceChoices(), state.prefs.voice);
}

function setVoiceHint(text) {
  if (els.voiceHint) els.voiceHint.textContent = text;
}

/** 音色清单是动态的：speak 的 /v1/voices?zh=1 经面板代理拉一次，失败就退回「跟人设」。 */
async function loadVoices() {
  try {
    const data = await api('/api/studio/voices?zh=1');
    const list = Array.isArray(data.voices) ? data.voices : [];
    const options = DEFAULT_VOICE_OPTIONS.slice();
    for (const item of list) {
      const id = String(item.voiceId || item.id || '').trim();
      if (!id) continue;
      const name = String(item.name || item.label || id);
      options.push({ value: id, label: item.current ? `${name}（当前）` : name });
    }
    state.voiceOptions = options;
    if (options.length > 1) {
      setVoiceHint(`已加载 ${options.length - 1} 个云端音色；想换音色也可以在聊天里说「换音色」`);
    } else {
      setVoiceHint('云端暂时没有可用音色，先用「跟人设」；想换音色请在聊天里说「换音色」');
    }
  } catch (err) {
    setVoiceHint('暂时拉不到音色清单，先用「跟人设」；想换音色请在聊天里说「换音色」');
  }
  applyPrefs();
}

function onPrefChange(which, value) {
  state.prefs[which] = value;
  applyPrefs();
  savePrefs();
}

/* ---------- 视图 / 提示 ---------- */

function switchView(name) {
  state.view = name;
  $$('.tab').forEach((tab) => {
    const on = tab.dataset.view === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  });
  $$('.view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${name}`);
  });
  if (name === 'jobs') pollJobs();
  if (name === 'settings') applyPrefs();
}

let toastTimer = 0;
function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2600);
}

/* ---------- 初始化 ---------- */

function initToken() {
  let fromUrl = '';
  try {
    const url = new URL(window.location.href);
    fromUrl = url.searchParams.get('token') || '';
    if (fromUrl) {
      url.searchParams.delete('token');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch (err) {
    fromUrl = '';
  }
  try {
    if (fromUrl) {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
      state.token = fromUrl;
    } else {
      state.token = window.localStorage.getItem(TOKEN_KEY) || '';
    }
  } catch (err) {
    state.token = fromUrl;
  }
}

function bindEvents() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  els.topicInput.addEventListener('input', updateModeHint);
  els.topicInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (els.makeForm.requestSubmit) els.makeForm.requestSubmit();
      else els.makeForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  els.makeForm.addEventListener('submit', onSubmit);

  els.secondsSeg.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn) return;
    state.seconds = Number(btn.dataset.sec) || 45;
    $$('.seg-btn', els.secondsSeg).forEach((item) => {
      const on = item === btn;
      item.classList.toggle('active', on);
      item.setAttribute('aria-pressed', String(on));
    });
  });

  els.addSceneBtn.addEventListener('click', () => {
    state.scenes.push(blankScene());
    renderScenes();
    const inputs = els.scenesBody.querySelectorAll('.scene-text');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  });

  els.clearScenesBtn.addEventListener('click', () => {
    state.redoFrom = '';
    hideRedoBanner();
    loadScenes([]);
    updateModeHint();
    toast('分镜已清空');
  });

  els.scenesBody.addEventListener('input', (event) => readSceneInput(event.target));
  els.scenesBody.addEventListener('change', (event) => readSceneInput(event.target));
  els.scenesBody.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.scene-row');
    if (!row) return;
    const index = Number(row.dataset.i);
    if (btn.dataset.act === 'delete') {
      state.scenes.splice(index, 1);
      renderScenes();
    } else if (btn.dataset.act === 'insert') {
      state.scenes.splice(index + 1, 0, blankScene());
      renderScenes();
      const rows = els.scenesBody.querySelectorAll('.scene-row');
      const inserted = rows[index + 1];
      if (inserted) {
        const input = inserted.querySelector('.scene-text');
        if (input) input.focus();
      }
    }
  });

  els.styleSel.addEventListener('change', () => onPrefChange('style', els.styleSel.value));
  els.voiceSel.addEventListener('change', () => onPrefChange('voice', els.voiceSel.value));
  els.setStyle.addEventListener('change', () => onPrefChange('style', els.setStyle.value));
  els.setVoice.addEventListener('change', () => onPrefChange('voice', els.setVoice.value));

  els.redoCancel.addEventListener('click', () => {
    state.redoFrom = '';
    loadScenes([]);
    hideRedoBanner();
    updateModeHint();
  });

  els.refreshJobs.addEventListener('click', () => {
    els.refreshJobs.disabled = true;
    pollJobs().finally(() => {
      els.refreshJobs.disabled = false;
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollJobs();
  });
}

function init() {
  els = {
    status: $('#status'),
    statusText: $('#statusText'),
    makeForm: $('#makeForm'),
    topicInput: $('#topicInput'),
    secondsSeg: $('#secondsSeg'),
    startBtn: $('#startBtn'),
    submitHint: $('#submitHint'),
    redoBanner: $('#redoBanner'),
    redoText: $('#redoText'),
    redoCancel: $('#redoCancel'),
    currentJob: $('#currentJob'),
    advanced: $('#advanced'),
    scenesBody: $('#scenesBody'),
    scenesTable: $('#scenesTable'),
    scenesEmpty: $('#scenesEmpty'),
    sceneCount: $('#sceneCount'),
    addSceneBtn: $('#addSceneBtn'),
    clearScenesBtn: $('#clearScenesBtn'),
    styleSel: $('#styleSel'),
    voiceSel: $('#voiceSel'),
    setStyle: $('#setStyle'),
    setVoice: $('#setVoice'),
    voiceHint: $('#voiceHint'),
    saveHint: $('#saveHint'),
    jobsList: $('#jobsList'),
    jobsEmpty: $('#jobsEmpty'),
    jobsSummary: $('#jobsSummary'),
    refreshJobs: $('#refreshJobs'),
    toast: $('#toast'),
  };

  initToken();
  loadPrefs();
  applyPrefs();
  bindEvents();
  renderScenes();
  updateModeHint();
  loadVoices();

  // 首屏探一次服务状态；之后由 2 秒轮询维护
  pollJobs();
  state.timers.poll = window.setInterval(pollJobs, POLL_MS);
  state.timers.tick = window.setInterval(tickElapsed, TICK_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
