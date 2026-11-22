'use strict';
/**
 * 视频创作 v2 —— 从 panel-v2/app.js 抽出来的三视图（做视频 / 任务 / 设置），
 * 挂到旧面板视频 tab 的容器 #videoV2Root 上。
 *
 * 数据只走 /api/v2/*（旧面板 server.js 代理到 studio-v2 8774）：
 *   GET  /api/v2/jobs             最近 50 条（每条带 projectId / projectTitle / version）
 *   GET  /api/v2/jobs/:id         单条任务（2 秒轮询）
 *   POST /api/v2/jobs             新任务（可选 projectId）
 *   POST /api/v2/jobs/:id/redo    按改过的分镜重做（沿用原任务的项目）
 *   GET  /api/v2/video/:id        mp4 / ?srt=1
 *   GET  /api/v2/voices?zh=1      音色清单（面板转 speak）
 *
 * 项目（一个主题）→ 版本（job）两层：
 *   GET    /api/v2/projects        项目列表（含未分组的旧任务）
 *   POST   /api/v2/projects        新建项目
 *   GET    /api/v2/projects/:id    项目详情 + 它的所有版本
 *   POST   /api/v2/projects/:id    改名
 *   DELETE /api/v2/projects/:id    删项目（连带它的版本和 mp4）
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

  /* 四个可调项：选项跟 studio-v2 的范围对齐（schema.js 里还会再夹一次） */
  const SPEED_OPTIONS = [
    { value: 0.9, label: '0.9' },
    { value: 1.0, label: '1.0' },
    { value: 1.1, label: '1.1' },
    { value: 1.2, label: '1.2' },
  ];
  /* 音高：半音，0 = 原声（后端会完全跳过重采样），默认 +1 */
  const PITCH_OPTIONS = [
    { value: 0, label: '原声' },
    { value: 0.5, label: '+0.5' },
    { value: 1.0, label: '+1（推荐）' },
    { value: 1.5, label: '+1.5' },
    { value: 2.0, label: '+2' },
  ];
  const PADDING_OPTIONS = [
    { value: 0.3, label: '0.3 秒' },
    { value: 0.6, label: '0.6 秒' },
    { value: 1.0, label: '1.0 秒' },
    { value: 1.5, label: '1.5 秒' },
  ];
  const STICKER_OPTIONS = [
    { value: 1.5, label: '1.5 秒' },
    { value: 2.0, label: '2.0 秒' },
    { value: 3.0, label: '3.0 秒' },
  ];
  const DEFAULT_PREFS = { narrationSpeed: 1.0, voicePitch: 1.0, scenePadding: 0.6, stickerDuration: 2.0 };

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
    prefs: { style: '', voice: '', ...DEFAULT_PREFS },
    voiceOptions: DEFAULT_VOICE_OPTIONS.slice(),
    voicesLoaded: false,
    // 表情候选：分镜表每场的表情选择器共用这一份（/api/stickers 拉一次）
    stickerOptions: [],
    stickersLoaded: false,
    stickerModalOpen: false,
    stickerTarget: -1,
    token: '',
    scenes: [],
    redoFrom: '',
    // 重做时沿用原任务的项目：下拉显示它并锁住（服务端也会沿用）
    redoProjectId: '',
    redoProjectTitle: '',
    // 做视频页选中的项目：'' = 「+ 新建项目」（提交时先建一个）
    projectId: '',
    // 任务页的数据：项目摘要 + 未分组旧任务
    projects: [],
    ungrouped: [],
    // null = 还没渲染过下拉；空字符串是「零个项目」的合法签名，两者不能混
    projectSig: null,
    projectCards: new Map(),
    jobs: new Map(),
    currentJobId: '',
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

  /* ---------- 任务页：项目 → 版本 ---------- */

  function formatAgo(ts) {
    const at = Number(ts) || 0;
    if (!at) return '';
    const diff = Date.now() - at;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    const date = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function statusIcon(status) {
    if (status === 'done') return '✓';
    if (status === 'failed') return '✕';
    if (status === 'canceled') return '–';
    return '…';
  }

  /** 一条版本的一句话：✓ v3 完成 · 58 秒 · 2 分钟前 */
  function versionLine(job, options) {
    const opts = options || {};
    const version = Number(job.version) || 0;
    const status = String(job.status || 'queued').toLowerCase();
    const parts = [];
    if (version && !opts.ungrouped) parts.push(`v${version} ${job.redoOf ? '重做' : '首次'}`);
    else if (opts.ungrouped) parts.push(String(job.title || '旧任务').slice(0, 24));
    parts.push(STATUS_ZH[status] || status);
    if (isActive(job)) {
      const phase = PHASE_ZH[String(job.phase || '')];
      if (phase) parts.push(phase);
    }
    const seconds = Number(job.seconds);
    if (seconds) parts.push(`${seconds} 秒`);
    const ago = formatAgo(job.createdAt);
    if (ago) parts.push(ago);
    if (status === 'failed' && job.error) parts.push(errorLine(job));
    return `${statusIcon(status)} ${parts.join(' · ')}`;
  }

  /** 明细接口拿不到时，用 GET /jobs 的列表兜底分组（老服务端也能看项目卡）。 */
  function groupsFromJobs(jobs) {
    const map = new Map();
    const ungrouped = [];
    for (const job of jobs) {
      const pid = String(job.projectId || '');
      if (!pid) {
        ungrouped.push(job);
        continue;
      }
      if (!map.has(pid)) {
        map.set(pid, { id: pid, title: job.projectTitle || '未命名项目', versionCount: 0, latest: null, createdAt: job.createdAt, updatedAt: job.createdAt });
      }
      const group = map.get(pid);
      group.versionCount += 1;
      group.updatedAt = Math.max(group.updatedAt || 0, Number(job.createdAt) || 0);
      if (!group.latest || (Number(job.version) || 0) >= (Number(group.latest.version) || 0)) group.latest = job;
    }
    const projects = Array.from(map.values()).map((group) => ({
      id: group.id,
      title: group.title,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      versionCount: group.versionCount,
      latest: group.latest ? {
        jobId: group.latest.id,
        status: group.latest.status,
        phase: group.latest.phase,
        videoUrl: group.latest.videoUrl,
        seconds: group.latest.seconds,
        bytes: group.latest.bytes,
        version: group.latest.version,
        createdAt: group.latest.createdAt,
        error: group.latest.error,
      } : null,
    }));
    projects.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
    ungrouped.sort((a, b) => (b.createdAt - a.createdAt));
    return { projects, ungrouped };
  }

  function createProjectCard() {
    const card = el('article', 'v2-card v2-project-card');
    const head = el('div', 'v2-card-head');
    const title = el('h3', 'v2-card-title');
    const toggle = el('button', 'v2-chip v2-proj-toggle');
    toggle.type = 'button';
    toggle.dataset.act = 'toggle';

    const latest = el('div', 'v2-proj-latest');
    const status = el('p', 'v2-card-status v2-proj-status');
    const latestOps = el('div', 'v2-proj-latest-ops');
    const play = el('button', 'v2-btn v2-sm v2-accent', '播放');
    play.type = 'button';
    play.dataset.act = 'play-latest';
    const download = el('a', 'v2-btn v2-sm', '下载');
    download.setAttribute('download', '');
    latestOps.appendChild(play);
    latestOps.appendChild(download);
    latest.appendChild(status);
    latest.appendChild(latestOps);

    const ops = el('div', 'v2-card-actions');
    const redo = el('button', 'v2-btn v2-sm', '重做');
    redo.type = 'button';
    redo.dataset.act = 'redo';
    const rename = el('button', 'v2-btn v2-sm', '改名');
    rename.type = 'button';
    rename.dataset.act = 'rename';
    const remove = el('button', 'v2-btn v2-sm v2-danger', '删除项目');
    remove.type = 'button';
    remove.dataset.act = 'delete';
    ops.appendChild(redo);
    ops.appendChild(rename);
    ops.appendChild(remove);

    const versions = el('div', 'v2-project-versions hidden');
    const player = el('div', 'v2-card-player v2-project-player hidden');

    head.appendChild(title);
    head.appendChild(toggle);
    card.appendChild(head);
    card.appendChild(latest);
    card.appendChild(ops);
    card.appendChild(versions);
    card.appendChild(player);

    return {
      root: card,
      title,
      toggle,
      status,
      latestOps,
      play,
      download,
      ops,
      redo,
      rename,
      remove,
      versions,
      player,
      group: null,
      expanded: false,
      loadedCount: -1,
      loading: false,
    };
  }

  function updateProjectCard(node, group) {
    node.group = group;
    const ungrouped = group.kind === 'ungrouped';
    const latest = group.latest || null;
    node.title.textContent = group.title || '未命名视频';
    node.root.classList.toggle('v2-project-ungrouped', ungrouped);
    node.root.dataset.project = group.id || '';

    const count = Number(group.versionCount) || 0;
    const arrow = node.expanded ? '▴' : '▾';
    node.toggle.textContent = ungrouped ? `${count} 条旧任务 ${arrow}` : `${count} 个版本 ${arrow}`;
    node.toggle.setAttribute('aria-expanded', String(node.expanded));

    if (!latest) {
      node.status.textContent = '还没有版本：在「做视频」选这个项目，提交一版';
      node.status.className = 'v2-card-status v2-proj-status';
    } else {
      node.status.textContent = versionLine(latest, { ungrouped });
      node.status.className = `v2-card-status v2-proj-status${latest.status === 'failed' ? ' failed' : ''}${latest.status === 'done' ? ' done' : ''}`;
    }

    const done = Boolean(latest && latest.status === 'done' && latest.videoUrl);
    node.play.classList.toggle('hidden', !done);
    node.download.classList.toggle('hidden', !done);
    if (done) node.download.href = mediaHref({ id: latest.jobId }, false);

    // 旧任务/未分组：能播能下，但不提供「重做」（服务端不会把重做挂回项目）
    node.redo.classList.toggle('hidden', ungrouped || !latest || !isTerminal(latest));
    node.rename.classList.toggle('hidden', ungrouped);
    node.remove.classList.toggle('hidden', ungrouped);

    // 展开中：版本数变了就重拉列表（有新版/REDO 完成时）
    // 未分组没有详情接口：用任务 id 拼个签名，只有真变了才重画，不然 2 秒一次的轮询
    // 会把正在播的 <video> 一起冲掉。
    if (node.expanded) {
      if (ungrouped) {
        const signature = state.ungrouped.map((job) => job.jobId || job.id).join(',');
        if (signature !== node.ungroupedSig) {
          node.ungroupedSig = signature;
          renderVersionRows(node, state.ungrouped, { ungrouped: true });
        }
      } else if (node.loadedCount !== count && !node.loading) {
        loadProjectVersions(node);
      }
    }
  }

  function renderProjects(groups) {
    state.projects = (groups && Array.isArray(groups.projects)) ? groups.projects : [];
    state.ungrouped = (groups && Array.isArray(groups.ungrouped)) ? groups.ungrouped : [];

    const all = state.projects.map((project) => ({ kind: 'project', ...project }));
    if (state.ungrouped.length) {
      all.push({
        kind: 'ungrouped',
        id: '',
        title: '未分组',
        versionCount: state.ungrouped.length,
        latest: state.ungrouped[0],
        createdAt: state.ungrouped[0] ? state.ungrouped[0].createdAt : 0,
        updatedAt: state.ungrouped[0] ? state.ungrouped[0].createdAt : 0,
      });
    }

    const keep = new Set(all.map((group) => group.id || '__ungrouped__'));
    for (const [key, node] of state.projectCards) {
      if (!keep.has(key)) {
        node.root.remove();
        state.projectCards.delete(key);
      }
    }

    all.forEach((group, index) => {
      const key = group.id || '__ungrouped__';
      let node = state.projectCards.get(key);
      if (!node) {
        node = createProjectCard();
        state.projectCards.set(key, node);
      }
      updateProjectCard(node, group);
      const at = els.jobsList.children[index];
      if (at !== node.root) els.jobsList.insertBefore(node.root, at || null);
    });

    els.jobsEmpty.classList.toggle('hidden', all.length > 0);
    els.jobsEmpty.textContent = '还没有任务。去「做视频」开一条吧。';
    const running = all.filter((group) => group.latest && isActive(group.latest)).length;
    els.jobsSummary.textContent = all.length
      ? `${all.length} 个项目${running ? ` · ${running} 个在跑` : ''}`
      : '还没有项目';
    syncProjectRow();
  }

  /** 展开某张卡：拉一次详情，按「最新在上」列出所有版本。 */
  async function loadProjectVersions(node) {
    const group = node.group;
    if (!group || !group.id || node.loading) return;
    node.loading = true;
    try {
      const data = await api(`/api/v2/projects/${encodeURIComponent(group.id)}`);
      const jobs = (Array.isArray(data.jobs) ? data.jobs : []).slice().reverse();
      renderVersionRows(node, jobs, { ungrouped: false });
      node.loadedCount = Number(group.versionCount) || jobs.length;
    } catch (err) {
      node.versions.textContent = errText(err);
    } finally {
      node.loading = false;
    }
  }

  function versionRow(job, options) {
    const opts = options || {};
    const row = el('div', 'v2-ver-row');
    const label = el('span', 'v2-ver-label', versionLine(job, opts));
    const ops = el('span', 'v2-ver-ops');
    const done = job.status === 'done' && (job.videoUrl || job.jobId || job.id);
    const play = el('button', 'v2-btn v2-sm', '播放');
    play.type = 'button';
    play.dataset.act = 'play-ver';
    const download = el('a', 'v2-btn v2-sm', '下载');
    download.setAttribute('download', '');
    const id = job.jobId || job.id;
    download.href = mediaHref({ id }, false);
    play.classList.toggle('hidden', !done);
    download.classList.toggle('hidden', !done);
    ops.appendChild(play);
    ops.appendChild(download);
    const player = el('div', 'v2-ver-player hidden');
    row.appendChild(label);
    row.appendChild(ops);
    row.appendChild(player);
    row.dataset.job = id || '';
    return row;
  }

  function renderVersionRows(node, jobs, options) {
    const opts = options || {};
    node.versions.textContent = '';
    const list = Array.isArray(jobs) ? jobs : [];
    if (!list.length) {
      node.versions.appendChild(el('p', 'v2-hint', '这个项目还没有版本'));
      return;
    }
    for (const job of list) node.versions.appendChild(versionRow(job, opts));
  }

  /** 展开/收起：第一次展开才发请求，之后靠版本数变化自动刷新。 */
  function toggleProjectCard(node) {
    node.expanded = !node.expanded;
    node.versions.classList.toggle('hidden', !node.expanded);
    const count = node.group ? Number(node.group.versionCount) || 0 : 0;
    const arrow = node.expanded ? '▴' : '▾';
    if (node.group) {
      node.toggle.textContent = node.group.kind === 'ungrouped'
        ? `${count} 条旧任务 ${arrow}`
        : `${count} 个版本 ${arrow}`;
    }
    node.toggle.setAttribute('aria-expanded', String(node.expanded));
    if (!node.expanded) return;
    if (node.group && node.group.kind === 'ungrouped') {
      // 记下这次渲染对应的任务集合：下一次轮询签名没变就不会重画，正在播的视频才不会被冲掉
      node.ungroupedSig = state.ungrouped.map((job) => job.jobId || job.id).join(',');
      renderVersionRows(node, state.ungrouped, { ungrouped: true });
      return;
    }
    loadProjectVersions(node);
  }

  /** 卡片里的播放：mp4 直接塞进卡片，旧版本也能看。 */
  function playInline(container, jobId) {
    if (!container || !jobId) return;
    let video = container.querySelector('video');
    if (!video) {
      video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      container.appendChild(video);
    }
    const href = mediaHref({ id: jobId }, false);
    if (video.getAttribute('src') !== href) video.src = href;
    container.classList.remove('hidden');
    const played = video.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
    container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ---------- 做视频页：项目下拉 ---------- */

  /** 从准备提交的内容里猜一个项目名（和服务端 deriveTitle 的优先级一致）。 */
  function guessProjectTitle(body) {
    const scenes = Array.isArray(body.scenes) ? body.scenes : [];
    for (const scene of scenes) {
      const text = String((scene && scene.text) || '').trim();
      if (text) return text.slice(0, 60);
    }
    const topic = String(body.topic || '').trim();
    if (topic) return (topic.split(/\n/).map((s) => s.trim()).find(Boolean) || topic).slice(0, 60);
    const script = String(body.script || '').trim();
    if (script) {
      const first = script.split(/[。！？!?\n\r]/).map((s) => s.trim()).find(Boolean);
      if (first) return first.slice(0, 60);
    }
    return '';
  }

  /** 提交前把项目定下来：选了现有项目就用它，否则先建一个（对应「+ 新建项目」）。 */
  async function ensureProject(body) {
    if (state.projectId) return state.projectId;
    const title = guessProjectTitle(body);
    const data = await api('/api/v2/projects', { method: 'POST', body: title ? { title } : {} });
    if (!data.projectId) throw new ApiError('新建项目没返回 id', 502, '');
    return String(data.projectId);
  }

  /** 下拉选项：第一项永远是「+ 新建项目」，后面跟现有项目（带版本数）。 */
  function syncProjectRow() {
    if (!els.projectSel) return;
    const signature = state.projects.map((p) => `${p.id}:${p.title}:${p.versionCount}`).join('|');
    // 一个项目都没有时 signature 是空串：也得建出「+ 新建项目」这一项
    if (signature !== state.projectSig || !els.projectSel.options.length) {
      state.projectSig = signature;
      const current = state.projectId;
      els.projectSel.textContent = '';
      const fresh = document.createElement('option');
      fresh.value = '';
      fresh.textContent = '+ 新建项目';
      els.projectSel.appendChild(fresh);
      for (const project of state.projects) {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = `${project.title || '未命名视频'}（${project.versionCount || 0} 版）`;
        els.projectSel.appendChild(option);
      }
      // 正在重做的项目可能不在前 50 条里：补一个选项，别把下拉搞成空的
      if (state.redoFrom && state.redoProjectId && !state.projects.some((p) => p.id === state.redoProjectId)) {
        const option = document.createElement('option');
        option.value = state.redoProjectId;
        option.textContent = `${state.redoProjectTitle || '原项目'}（重做）`;
        els.projectSel.appendChild(option);
      }
      state.projectId = current;
    }

    const redo = Boolean(state.redoFrom);
    els.projectSel.disabled = redo;
    if (redo) els.projectSel.value = state.redoProjectId || '';
    else els.projectSel.value = state.projectId || '';
    // 选中的项目已经被删掉：回到「+ 新建项目」
    if (!redo && state.projectId && els.projectSel.value !== state.projectId) {
      state.projectId = '';
      els.projectSel.value = '';
    }

    if (!els.projectHint) return;
    if (redo) {
      els.projectHint.textContent = state.redoProjectId
        ? `重做会加到原项目「${state.redoProjectTitle || '上一个'}」的下一个版本`
        : '这条旧任务没有项目，重做会生成一条「未分组」的新任务';
      return;
    }
    if (state.projectId) {
      const project = state.projects.find((p) => p.id === state.projectId);
      const count = project ? project.versionCount : 0;
      els.projectHint.textContent = `会加到「${project ? project.title : '所选项目'}」，成为 v${count + 1}`;
      return;
    }
    els.projectHint.textContent = '默认新建项目，标题从内容里取';
  }

  function onProjectSelect() {
    if (!els.projectSel) return;
    state.projectId = els.projectSel.value || '';
    syncProjectRow();
  }

  /* ---------- 项目卡片操作 ---------- */

  function projectOf(node) {
    return node && node.group ? node.group : null;
  }

  async function onRenameProject(node) {
    const group = projectOf(node);
    if (!group || !group.id) return;
    const next = window.prompt('项目新名字', group.title || '');
    if (next == null) return;
    const title = String(next).trim();
    if (!title) return;
    try {
      await api(`/api/v2/projects/${encodeURIComponent(group.id)}`, { method: 'POST', body: { title } });
      toast(`项目改名为「${title}」`);
      pollJobs();
    } catch (err) {
      toast(errText(err));
    }
  }

  async function onDeleteProject(node) {
    const group = projectOf(node);
    if (!group || !group.id) return;
    const ok = window.confirm(`删除项目「${group.title}」？它的 ${group.versionCount || 0} 个版本和 mp4 都会一起删掉。`);
    if (!ok) return;
    try {
      const data = await api(`/api/v2/projects/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
      const mb = (Number(data.freedBytes) || 0) / 1048576;
      toast(`已删除项目「${group.title}」${data.jobIds && data.jobIds.length ? `（${data.jobIds.length} 个版本）` : ''}，释放 ${mb.toFixed(1)}MB`);
      node.root.remove();
      state.projectCards.delete(group.id);
      if (state.projectId === group.id) state.projectId = '';
      pollJobs();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PROJECT_BUSY') toast('这个项目还有版本在跑，等它完成再删');
      else toast(errText(err));
    }
  }

  /** 任务页所有点击都走这一处委托：卡片和版本行都能点到。 */
  function onJobsClick(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const card = button.closest('.v2-project-card');
    if (!card) return;
    const key = card.dataset.project || '__ungrouped__';
    const node = state.projectCards.get(key);
    if (!node) return;
    const act = button.dataset.act;
    const latest = node.group && node.group.latest;

    if (act === 'toggle') {
      toggleProjectCard(node);
      return;
    }
    if (act === 'play-latest') {
      if (latest && latest.jobId) playInline(node.player, latest.jobId);
      return;
    }
    if (act === 'redo') {
      if (latest && latest.jobId) onRedo({ id: latest.jobId, projectId: node.group.id });
      return;
    }
    if (act === 'rename') {
      onRenameProject(node);
      return;
    }
    if (act === 'delete') {
      onDeleteProject(node);
      return;
    }
    if (act === 'play-ver') {
      const row = button.closest('.v2-ver-row');
      if (row && row.dataset.job) playInline(row.querySelector('.v2-ver-player'), row.dataset.job);
    }
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
    // 任务页现在是项目卡，状态靠 2 秒轮询刷新；这里只负责「刚提交的那张卡」的秒表
    if (state.current && state.current.job && isActive(state.current.job)) {
      state.current.status.textContent = buildStatusText(state.current);
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
      // 一次拿两份：任务列表（当前任务/未分组兜底）+ 项目分组（任务页的卡片）
      const [data, projectData] = await Promise.all([
        api('/api/v2/jobs'),
        api('/api/v2/projects').catch((err) => {
          if (err instanceof ApiError && err.status === 401) throw err;
          return null; // 老服务端没有项目接口：用任务列表在本地分组
        }),
      ]);
      setOnline('online', '在线');
      const jobs = (Array.isArray(data.jobs) ? data.jobs : [])
        .filter((job) => job && job.id)
        .slice(0, JOBS_LIMIT)
        .map((job) => {
          state.jobs.set(job.id, job);
          return job;
        });
      const groups = projectData && Array.isArray(projectData.projects)
        ? {
          projects: projectData.projects,
          ungrouped: Array.isArray(projectData.ungrouped) ? projectData.ungrouped : [],
        }
        : groupsFromJobs(jobs);
      renderProjects(groups);

      // 当前任务如果已经在列表里，顺手把卡片刷新一下（不额外发单条请求）
      if (state.currentJobId && !state.timers.poll) {
        const known = state.jobs.get(state.currentJobId);
        if (known && state.current) updateCurrent(known);
      }

      const active = jobs.some(isActive)
        || groups.projects.some((project) => project.latest && isActive(project.latest))
        || groups.ungrouped.some(isActive);
      if (state.view === 'jobs' && active) ensureListPoll();
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
      // manim 代码是按哪份 text/hint/tool 生成的；一变就作废（见 sceneCodeKey）
      manimKey: '',
      status: '',
      note: '',
      dirty: true,
    };
  }

  function loadScenes(scenes) {
    state.scenes = (Array.isArray(scenes) ? scenes : []).map((scene) => {
      const source = scene && typeof scene === 'object' ? scene : {};
      const tool = source.tool === 'manim' || source.tool === 'text' || source.tool === 'sticker'
        ? source.tool
        : 'auto';
      const item = {
        text: String(source.text || ''),
        narration: String(source.narration || ''),
        seconds: Math.min(15, Math.max(1, Number(source.seconds) || 5)),
        hint: String(source.hint || ''),
        tool,
        // 每场最多 1 个：旧任务里多带的这里也裁掉，面板显示 1/1
        stickers: Array.isArray(source.stickers) ? source.stickers.slice(0, 1) : [],
        image: String(source.image || ''),
        manim: source.manim && typeof source.manim === 'object' ? source.manim : null,
        status: String(source.status || ''),
        note: String(source.note || ''),
        // 从旧任务载入的分镜先当作「干净」；用户一改就标脏
        dirty: Boolean(source.dirty),
      };
      // 记下这份代码是按哪份 text/hint/tool 生成的；用户只改旁白时它仍然有效
      item.manimKey = sceneCodeKey(item);
      return item;
    });
    renderScenes();
  }

  /** 一场有没有内容：标题或旁白任一非空就值得提交（只有旁白也能让后端兜底出标题）。 */
  function sceneHasContent(scene) {
    return Boolean(scene && (String(scene.text || '').trim() || String(scene.narration || '').trim()));
  }

  function sceneCountBadge() {
    const n = state.scenes.filter(sceneHasContent).length;
    els.sceneCount.textContent = `${n} 场`;
    els.sceneCount.classList.toggle('hidden', !n);
    els.scenesEmpty.classList.toggle('hidden', state.scenes.length > 0);
    els.scenesTable.classList.toggle('hidden', state.scenes.length === 0);
  }

  /** 工具下拉补一项「表情卡」：index.html 里已经有了，这段兜住旧缓存/旧模板。 */
  function ensureToolOptions(select) {
    if (!select) return;
    if (select.querySelector('option[value="sticker"]')) return;
    const opt = document.createElement('option');
    opt.value = 'sticker';
    opt.textContent = '表情卡';
    select.appendChild(opt);
  }

  function stickerGifUrl(id) {
    return `/api/stickers/gif?id=${encodeURIComponent(String(id || ''))}`;
  }

  /** 情绪名优先；没有就用文件名去掉 .gif；再没有就用 id 前 6 位。 */
  function stickerMood(item) {
    const mood = String((item && item.mood) || '').trim();
    if (mood) return mood;
    const name = String((item && item.name) || '').trim().replace(/\.gif$/i, '');
    if (name) return name;
    return String((item && item.id) || '').slice(0, 6);
  }

  function stickerById(id) {
    const wanted = String(id || '').toLowerCase();
    return state.stickerOptions.find((item) => item.id === wanted) || null;
  }

  /** 表情候选：面板自带的 /api/stickers（转发 sticker 模块），收藏排前面。 */
  async function loadStickers() {
    try {
      const data = await api('/api/stickers?limit=300');
      const items = Array.isArray(data.items) ? data.items : [];
      const seen = new Set();
      const options = items.map((item) => {
        const id = String((item && item.id) || '').trim().toLowerCase();
        return {
          id,
          mood: stickerMood(item),
          name: String((item && item.name) || ''),
          favorite: Boolean(item && item.favorite),
        };
      }).filter((item) => {
        if (!/^[0-9a-f]{6,40}$/i.test(item.id) || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
      // 收藏优先；sort 是稳定排序，同组内保持后端给的顺序
      options.sort((a, b) => Number(b.favorite) - Number(a.favorite));
      state.stickerOptions = options;
      state.stickersLoaded = true;
    } catch (err) {
      // 拉不到就保留旧目录，不把用户已选的表情弄丢
      state.stickersLoaded = state.stickerOptions.length > 0;
    }
    if (state.scenes.length) renderScenes();
    if (state.stickerModalOpen) renderStickerGrid();
  }

  /** 分镜表「表情」格：没选 = 一个「＋ 表情」；选了 = 48×48 动图缩略图 + 情绪名 + ×。 */
  function renderStickerCell(cell, scene, index) {
    if (!cell) return;
    cell.textContent = '';
    const chosen = Array.isArray(scene.stickers) && scene.stickers[0] ? scene.stickers[0] : null;
    if (!chosen) {
      const add = el('button', 'v2-sticker-empty', '＋ 表情');
      add.type = 'button';
      add.title = '选一个表情（每场最多 1 个）';
      add.addEventListener('click', (event) => {
        event.preventDefault();
        openStickerPicker(index);
      });
      cell.appendChild(add);
      return;
    }

    const id = String(chosen.id || '').toLowerCase();
    const item = stickerById(id);
    const mood = item ? item.mood : (String(chosen.mood || '').trim() || id.slice(0, 6));
    const chip = el('div', 'v2-sticker-chip');
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.title = `当前表情：${mood}；点击换一个`;

    const img = document.createElement('img');
    img.className = 'v2-sticker-thumb';
    img.width = 48;
    img.height = 48;
    img.loading = 'lazy';
    img.alt = mood;
    img.src = stickerGifUrl(id);
    img.addEventListener('error', () => img.classList.add('v2-sticker-thumb-error'));

    const name = el('span', 'v2-sticker-name', mood);
    const clear = el('button', 'v2-sticker-clear', '×');
    clear.type = 'button';
    clear.title = '清除这个表情';

    const open = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      openStickerPicker(index);
    };
    chip.addEventListener('click', open);
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open(event);
    });
    clear.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      scene.stickers = [];
      markSceneDirty(cell.closest('.v2-scene-row'), scene);
      renderStickerCell(cell, scene, index);
      toast('表情已清除');
    });

    chip.appendChild(img);
    chip.appendChild(name);
    chip.appendChild(clear);
    cell.appendChild(chip);
  }

  function openStickerPicker(index) {
    const scene = state.scenes[index];
    if (!scene || !els.stickerModal) return;
    state.stickerTarget = index;
    state.stickerModalOpen = true;
    els.stickerModal.classList.remove('hidden');
    if (els.stickerSearch) els.stickerSearch.value = '';
    renderStickerGrid();
    if (!state.stickersLoaded) loadStickers();
    window.setTimeout(() => {
      if (els.stickerSearch) els.stickerSearch.focus();
    }, 0);
  }

  function closeStickerPicker() {
    state.stickerModalOpen = false;
    state.stickerTarget = -1;
    if (els.stickerModal) els.stickerModal.classList.add('hidden');
  }

  /** 选择器网格：每格都是 GIF 动图，下面情绪名，右上角收藏星。 */
  function renderStickerGrid() {
    if (!els.stickerGrid) return;
    const query = String((els.stickerSearch && els.stickerSearch.value) || '').trim().toLowerCase();
    const all = state.stickerOptions;
    const target = state.stickerTarget >= 0 ? state.scenes[state.stickerTarget] : null;
    const selectedId = target && Array.isArray(target.stickers) && target.stickers[0]
      ? String(target.stickers[0].id || '').toLowerCase()
      : '';

    els.stickerGrid.textContent = '';
    if (!all.length) {
      if (els.stickerHint) {
        els.stickerHint.textContent = state.stickersLoaded
          ? '表情清单是空的：sticker 模块可能没起来'
          : '正在加载表情…';
      }
      if (els.stickerSummary) els.stickerSummary.textContent = '';
      return;
    }

    const list = query
      ? all.filter((item) => `${item.mood} ${item.name}`.toLowerCase().includes(query))
      : all;
    if (!list.length) {
      if (els.stickerHint) els.stickerHint.textContent = '没有匹配的表情，换个词试试';
      if (els.stickerSummary) els.stickerSummary.textContent = `0/${all.length} 个`;
      return;
    }

    for (const item of list) {
      const btn = el('button', 'v2-sticker-item');
      btn.type = 'button';
      btn.dataset.id = item.id;
      btn.title = `${item.mood} · 点击选中`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', item.id === selectedId ? 'true' : 'false');
      btn.classList.toggle('is-selected', item.id === selectedId);

      const img = document.createElement('img');
      img.className = 'v2-sticker-gif';
      img.loading = 'lazy';
      img.alt = item.mood;
      img.src = stickerGifUrl(item.id);

      const mood = el('span', 'v2-sticker-mood', item.mood);
      const star = el('span', 'v2-sticker-star', item.favorite ? '★' : '☆');
      star.classList.toggle('on', item.favorite);
      star.setAttribute('role', 'button');
      star.tabIndex = 0;
      star.title = item.favorite ? '取消收藏' : '收藏这张';
      star.setAttribute('aria-pressed', item.favorite ? 'true' : 'false');
      const toggle = (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleStickerFavorite(item, star);
      };
      star.addEventListener('click', toggle);
      star.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') toggle(event);
      });

      btn.appendChild(img);
      btn.appendChild(mood);
      btn.appendChild(star);
      btn.addEventListener('click', (event) => {
        if (event.target.closest('.v2-sticker-star')) return;
        chooseSticker(item);
      });
      els.stickerGrid.appendChild(btn);
    }

    if (els.stickerSummary) {
      els.stickerSummary.textContent = `${list.length}/${all.length} 个 · 收藏 ${all.filter((item) => item.favorite).length}`;
    }
    if (els.stickerHint) {
      els.stickerHint.textContent = '点一张选中；★ 收藏；每场只能有 1 个表情';
    }
  }

  async function toggleStickerFavorite(item, star) {
    if (!item || !item.id) return;
    const want = !item.favorite;
    try {
      if (want) {
        await api('/api/stickers/favorite', {
          method: 'POST',
          body: { id: item.id, name: item.mood },
        });
      } else {
        await api(`/api/stickers/favorite?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      }
      item.favorite = want;
      if (star) {
        star.textContent = want ? '★' : '☆';
        star.classList.toggle('on', want);
        star.title = want ? '取消收藏' : '收藏这张';
        star.setAttribute('aria-pressed', want ? 'true' : 'false');
      }
      if (els.stickerSummary) {
        els.stickerSummary.textContent = `${state.stickerOptions.length} 个 · 收藏 ${state.stickerOptions.filter((it) => it.favorite).length}`;
      }
      if (els.stickerHint) els.stickerHint.textContent = want ? `已收藏「${item.mood}」` : `已取消收藏「${item.mood}」`;
    } catch (err) {
      toast(errText(err));
    }
  }

  /** 选中：立刻替换这一场的缩略图，并关掉选择器。 */
  function chooseSticker(item) {
    const index = state.stickerTarget;
    const scene = state.scenes[index];
    if (!scene || !item) return;
    scene.stickers = [{ id: item.id, at: 1.2, x: 0.82, y: 0.12, scale: 0.3 }];
    scene.dirty = true;
    const row = els.scenesBody.querySelector(`.v2-scene-row[data-i="${index}"]`);
    if (row) {
      row.dataset.dirty = '1';
      renderStickerCell(row.querySelector('.v2-scene-sticker-cell'), scene, index);
    }
    closeStickerPicker();
    toast(`已选表情：${item.mood}`);
  }

  function markSceneDirty(row, scene) {
    if (!scene) return;
    scene.dirty = true;
    if (row) row.dataset.dirty = '1';
  }

  /**
   * 一场「画面代码」的身份：和 studio-v2 的代码缓存键同源（text + hint + tool）。
   * 只放会影响画面的字段；旁白、秒数、表情不参与，所以只改旁白不会让代码作废。
   */
  function sceneCodeKey(scene) {
    if (!scene) return '';
    return [
      String(scene.text || '').trim().slice(0, 80),
      String(scene.hint || '').trim().slice(0, 600),
      String(scene.tool || 'auto'),
    ].join('\u0001');
  }

  /**
   * 改过 text/hint/tool 就把这一场的 manim 代码丢掉。
   * 不丢的话重做请求会把旧代码原样带回去，studio-v2 认「标题没变」就沿用旧画面，
   * 于是出现「旁白换了、画面一模一样」。
   */
  function dropSceneCode(scene) {
    if (!scene) return;
    scene.manim = null;
    scene.manimKey = '';
  }

  function renderScenes() {
    const tpl = $('#v2SceneRowTpl');
    if (!tpl) return;
    els.scenesBody.textContent = '';
    state.scenes.forEach((scene, index) => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.i = String(index);
      row.dataset.dirty = scene.dirty ? '1' : '0';
      row.querySelector('.v2-scene-idx').textContent = String(index + 1);
      const text = row.querySelector('[data-field="text"]');
      const narration = row.querySelector('[data-field="narration"]');
      const seconds = row.querySelector('[data-field="seconds"]');
      const tool = row.querySelector('[data-field="tool"]');
      const hint = row.querySelector('[data-field="hint"]');
      text.value = scene.text;
      narration.value = scene.narration;
      seconds.value = String(Math.round(scene.seconds));
      ensureToolOptions(tool);
      tool.value = scene.tool;
      hint.value = scene.hint;
      renderStickerCell(row.querySelector('.v2-scene-sticker-cell'), scene, index);
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
      scene.tool = target.value === 'manim' || target.value === 'text' || target.value === 'sticker'
        ? target.value
        : 'auto';
      if (scene.tool === 'sticker' && !(Array.isArray(scene.stickers) && scene.stickers.length)) {
        toast('表情卡要先选一个表情；没选会降级成文字卡');
      }
    } else if (field === 'text' || field === 'hint' || field === 'narration') {
      scene[field] = target.value;
    }
    // 画面三要素之一变了：立刻作废这一场的 manim 代码（旁白/秒数不受影响）
    if (field === 'text' || field === 'hint' || field === 'tool') dropSceneCode(scene);
    markSceneDirty(row, scene);
    sceneCountBadge();
  }

  function collectScenes() {
    return state.scenes
      .filter(sceneHasContent)
      .map((scene) => ({
        text: String(scene.text || '').trim(),
        narration: String(scene.narration || ''),
        seconds: Math.min(15, Math.max(1, Number(scene.seconds) || 5)),
        hint: String(scene.hint || ''),
        tool: scene.tool === 'manim' || scene.tool === 'text' || scene.tool === 'sticker'
          ? scene.tool
          : 'auto',
        stickers: Array.isArray(scene.stickers) ? scene.stickers.slice(0, 1) : [],
        image: String(scene.image || ''),
        // 只有代码和当前 text/hint/tool 对得上才回传：对不上就交给后端重新生成
        manim: scene.manim && typeof scene.manim === 'object' && scene.manimKey === sceneCodeKey(scene)
          ? scene.manim
          : null,
        // 面板自己的脏标记：studio-v2 会忽略未知字段，这里留着方便验收脚本看
        dirty: Boolean(scene.dirty),
      }));
  }

  /* ---------- 提交 / 重做 ---------- */

  function showHint(text, isError) {
    els.submitHint.textContent = text || '';
    els.submitHint.className = `v2-hint${isError ? ' v2-error' : ''}`;
  }

  function updateModeHint() {
    const text = els.topicInput.value.trim();
    const sceneCount = state.scenes.filter(sceneHasContent).length;
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

  /** 四个可调项：提交与重做都带上，服务端会再夹一次范围。 */
  function tunableBody() {
    return {
      narrationSpeed: Number(state.prefs.narrationSpeed),
      voicePitch: Number(state.prefs.voicePitch),
      scenePadding: Number(state.prefs.scenePadding),
      stickerDuration: Number(state.prefs.stickerDuration),
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

    // 四个可调项不分新建/重做都带：重做时可以只改语速或音高
    Object.assign(body, tunableBody());

    // 「跟人设」就省略，让 studio-v2 按人设补；手工选了才带上
    if (kind !== 'redo') {
      if (state.prefs.style) body.style = state.prefs.style;
      if (state.prefs.voice) body.voice = state.prefs.voice;
    }

    state.submitting = true;
    setBusy(true);
    // 用户显式选过的项目：提交成功后保留，方便接着加下一版；没选（+ 新建项目）就保持新建
    const explicitProject = state.projectId;
    try {
      // 项目：重做由服务端沿用原任务的项目；新建时选了现有项目就带上，没选就先建一个
      if (kind !== 'redo') {
        const projectId = await ensureProject(body);
        if (projectId) body.projectId = projectId;
      }
      const data = await api(path, { method: 'POST', body });
      if (!data.jobId) throw new ApiError('服务没返回任务 id', 502, '');
      const job = placeholderJob(String(data.jobId), body);
      state.currentJobId = job.id;
      mountCurrent(job);
      setOnline('online', '在线');
      const projectTitle = String(data.projectTitle || '');
      const version = Number(data.version) || 0;
      showHint(`已提交 · 任务 ${job.id}${projectTitle ? ` · 项目「${projectTitle}」v${version}` : ''}`);
      state.projectId = explicitProject;
      if (kind === 'redo') {
        // 重做已提交，旧分镜不能留着劫持下一次「开始做」
        state.redoFrom = '';
        state.redoProjectId = '';
        state.redoProjectTitle = '';
        hideRedoBanner();
        loadScenes([]);
        updateModeHint();
      }
      syncProjectRow();
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
      // 重做沿用原任务的项目：下拉锁在这个项目上，提交时不带 projectId（服务端自己沿用）
      state.redoProjectId = String(full.projectId || job.projectId || '');
      state.redoProjectTitle = String(full.projectTitle || job.projectTitle || '');
      loadScenes(full.scenes);
      els.advanced.open = true;
      showRedoBanner(full);
      switchView('make');
      syncProjectRow();
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
    if (!select) return;
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
    // 四个可调项：只接受下拉里列出的值，非法/越界回默认
    const narrationSpeed = pickNumber(raw.narrationSpeed, SPEED_OPTIONS, DEFAULT_PREFS.narrationSpeed);
    const voicePitch = pickNumber(raw.voicePitch, PITCH_OPTIONS, DEFAULT_PREFS.voicePitch);
    const scenePadding = pickNumber(raw.scenePadding, PADDING_OPTIONS, DEFAULT_PREFS.scenePadding);
    const stickerDuration = pickNumber(raw.stickerDuration, STICKER_OPTIONS, DEFAULT_PREFS.stickerDuration);
    state.prefs = { style, voice, narrationSpeed, voicePitch, scenePadding, stickerDuration };
  }

  /** localStorage 里是任意字符串，只认下拉里的离散值。 */
  function pickNumber(value, options, fallback) {
    const n = Number(value);
    return options.some((option) => option.value === n) ? n : fallback;
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
      if (els.saveHint) els.saveHint.textContent = '已保存到本机';
    } catch (err) {
      if (els.saveHint) els.saveHint.textContent = '这个浏览器存不了设置（隐私模式？）';
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
    fillSelect(els.setSpeed, SPEED_OPTIONS, state.prefs.narrationSpeed);
    fillSelect(els.setPitch, PITCH_OPTIONS, state.prefs.voicePitch);
    fillSelect(els.setPadding, PADDING_OPTIONS, state.prefs.scenePadding);
    fillSelect(els.setSticker, STICKER_OPTIONS, state.prefs.stickerDuration);
    updateTunablesHint();
  }

  /** 高级区一行汇总，让用户不用切回设置页也知道当前节奏参数。 */
  function updateTunablesHint() {
    if (!els.advTunablesHint) return;
    const speed = Number(state.prefs.narrationSpeed).toFixed(1);
    const pitch = Number(state.prefs.voicePitch);
    const pitchText = pitch === 0 ? '原声' : `${pitch > 0 ? '+' : ''}${pitch.toFixed(1)} 半音`;
    const padding = Number(state.prefs.scenePadding).toFixed(1);
    const sticker = Number(state.prefs.stickerDuration).toFixed(1);
    els.advTunablesHint.textContent = `语速 ${speed}× · 音高 ${pitchText} · 停留 ${padding} 秒 · 表情一轮 ${sticker} 秒（循环播放，在设置页改）`;
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
    if (name === 'settings') {
      // 每次进设置页都确认四行还在：静态 HTML + JS 兜底都走这里
      mountTunableDom();
      applyPrefs();
    }
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
    bindTunableRow(els.setSpeed, 'narrationSpeed');
    bindTunableRow(els.setPitch, 'voicePitch');
    bindTunableRow(els.setPadding, 'scenePadding');
    bindTunableRow(els.setSticker, 'stickerDuration');

    // 表情选择器：点背景 / ✕ / Esc 关闭，搜索框即时过滤
    if (els.stickerModal) {
      if (els.stickerClose) els.stickerClose.addEventListener('click', closeStickerPicker);
      els.stickerModal.addEventListener('click', (event) => {
        if (event.target === els.stickerModal) closeStickerPicker();
      });
      if (els.stickerSearch) {
        els.stickerSearch.addEventListener('input', renderStickerGrid);
        els.stickerSearch.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') closeStickerPicker();
        });
      }
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.stickerModalOpen) closeStickerPicker();
    });

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

    // 项目下拉 + 任务页项目卡（展开/播放/重做/改名/删除）都走委托
    if (els.projectSel) els.projectSel.addEventListener('change', onProjectSelect);
    els.jobsList.addEventListener('click', onJobsClick);

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
      projectRow: $('#v2ProjectRow'),
      projectSel: $('#v2ProjectSel'),
      projectHint: $('#v2ProjectHint'),
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
      setSpeed: $('#v2SetSpeed'),
      setPitch: $('#v2SetPitch'),
      setPadding: $('#v2SetPadding'),
      setSticker: $('#v2SetSticker'),
      advTunablesHint: $('#v2AdvTunablesHint'),
      voiceHint: $('#v2VoiceHint'),
      saveHint: $('#v2SaveHint'),
      jobsList: $('#v2JobsList'),
      jobsEmpty: $('#v2JobsEmpty'),
      jobsSummary: $('#v2JobsSummary'),
      refreshJobs: $('#v2RefreshJobs'),
      stickerModal: $('#v2StickerModal'),
      stickerGrid: $('#v2StickerGrid'),
      stickerSearch: $('#v2StickerSearch'),
      stickerSummary: $('#v2StickerSummary'),
      stickerHint: $('#v2StickerHint'),
      stickerClose: $('#v2StickerClose'),
      toast: $('#v2Toast'),
    };
  }

  /**
   * 四个可调项：index.html 里已经是静态四行，这里只做兜底——
   * 合并后的 HTML 要是缺了哪一行（或整张设置卡），切到设置页时补出来，
   * 不再依赖 init() 是否跑过。幂等，重复调用不会出现第二份。
   */
  function mountTunableDom() {
    let card = $('#v2SetVoice') ? $('#v2SetVoice').closest('.v2-settings-card') : null;

    // 整张设置卡都没有：直接在设置视图里建一张，保证四行有地方放
    if (!card) {
      const view = $('#v2-view-settings');
      if (view) {
        let host = view.querySelector('.v2-settings');
        if (!host) {
          host = el('div', 'v2-settings');
          view.appendChild(host);
        }
        card = el('div', 'v2-card v2-settings-card');
        host.appendChild(card);
      }
    }

    if (card) {
      const rows = [
        { id: 'v2SetSpeed', label: '语速', note: '越快越赶，1.0 最自然' },
        { id: 'v2SetPitch', label: '音高', note: '半音：+1 更清亮，0 = 原声' },
        { id: 'v2SetPadding', label: '停留', note: '旁白说完后画面多停一会儿，想慢一点就调大' },
        { id: 'v2SetSticker', label: '表情持续', note: '表情播完一轮的时间（循环播放）' },
      ];
      const voiceRow = $('#v2SetVoice') ? $('#v2SetVoice').closest('.v2-set-row') : null;
      let anchor = voiceRow ? voiceRow.nextSibling : null;
      for (const row of rows) {
        if ($('#' + row.id)) {
          if (anchor && anchor.parentNode === card) anchor = anchor.nextSibling;
          continue;
        }
        const line = el('label', 'v2-set-row');
        line.appendChild(el('span', 'v2-set-label', row.label));
        const select = document.createElement('select');
        select.id = row.id;
        line.appendChild(select);
        line.appendChild(el('span', 'v2-set-note', row.note));
        card.insertBefore(line, anchor || null);
        anchor = line.nextSibling;
      }
    }

    if (!$('#v2AdvTunablesHint')) {
      const advRow = $('#v2Advanced .v2-adv-row');
      if (advRow) {
        const hint = el('p', 'v2-hint v2-adv-tunables');
        hint.id = 'v2AdvTunablesHint';
        advRow.insertAdjacentElement('afterend', hint);
      }
    }

    // 分镜表是 <template> 克隆出来的：改模板，每一行都会带上这行小字
    const tpl = $('#v2SceneRowTpl');
    const secInput = tpl ? tpl.content.querySelector('.v2-scene-sec') : null;
    if (secInput && !tpl.content.querySelector('.v2-scene-sec-hint')) {
      const cell = secInput.parentElement;
      if (cell) {
        cell.classList.add('v2-scene-sec-cell');
        cell.appendChild(el('span', 'v2-scene-sec-hint', '改大会让这一场多停一会儿'));
      }
    }

    // 工具下拉兜底补「表情卡」：index.html 已带，但旧缓存里可能没有
    const tplTool = tpl ? tpl.content.querySelector('[data-field="tool"]') : null;
    if (tplTool) ensureToolOptions(tplTool);

    refreshTunableEls();
  }

  /** 重新拿四个下拉的引用（DOM 被重建/兜底创建时用）。 */
  function refreshTunableEls() {
    els.setSpeed = $('#v2SetSpeed');
    els.setPitch = $('#v2SetPitch');
    els.setPadding = $('#v2SetPadding');
    els.setSticker = $('#v2SetSticker');
    els.advTunablesHint = $('#v2AdvTunablesHint');
    bindTunableRow(els.setSpeed, 'narrationSpeed');
    bindTunableRow(els.setPitch, 'voicePitch');
    bindTunableRow(els.setPadding, 'scenePadding');
    bindTunableRow(els.setSticker, 'stickerDuration');
  }

  function bindTunableRow(select, key) {
    if (!select || select.dataset.tunableBound === '1') return;
    select.dataset.tunableBound = '1';
    select.addEventListener('change', () => onPrefChange(key, Number(select.value)));
  }

  /**
   * 做视频页的「项目」一行：index.html 里已经有了，这里只做兜底。
   * 旧缓存页面没有这一行时补在输入框上面，保证项目下拉一定存在。
   */
  function mountProjectRow() {
    if ($('#v2ProjectSel')) return;
    const form = $('#v2MakeForm');
    if (!form) return;
    const row = el('div', 'v2-project-row');
    row.id = 'v2ProjectRow';
    row.appendChild(el('span', 'v2-field-label', '项目'));
    const select = document.createElement('select');
    select.id = 'v2ProjectSel';
    select.className = 'v2-project-sel';
    select.setAttribute('aria-label', '项目');
    row.appendChild(select);
    const hint = el('span', 'v2-hint v2-project-hint');
    hint.id = 'v2ProjectHint';
    row.appendChild(hint);
    const input = $('#v2TopicInput');
    form.insertBefore(row, input || form.firstChild);
  }

  function init() {
    mountTunableDom();
    mountProjectRow();
    els = collectEls();
    // 表情选择器的节点允许缺失（旧缓存页面），不影响其它功能
    const optional = new Set([
      'stickerModal', 'stickerGrid', 'stickerSearch', 'stickerSummary', 'stickerHint', 'stickerClose',
      'advTunablesHint', 'voiceHint', 'saveHint', 'projectRow', 'projectSel', 'projectHint',
    ]);
    const missing = Object.keys(els).filter((key) => !els[key] && !optional.has(key));
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
    syncProjectRow();
    loadStickers();
    loadVoices();

    // 首屏探一次服务状态；之后只在有任务/任务页时轮询
    pollJobs();
    state.timers.tick = window.setInterval(tickElapsed, TICK_MS);
    state.initialized = true;
  }

  /** 旧面板切到视频 tab、或登录成功时调用；重复调用只做刷新。 */
  function enter() {
    syncToken();
    // 先补设置页四行：这样即使前面的 init 没跑成，切到视频页也看得到
    mountTunableDom();
    mountProjectRow();
    if (!state.initialized) {
      init();
      return;
    }
    if (!els.setSpeed) refreshTunableEls();
    applyPrefs();
    syncProjectRow();
    if (!state.voicesLoaded) loadVoices();
    if (!state.stickersLoaded) loadStickers();
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
        // 项目层：任务页卡片数、每张卡的版本数/展开后渲染了几行
        projects: state.projects.length,
        ungrouped: state.ungrouped.length,
        selectedProject: state.projectId,
        redoProject: state.redoProjectId,
        cards: Array.from(state.projectCards.values()).map((node) => ({
          id: node.group ? node.group.id : '',
          title: node.group ? node.group.title : '',
          versions: node.group ? node.group.versionCount : 0,
          latest: node.group && node.group.latest ? node.group.latest.status : '',
          expanded: Boolean(node.expanded),
          rows: node.versions.querySelectorAll('.v2-ver-row').length,
        })),
        currentJobId: state.currentJobId,
        scenes: state.scenes.length,
        redoFrom: state.redoFrom,
        polling: Boolean(state.timers.poll),
        prefs: { ...state.prefs },
        tunables: {
          speed: state.prefs.narrationSpeed,
          pitch: state.prefs.voicePitch,
          padding: state.prefs.scenePadding,
          sticker: state.prefs.stickerDuration,
          rows: $$('.v2-set-row').length,
        },
        stickerCatalog: state.stickerOptions.length,
        stickerModalOpen: state.stickerModalOpen,
        sceneDetails: state.scenes.map((scene) => ({
          text: scene.text,
          narration: scene.narration,
          seconds: scene.seconds,
          hint: scene.hint,
          tool: scene.tool,
          // 这一场还带不带旧代码：改过 hint/text/tool 后应为 false
          hasCode: Boolean(scene.manim && scene.manim.code),
          stickers: Array.isArray(scene.stickers) ? scene.stickers.map((s) => String(s.id || '')) : [],
          dirty: Boolean(scene.dirty),
        })),
      };
    },
  };
})();
