'use strict';
/**
 * 视频创作 v2 —— 从 panel-v2/app.js 抽出来的三视图（做视频 / 任务 / 设置），
 * 挂到旧面板视频 tab 的容器 #videoV2Root 上。
 *
 * 数据只走 /api/v2/*（旧面板 server.js 代理到 studio-v2 8774）：
 *   GET  /api/v2/jobs             最近 50 条
 *   GET  /api/v2/jobs/:id         单条任务（2 秒轮询）
 *   POST /api/v2/jobs             新任务
 *   POST /api/v2/jobs/:id/redo    按改过的分镜重做
 *   GET  /api/v2/video/:id        mp4 / ?srt=1
 *   GET  /api/v2/voices?zh=1      音色清单（面板转 speak）
 *
 * 不碰旧 studio（8772）的任何接口。类名统一 v2- 前缀，避免和旧面板全局样式打架。
 */
(function () {
  const TOKEN_KEY = 'dsh-panel-token';
  const PREFS_KEY = 'dsh-panel-v2-prefs';
  const POLL_MS = 2000;
  const TICK_MS = 1000;
  const JOBS_LIMIT = 50;

  /* 风格枚举跟 studio-v2 对齐：空 = 跟人设（不传字段） */
  const STYLE_OPTIONS = [
    { value: '', label: '跟人设' },
    { value: 'whiteboard', label: '白板讲解' },
    { value: 'blueprint', label: '工程蓝图' },
    { value: 'oscilloscope-math', label: '示波器数学' },
  ];

  /* 音色 id 是云端动态的（voc_xxx），清单从 speak 拉；拉不到就只留「跟人设」 */
  const DEFAULT_VOICE_OPTIONS = [{ value: '', label: '跟人设（推荐）' }];

  /* 后端错误码 → 人能读懂的一句话 */
  const ERROR_ZH = {
    VOICE_UNAVAILABLE: '配音服务不可用，已重试',
    MANIM_FAILED: '动画生成失败，已降级为文字卡',
    TEXT_FAILED: '文字卡生成失败，已重试',
    RENDER_FAILED: '视频合成失败，请重做',
    CONCAT_FAILED: '成片拼接失败，请重做',
    PLAN_FAILED: '分镜规划失败，换段更具体的稿子试试',
    NO_SCENES: '没拆出分镜，换段更具体的稿子试试',
    SCENES_REQUIRED: '分镜是空的：至少留一场有文字的',
    INPUT_REQUIRED: '先写点什么：一个主题，或者一段稿子',
    TIMEOUT: '生成超时，已停止',
    JOB_NOT_FOUND: '任务不存在或已过期',
    UNAUTHORIZED: '未登录或登录已过期',
    RATE_LIMITED: '请求太频繁，等一会儿再试',
    BAD_REQUEST: '提交内容不完整，检查一下主题或分镜',
    BAD_JSON: '提交内容格式不对',
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
    concat: '拼接成片',
    upload: '上传中',
    retry: '重试中',
    done: '完成',
    failed: '失败',
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

  const root = document.getElementById('videoV2Root');
  if (!root) return; // 这个页面上没有视频容器：保持静默，别拖垮别的标签页

  const state = {
    view: 'make',
    seconds: 45,
    prefs: { style: '', voice: '' },
    voiceOptions: DEFAULT_VOICE_OPTIONS.slice(),
    voicesLoaded: false,
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
    listBusy: false,
    online: '',
    initialized: false,
    timers: { poll: 0, tick: 0, list: 0 },
  };

  let els = {};

  /* ---------- 小工具 ---------- */

  function $(sel) {
    return root.querySelector(sel);
  }

  function $$(sel) {
    return Array.from(root.querySelectorAll(sel));
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
    if (total < 1) return '不到 1 秒';
    if (total < 60) return `${total} 秒`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  }

  function isTerminal(job) {
    const status = String((job && job.status) || '').toLowerCase();
    return status === 'done' || status === 'failed' || status === 'canceled';
  }

  function isActive(job) {
    const status = String((job && job.status) || '').toLowerCase();
    return status === 'running' || status === 'queued';
  }

  function syncToken() {
    try {
      state.token = window.localStorage.getItem(TOKEN_KEY) || '';
    } catch (err) {
      state.token = '';
    }
  }

  function authHeaders() {
    const headers = {};
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    return headers;
  }

  function mediaHref(job, srt) {
    const base = `/api/v2/video/${encodeURIComponent(job.id)}`;
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
      throw new ApiError('连不上面板服务，确认 8766 在跑', 0, 'UPSTREAM_DOWN');
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
    const raw = String(err.code || '');
    const code = raw.split(':')[0].trim().toUpperCase();
    if (code && ERROR_ZH[code]) return ERROR_ZH[code];
    if (err.status === 0) return err.message;
    return err.message || '请求失败';
  }

  async function getJobDetail(id) {
    const data = await api(`/api/v2/jobs/${encodeURIComponent(id)}`);
    const job = data.job && typeof data.job === 'object' ? data.job : data;
    if (job && !job.id) job.id = id;
    return job;
  }

  /* ---------- 任务卡 ---------- */

  function jobTitle(job) {
    const title = String(job.title || '').trim();
    if (title) return title;
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
    const label = String(job.label || '').trim();
    if (label) return `${label}…`;
    const zh = PHASE_ZH[phase] || '处理中';
    if (total > 0) {
      const current = Math.min(Math.max(done, 1), total);
      return `第 ${current}/${total} 场 ${zh}…`;
    }
    return `${zh}…`;
  }

  function errorLine(job) {
    const raw = String(job.error || '').trim();
    if (!raw) return '生成失败，请重试';
    const code = raw.split(':')[0].trim().toUpperCase();
    const zh = ERROR_ZH[code];
    if (zh) {
      const detail = raw.split(':').slice(1).join(':').trim();
      return detail ? `${zh}（${detail}）` : zh;
    }
    return `生成失败：${raw}`;
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
    const card = el('article', 'v2-card');
    const head = el('div', 'v2-card-head');
    const title = el('h3', 'v2-card-title');
    const chip = el('span', 'v2-chip');
    const meta = el('div', 'v2-card-meta');
    const status = el('p', 'v2-card-status');
    const bar = el('div', 'v2-bar');
    const fill = el('i');
    const actions = el('div', 'v2-card-actions');
    const player = el('div', 'v2-card-player hidden');

    head.appendChild(title);
    head.appendChild(chip);
    bar.appendChild(fill);
    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(status);
    card.appendChild(bar);
    card.appendChild(actions);
    card.appendChild(player);

    const node = {
      root: card,
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

    const play = el('button', 'v2-btn v2-accent', '播放');
    play.type = 'button';
    play.dataset.act = 'play';
    const dlVideo = el('a', 'v2-btn', '下载视频');
    dlVideo.setAttribute('download', '');
    const dlSrt = el('a', 'v2-btn', '下载字幕');
    dlSrt.setAttribute('download', '');
    const redo = el('button', 'v2-btn', '重做');
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
    const active = isActive(job);

    // 第一次看到这条任务时，用后端 elapsedMs 反推开始时间，本地每秒继续加
    const reportedMs = Number(job.elapsedMs) || Number(job.ms) || 0;
    if (!node.startedAt || node.startedAt > Date.now()) node.startedAt = Date.now();
    if (reportedMs > 0) {
      const guessed = Date.now() - reportedMs;
      if (Math.abs(guessed - node.startedAt) > 2500) node.startedAt = guessed;
    }

    node.title.textContent = jobTitle(job);
    node.chip.textContent = STATUS_ZH[status] || status;
    node.chip.className = `v2-chip ${status}`;

    const info = [];
    const seconds = Number(job.seconds);
    if (seconds) info.push(`${seconds} 秒`);
    const total = Number(job.total) || (Array.isArray(job.scenes) ? job.scenes.length : 0);
    if (total) info.push(`${total} 场`);
    if (job.id) info.push(`任务 ${job.id}`);
    node.meta.textContent = info.join(' · ');

    node.status.textContent = buildStatusText(node);
    node.status.className = `v2-card-status${status === 'failed' ? ' failed' : ''}${status === 'done' ? ' done' : ''}`;

    let percent = 0;
    if (total > 0) percent = Math.min(100, Math.round(((Number(job.done) || 0) / total) * 100));
    if (status === 'done') percent = 100;
    if (!percent && active) percent = 8;
    node.fill.style.width = `${percent}%`;
    node.bar.className = `v2-bar${status === 'failed' ? ' failed' : ''}`;

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
    const running = list.filter(isActive).length;
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
      if (!node.job || !isActive(node.job)) continue;
      node.status.textContent = buildStatusText(node);
    }
  }

  /* ---------- 轮询 ---------- */

  /** 2 秒问一次单条任务；到终态（done/failed/canceled）就停表。 */
  function startJobPoll(jobId) {
    stopJobPoll();
    state.currentJobId = jobId;
    state.timers.poll = window.setInterval(pollCurrent, POLL_MS);
    pollCurrent();
  }

  function stopJobPoll() {
    if (state.timers.poll) {
      window.clearInterval(state.timers.poll);
      state.timers.poll = 0;
    }
  }

  async function pollCurrent() {
    if (document.hidden || state.polling) return;
    if (!state.currentJobId) return;
    state.polling = true;
    const id = state.currentJobId;
    try {
      const job = await getJobDetail(id);
      updateCurrent(job);
      state.jobs.set(job.id, job);
      setOnline('online', '在线');
      if (isTerminal(job)) {
        stopJobPoll();
        pollJobs();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setOnline('auth', '未登录');
      else if (err instanceof ApiError && err.status === 404) stopJobPoll();
      else setOnline('offline', '服务未就绪');
    } finally {
      state.polling = false;
    }
  }

  async function pollJobs() {
    if (state.listBusy) return;
    state.listBusy = true;
    try {
      const data = await api('/api/v2/jobs');
      setOnline('online', '在线');
      const jobs = (Array.isArray(data.jobs) ? data.jobs : [])
        .filter((job) => job && job.id)
        .map((job) => {
          state.jobs.set(job.id, job);
          return job;
        });
      renderJobs(jobs);

      // 当前任务如果已经在列表里，顺手把卡片刷新一下（不额外发单条请求）
      if (state.currentJobId && !state.timers.poll) {
        const known = state.jobs.get(state.currentJobId);
        if (known && state.current) updateCurrent(known);
      }

      if (state.view === 'jobs' && jobs.some(isActive)) ensureListPoll();
      else stopListPoll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setOnline('auth', '未登录');
        els.jobsEmpty.textContent = '需要登录才能看任务';
      } else {
        setOnline('offline', '服务未就绪');
      }
    } finally {
      state.listBusy = false;
    }
  }

  function ensureListPoll() {
    if (state.timers.list) return;
    state.timers.list = window.setInterval(() => {
      if (!document.hidden) pollJobs();
    }, POLL_MS);
  }

  function stopListPoll() {
    if (state.timers.list) {
      window.clearInterval(state.timers.list);
      state.timers.list = 0;
    }
  }

  function setOnline(mode, text) {
    if (state.online === mode && els.statusText.textContent === text) return;
    state.online = mode;
    els.status.className = `v2-status ${mode}`;
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
    const tpl = $('#v2SceneRowTpl');
    if (!tpl) return;
    els.scenesBody.textContent = '';
    state.scenes.forEach((scene, index) => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.i = String(index);
      row.querySelector('.v2-scene-idx').textContent = String(index + 1);
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
    const row = target.closest('.v2-scene-row');
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
    els.submitHint.className = `v2-hint${isError ? ' v2-error' : ''}`;
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
    const scenes = Array.isArray(body.scenes) ? body.scenes : null;
    const title = String(body.topic || (scenes && scenes[0] && scenes[0].text) || '').trim().slice(0, 80);
    return {
      id,
      status: 'queued',
      phase: 'queued',
      title,
      done: 0,
      total: scenes ? scenes.length : 0,
      seconds: Number(body.seconds) || state.seconds,
      topic: body.topic || '',
      script: body.script || '',
      scenes,
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
      path = `/api/v2/jobs/${encodeURIComponent(state.redoFrom)}/redo`;
      kind = 'redo';
    } else if (scenes.length) {
      body = { scenes, seconds };
      path = '/api/v2/jobs';
      kind = 'scenes';
    } else {
      if (!text) {
        showHint('先写点什么：一个主题，或者一段稿子', true);
        els.topicInput.focus();
        return;
      }
      body = isScript(text) ? { script: text, seconds } : { topic: text, seconds };
      path = '/api/v2/jobs';
      kind = isScript(text) ? 'script' : 'topic';
    }

    // 「跟人设」就省略，让 studio-v2 按人设补；手工选了才带上
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
      // 提交后 2 秒一次问单条任务，终态停表
      startJobPoll(job.id);
      pollJobs();
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

  /** 重做：先 GET /api/v2/jobs/:id 拿最新 scenes，填进高级区分镜表，再走 redo 提交。 */
  async function onRedo(job) {
    if (!job || !job.id) return;
    try {
      const full = await getJobDetail(job.id);
      if (!Array.isArray(full.scenes) || !full.scenes.length) {
        toast('这条任务没有分镜，没法重做');
        return;
      }
      state.redoFrom = full.id || job.id;
      loadScenes(full.scenes);
      els.advanced.open = true;
      showRedoBanner(full);
      switchView('make');
      updateModeHint();
      els.advanced.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (window.innerWidth >= 900) {
        const first = els.scenesBody.querySelector('.v2-scene-text');
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

  /** 音色清单是动态的：speak 的 /v1/voices?zh=1 经面板 /api/v2/voices 拉一次。 */
  async function loadVoices() {
    try {
      const data = await api('/api/v2/voices?zh=1');
      const list = Array.isArray(data.voices) ? data.voices : [];
      const options = DEFAULT_VOICE_OPTIONS.slice();
      for (const item of list) {
        const id = String(item.voiceId || item.id || '').trim();
        if (!id) continue;
        const name = String(item.name || item.label || id);
        options.push({ value: id, label: item.current ? `${name}（当前）` : name });
      }
      state.voiceOptions = options;
      state.voicesLoaded = true;
      if (options.length > 1) {
        setVoiceHint(`已加载 ${options.length - 1} 个云端音色；想换音色也可以在聊天里说「换音色」`);
      } else {
        setVoiceHint('云端暂时没有可用音色，先用「跟人设」；想换音色请在聊天里说「换音色」');
      }
    } catch (err) {
      state.voicesLoaded = false;
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
    $$('.v2-tab').forEach((tab) => {
      const on = tab.dataset.v2View === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    $$('.video-v2-view').forEach((view) => {
      view.classList.toggle('active', view.id === `v2-view-${name}`);
    });
    if (name === 'jobs') {
      pollJobs();
      ensureListPoll();
    } else {
      stopListPoll();
    }
    if (name === 'settings') applyPrefs();
  }

  let toastTimer = 0;
  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('v2-toast-show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('v2-toast-show'), 2600);
  }

  /* ---------- 初始化 ---------- */

  function bindEvents() {
    els.tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('.v2-tab');
      if (!tab) return;
      switchView(tab.dataset.v2View);
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
      const btn = event.target.closest('.v2-seg-btn');
      if (!btn) return;
      state.seconds = Number(btn.dataset.sec) || 45;
      $$('.v2-seg-btn').forEach((item) => {
        const on = item === btn;
        item.classList.toggle('active', on);
        item.setAttribute('aria-pressed', String(on));
      });
    });

    els.addSceneBtn.addEventListener('click', () => {
      state.scenes.push(blankScene());
      renderScenes();
      const inputs = els.scenesBody.querySelectorAll('.v2-scene-text');
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
      const row = btn.closest('.v2-scene-row');
      if (!row) return;
      const index = Number(row.dataset.i);
      if (btn.dataset.act === 'delete') {
        state.scenes.splice(index, 1);
        renderScenes();
      } else if (btn.dataset.act === 'insert') {
        state.scenes.splice(index + 1, 0, blankScene());
        renderScenes();
        const rows = els.scenesBody.querySelectorAll('.v2-scene-row');
        const inserted = rows[index + 1];
        if (inserted) {
          const input = inserted.querySelector('.v2-scene-text');
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
      if (document.hidden) return;
      if (state.currentJobId && state.timers.poll) pollCurrent();
      if (state.view === 'jobs') pollJobs();
    });
  }

  function collectEls() {
    return {
      tabs: $('#v2Tabs'),
      status: $('#v2Status'),
      statusText: $('#v2StatusText'),
      makeForm: $('#v2MakeForm'),
      topicInput: $('#v2TopicInput'),
      secondsSeg: $('#v2SecondsSeg'),
      startBtn: $('#v2StartBtn'),
      submitHint: $('#v2SubmitHint'),
      redoBanner: $('#v2RedoBanner'),
      redoText: $('#v2RedoText'),
      redoCancel: $('#v2RedoCancel'),
      currentJob: $('#v2CurrentJob'),
      advanced: $('#v2Advanced'),
      scenesBody: $('#v2ScenesBody'),
      scenesTable: $('#v2ScenesTable'),
      scenesEmpty: $('#v2ScenesEmpty'),
      sceneCount: $('#v2SceneCount'),
      addSceneBtn: $('#v2AddSceneBtn'),
      clearScenesBtn: $('#v2ClearScenesBtn'),
      styleSel: $('#v2StyleSel'),
      voiceSel: $('#v2VoiceSel'),
      setStyle: $('#v2SetStyle'),
      setVoice: $('#v2SetVoice'),
      voiceHint: $('#v2VoiceHint'),
      saveHint: $('#v2SaveHint'),
      jobsList: $('#v2JobsList'),
      jobsEmpty: $('#v2JobsEmpty'),
      jobsSummary: $('#v2JobsSummary'),
      refreshJobs: $('#v2RefreshJobs'),
      toast: $('#v2Toast'),
    };
  }

  function init() {
    els = collectEls();
    const missing = Object.keys(els).filter((key) => !els[key]);
    if (missing.length) {
      console.warn('video-v2: 缺少 DOM 节点', missing.join(', '));
      return;
    }

    syncToken();
    loadPrefs();
    applyPrefs();
    bindEvents();
    renderScenes();
    updateModeHint();
    loadVoices();

    // 首屏探一次服务状态；之后只在有任务/任务页时轮询
    pollJobs();
    state.timers.tick = window.setInterval(tickElapsed, TICK_MS);
    state.initialized = true;
  }

  /** 旧面板切到视频 tab、或登录成功时调用；重复调用只做刷新。 */
  function enter() {
    syncToken();
    if (!state.initialized) {
      init();
      return;
    }
    if (!state.voicesLoaded) loadVoices();
    pollJobs();
    if (state.currentJobId && state.timers.poll) pollCurrent();
  }

  window.VideoV2 = {
    enter,
    /** 给验收脚本用：只读快照，不改状态。 */
    snapshot: function () {
      return {
        initialized: state.initialized,
        view: state.view,
        seconds: state.seconds,
        jobs: state.jobs.size,
        currentJobId: state.currentJobId,
        scenes: state.scenes.length,
        redoFrom: state.redoFrom,
        polling: Boolean(state.timers.poll),
      };
    },
  };
})();
