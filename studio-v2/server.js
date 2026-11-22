'use strict';
/**
 * server.js -- studio-v2 路由 + 任务队列。
 *
 * 唯一契约（5 个口）：
 *   POST /v1/jobs            {topic?|script?|scenes?, seconds?, style?, voice?, fresh?, projectId?,
 *                             narrationSpeed?=1.0, scenePadding?=0.6, stickerDuration?=2.0,
 *                             voicePitch?=1.0} -> {ok, jobId, projectId, version}
 *   GET  /v1/jobs/:id        任务状态（实时进度；含 params / projectId / version 回显）
 *   GET  /v1/jobs            最近 50
 *   POST /v1/jobs/:id/redo   {scenes, narrationSpeed?, scenePadding?, stickerDuration?, voicePitch?}
 *                            -> {ok, jobId, projectId, version}
 *   GET  /v1/video/:id       mp4 字节；?srt=1 返回 srt
 *   GET  /v1/health          {ok, manim, ffmpeg}
 *
 * 项目（主题）层：一个视频主题可以重做多次，每个 job 是它的一版。
 *   POST   /v1/projects          {title?} -> {ok, projectId}
 *   GET    /v1/projects          -> {ok, projects:[...], ungrouped:[...]}
 *   GET    /v1/projects/:id      -> {ok, project, jobs:[...按版本升序]}
 *   POST   /v1/projects/:id      改名 {title} -> {ok, project}
 *   DELETE /v1/projects/:id      连带删掉它的 job 记录与 mp4 -> {ok, jobIds, freedBytes}
 * 没给 projectId 的提交会自动建一个项目；重做沿用原任务的项目。
 *
 * v2 自己不要鉴权（面板转发鉴权）；任务并发 1，排队；状态落 data-v2/jobs/。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const S = require('./schema');
const { Cache, ensureDir, readJson, writeJsonAtomic } = require('./pipeline/cache');
const { Projects } = require('./projects');
const Plan = require('./pipeline/plan');
const Render = require('./pipeline/render');
const Sub = require('./pipeline/subtitles');
const M = require('./pipeline/manim');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config-v2.json');

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const cfg = { ...raw };
  cfg.dataDir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(ROOT, cfg.dataDir);
  cfg.outDir = path.join(cfg.dataDir, 'out');
  cfg.jobsDir = path.join(cfg.dataDir, 'jobs');
  cfg.projectsDir = path.join(cfg.dataDir, 'projects');
  cfg.workDir = path.join(cfg.dataDir, 'work');
  cfg.cacheDir = path.join(cfg.dataDir, 'cache');
  cfg.logFile = path.join(cfg.dataDir, 'server.log');
  for (const d of [cfg.dataDir, cfg.outDir, cfg.jobsDir, cfg.projectsDir, cfg.workDir, cfg.cacheDir]) ensureDir(d);
  return cfg;
}

const CFG = loadConfig();
const CACHE = new Cache(CFG.cacheDir);
const STARTED_AT = Date.now();
const PORT = Number(CFG.port) || 8774;

/** 项目 → 版本：只碰 data-v2/projects 和 job 上自己的两个字段。 */
const PROJECTS = new Projects({
  projectsDir: CFG.projectsDir,
  jobsDir: CFG.jobsDir,
  outDir: CFG.outDir,
  workDir: CFG.workDir,
  log: (msg) => log(msg),
});

/**
 * 每个任务一份 cfg：全局配置 + 请求里的四个可调项。
 * 下游（plan/render/audio/stickers）只读这一份，不各自去翻 request。
 * 注意 voicePitch 合法值里有 0（原声），不能用 `||` 兜底，会把 0 吃掉。
 */
function jobConfig(request) {
  const req = request || {};
  const pad = Number(req.scenePadding);
  const pitch = Number(req.voicePitch);
  return {
    ...CFG,
    narrationSpeed: Number(req.narrationSpeed) || 1,
    scenePadding: Number.isFinite(pad) ? pad : 0.6,
    stickerDuration: Number(req.stickerDuration) || 2,
    voicePitch: Number.isFinite(pitch) ? pitch : 1,
  };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] [v2] ${String(msg)}`;
  console.log(line);
  try { fs.appendFileSync(CFG.logFile, line + '\n'); } catch { /* 日志失败不影响服务 */ }
}

function jobLog(job, msg) {
  log(`[${job.id}] ${msg}`);
}

/** 日志里的音高：+1.0 / 0.0 / -1.5，正数带 + 号，一眼看出升降。 */
function pitchText(v) {
  const n = Number(v);
  const safe = Number.isFinite(n) ? n : 0;
  return `${safe > 0 ? '+' : ''}${safe.toFixed(1)}`;
}

// ---------------------------------------------------------------- 任务状态 ----
const JOBS = new Map();     // id -> job（最近使用；磁盘才是持久真相）
const QUEUE = [];
let RUNNING = false;

function jobFile(id) {
  return path.join(CFG.jobsDir, `${id}.json`);
}

function persist(job) {
  try {
    writeJsonAtomic(jobFile(job.id), job);
  } catch (err) {
    log(`任务落盘失败 ${job.id}: ${String((err && err.message) || err)}`);
  }
}

/** 任务所属项目名；没有项目的旧任务回落到「未分组」。 */
function projectTitleOf(job) {
  const pid = String((job && job.projectId) || '');
  if (!pid) return '未分组';
  const project = PROJECTS.get(pid);
  return project ? (project.title || '未命名视频') : '';
}

function publicJob(job) {
  const req = job.request || {};
  return {
    ok: true,
    id: job.id,
    status: job.status,
    phase: job.phase,
    label: job.label,
    title: job.title || '',
    done: job.done || 0,
    total: job.total || 0,
    elapsedMs: job.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : Date.now() - job.createdAt,
    ms: job.ms || 0,
    bytes: job.bytes || 0,
    // 项目层：旧任务没有这两个字段，回落到「未分组」/0
    projectId: job.projectId || '',
    projectTitle: projectTitleOf(job),
    version: Number(job.version) || 0,
    seconds: Number(req.seconds) || 0,
    videoUrl: job.videoUrl || '',
    srtUrl: job.srtUrl || '',
    warnings: Array.isArray(job.warnings) ? job.warnings : [],
    error: job.error || null,
    // 四个可调项回显给面板/复现脚本；老任务没有 params 时按 request 兜底
    params: job.params || {
      narrationSpeed: req.narrationSpeed,
      scenePadding: req.scenePadding,
      stickerDuration: req.stickerDuration,
      voicePitch: req.voicePitch,
    },
    scenes: Array.isArray(job.scenes) ? job.scenes : [],
  };
}

function getJob(id) {
  if (JOBS.has(id)) return JOBS.get(id);
  const rec = readJson(jobFile(id), null);
  if (!rec || !rec.id) return null;
  JOBS.set(id, rec);
  return rec;
}

function update(job, patch) {
  Object.assign(job, patch || {});
  if (job.status === 'running') job.elapsedMs = Date.now() - (job.startedAt || Date.now());
  persist(job);
}

/** 启动时把上次没跑完的 running/queued 标 failed（任务书要求）。 */
function recoverStaleJobs() {
  let n = 0;
  let files = [];
  try { files = fs.readdirSync(CFG.jobsDir).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const rec = readJson(path.join(CFG.jobsDir, f), null);
    if (!rec || (rec.status !== 'running' && rec.status !== 'queued')) continue;
    rec.status = 'failed';
    rec.phase = 'failed';
    rec.label = '失败';
    rec.error = '服务重启，任务中断';
    rec.finishedAt = Date.now();
    rec.ms = rec.startedAt ? rec.finishedAt - rec.startedAt : 0;
    persist(rec);
    n += 1;
  }
  if (n) log(`启动恢复：${n} 个未完成任务已标 failed`);
}

function enqueue(job) {
  QUEUE.push(job);
  update(job, { status: 'queued', phase: 'queued', label: QUEUE.length > 1 ? `排队中（第 ${QUEUE.length} 位）` : '排队中' });
  jobLog(job, `入队（前面 ${QUEUE.length - 1} 个任务）`);
  pump();
}

async function pump() {
  if (RUNNING) return;
  const job = QUEUE.shift();
  if (!job) return;
  RUNNING = true;
  try {
    await runJob(job);
  } catch (err) {
    const msg = String((err && err.message) || err);
    jobLog(job, `任务异常：${msg}`);
    update(job, {
      status: 'failed', phase: 'failed', label: '失败', error: msg,
      finishedAt: Date.now(), ms: Date.now() - (job.startedAt || Date.now()),
    });
  } finally {
    RUNNING = false;
    setTimeout(pump, 30);
  }
}

// ------------------------------------------------------------------ 跑任务 ----
async function runJob(job) {
  job.startedAt = Date.now();
  const cfg = jobConfig(job.request);
  update(job, {
    status: 'running', phase: 'plan', label: '规划分镜', done: 0,
    total: job.request.scenes.length || 0, startedAt: job.startedAt, error: null,
  });
  jobLog(job, `开始：${job.request.scenes.length ? `分镜 ${job.request.scenes.length} 场` : job.request.script ? '稿子模式' : '主题模式'}`
    + `，语速 ${cfg.narrationSpeed}×，停留 ${cfg.scenePadding}s，表情一轮 ${cfg.stickerDuration}s，`
    + `音高 ${pitchText(cfg.voicePitch)} 半音`);

  const ctx = {
    log: (m) => jobLog(job, m),
    workDir: CFG.workDir,
    repair: (args) => Plan.repairManim({ ...args, ctx: { log: (m) => jobLog(job, m) } }),
  };

  const planned = await Plan.plan({
    req: job.request, cfg, cache: CACHE, redo: Boolean(job.redoOf), ctx,
  });
  if (!planned.ok) throw new Error(planned.error || 'PLAN_FAILED');
  for (const w of planned.warnings || []) if (!job.warnings.includes(w)) job.warnings.push(w);
  job.title = planned.title || job.title;
  job.scenes = planned.scenes;
  job.total = planned.scenes.length;
  update(job, {
    phase: 'voice', label: `配音 0/${job.total}`, scenes: job.scenes, total: job.total, title: job.title,
  });
  jobLog(job, `分镜定稿：${job.total} 场，标题「${job.title}」`);

  const rendered = await Render.renderScenes({
    scenes: job.scenes, style: planned.style, voice: job.request.voice,
    cfg, cache: CACHE, job, ctx,
    onProgress: (p) => {
      update(job, {
        phase: p.phase, label: p.label, done: p.done, total: p.total,
        scenes: job.scenes,
      });
    },
  });
  job.warnings = rendered.warnings || job.warnings;
  if (!rendered.ok) throw new Error(rendered.error || 'RENDER_FAILED');

  // 没进 entries 的场次（合成失败）标 failed
  for (const sc of job.scenes) {
    if (!sc.status || sc.status === 'pending') {
      sc.status = 'failed';
      sc.note = sc.note || '没有画面';
    }
  }
  update(job, { phase: 'concat', label: '拼接成片', scenes: job.scenes });

  const outFile = path.join(CFG.outDir, `${job.id}.mp4`);
  const srtFile = path.join(CFG.outDir, `${job.id}.srt`);
  const concat = await Render.concatScenes({
    entries: rendered.entries, outFile, cfg,
    log: (m) => jobLog(job, m),
  });
  if (!concat.ok) throw new Error(concat.error || 'CONCAT_FAILED');

  const srt = Sub.globalSrt(rendered.entries.map((e) => ({ seconds: e.seconds, cues: e.cues })));
  fs.writeFileSync(srtFile, srt.text, 'utf8');

  const stat = fs.statSync(outFile);
  const finishedAt = Date.now();
  update(job, {
    status: 'done', phase: 'done', label: '完成', done: job.total, total: job.total,
    finishedAt, ms: finishedAt - job.startedAt, bytes: stat.size,
    videoUrl: `/v1/video/${job.id}`, srtUrl: `/v1/video/${job.id}?srt=1`,
    scenes: job.scenes,
  });
  jobLog(job, `完成：${(stat.size / 1048576).toFixed(2)}MB，${((finishedAt - job.startedAt) / 1000).toFixed(1)}s，${srt.cues.length} 条字幕`);
}

// ------------------------------------------------------------------ HTTP ----
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function parseBody(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendFile(req, res, file, type) {
  let stat;
  try { stat = fs.statSync(file); } catch { return json(res, 404, { ok: false, error: 'NOT_FOUND' }); }
  if (!stat.isFile()) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  const range = req.headers.range;
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };
  let start = 0;
  let end = stat.size - 1;
  let code = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (m) {
      if (m[1] !== '') start = Number(m[1]);
      if (m[2] !== '') end = Number(m[2]);
      else end = stat.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      code = 206;
      headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

let healthCache = { at: 0, data: null };

async function health() {
  if (healthCache.data && Date.now() - healthCache.at < 60000) return healthCache.data;
  const manim = await M.run(CFG.python, ['-m', 'manim', '--version'], 30000)
    .then((r) => r.code === 0)
    .catch(() => false);
  const ffmpeg = await M.run(CFG.ffmpeg, ['-hide_banner', '-version'], 20000)
    .then((r) => r.code === 0)
    .catch(() => false);
  const data = {
    ok: Boolean(manim && ffmpeg), manim: Boolean(manim), ffmpeg: Boolean(ffmpeg),
    port: PORT, version: 'v2', uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
  };
  healthCache = { at: Date.now(), data };
  return data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
        'access-control-max-age': '600',
      });
      return res.end();
    }

    if (req.method === 'GET' && p === '/v1/health') {
      return json(res, 200, await health());
    }

    // ------------------------------------------------------------ 项目（主题）----
    // 一个项目 = 一个视频主题，可以重做很多版；任务页按项目分组显示。
    if (p === '/v1/projects' && req.method === 'POST') {
      let body;
      try {
        body = parseBody(await readBody(req));
      } catch (err) {
        return json(res, 400, { ok: false, error: 'BAD_JSON', detail: String((err && err.message) || err) });
      }
      const project = PROJECTS.create(String((body && body.title) == null ? '' : body.title), '');
      return json(res, 200, {
        ok: true,
        projectId: project.id,
        project: {
          id: project.id, title: project.title || '未命名视频',
          createdAt: project.createdAt, updatedAt: project.updatedAt,
        },
      });
    }

    if (p === '/v1/projects' && req.method === 'GET') {
      const { projects, ungrouped } = PROJECTS.listAll();
      return json(res, 200, { ok: true, projects, ungrouped, ungroupedCount: ungrouped.length });
    }

    const projectMatch = /^\/v1\/projects\/([A-Za-z0-9_-]+)$/.exec(p);
    if (projectMatch && req.method === 'GET') {
      const detail = PROJECTS.detail(projectMatch[1]);
      if (!detail) return json(res, 404, { ok: false, error: 'PROJECT_NOT_FOUND' });
      return json(res, 200, { ok: true, project: detail.project, jobs: detail.jobs });
    }

    // 改名：沿用同一个 id，只换标题（面板「改名」按钮）
    if (projectMatch && req.method === 'POST') {
      let body;
      try {
        body = parseBody(await readBody(req));
      } catch (err) {
        return json(res, 400, { ok: false, error: 'BAD_JSON', detail: String((err && err.message) || err) });
      }
      const title = String((body && body.title) == null ? '' : body.title).trim();
      if (!title) return json(res, 400, { ok: false, error: 'TITLE_REQUIRED', message: '项目名不能为空' });
      const project = PROJECTS.rename(projectMatch[1], title);
      if (!project) return json(res, 404, { ok: false, error: 'PROJECT_NOT_FOUND' });
      return json(res, 200, { ok: true, project });
    }

    if (projectMatch && req.method === 'DELETE') {
      try {
        const removed = PROJECTS.remove(projectMatch[1]);
        if (!removed) return json(res, 404, { ok: false, error: 'PROJECT_NOT_FOUND' });
        // 内存里可能还留着已删任务的记录：一并丢掉，避免 GET /v1/jobs/:id 又读出来
        for (const id of removed.jobIds) JOBS.delete(id);
        return json(res, 200, { ok: true, ...removed });
      } catch (err) {
        if (err && err.code === 'PROJECT_BUSY') {
          return json(res, 409, {
            ok: false, error: 'PROJECT_BUSY', message: '这个项目还有版本在跑，等它完成再删',
            active: err.active || [],
          });
        }
        throw err;
      }
    }

    if (req.method === 'POST' && p === '/v1/jobs') {
      let body;
      try {
        body = parseBody(await readBody(req));
      } catch (err) {
        return json(res, 400, { ok: false, error: 'BAD_JSON', detail: String((err && err.message) || err) });
      }
      const request = S.normalizeRequest(body, (m) => log(m));
      const hasInput = Boolean(request.topic || request.script || request.scenes.length);
      if (!hasInput) return json(res, 400, { ok: false, error: 'INPUT_REQUIRED', message: 'topic / script / scenes 三选一' });
      const job = S.newJob(request);
      job.title = request.scenes.length ? String(request.scenes[0].text || '') : '';
      job.total = request.scenes.length;
      // 项目层：带了 projectId 就挂到那个项目；没带就自动建一个（标题从主题/首句猜）
      const attached = PROJECTS.attach(job, body && body.projectId, request);
      JOBS.set(job.id, job);
      persist(job);
      jobLog(job, `提交：${request.scenes.length ? `${request.scenes.length} 场分镜` : request.script ? '稿子' : `主题「${request.topic.slice(0, 30)}」`}，${request.seconds}s，voice="${request.voice}"，`
        + `项目「${attached.projectTitle}」v${attached.version}，`
        + `语速 ${request.narrationSpeed}×，停留 ${request.scenePadding}s，表情一轮 ${request.stickerDuration}s，`
        + `音高 ${pitchText(request.voicePitch)} 半音`);
      enqueue(job);
      return json(res, 200, {
        ok: true, jobId: job.id,
        projectId: attached.projectId, version: attached.version, projectTitle: attached.projectTitle,
      });
    }

    if (req.method === 'GET' && p === '/v1/jobs') {
      let files = [];
      try { files = fs.readdirSync(CFG.jobsDir).filter((f) => f.endsWith('.json')); } catch { /* 空 */ }
      const jobs = [];
      for (const f of files) {
        const rec = readJson(path.join(CFG.jobsDir, f), null);
        if (!rec || !rec.id) continue;
        jobs.push({
          id: rec.id, status: rec.status, title: rec.title || '', phase: rec.phase || '',
          createdAt: rec.createdAt || 0, elapsedMs: rec.ms || 0, bytes: rec.bytes || 0,
          seconds: Number(rec.request && rec.request.seconds) || 0,
          videoUrl: rec.videoUrl || '', srtUrl: rec.srtUrl || '',
          error: rec.error || null,
          // 项目层：没有 projectId 的旧任务留在「未分组」
          projectId: rec.projectId || '', version: Number(rec.version) || 0,
        });
      }
      // 补 projectTitle 和旧任务的版本号兜底
      PROJECTS.annotate(jobs);
      jobs.sort((a, b) => b.createdAt - a.createdAt);
      return json(res, 200, { ok: true, jobs: jobs.slice(0, 50) });
    }

    const jobMatch = /^\/v1\/jobs\/([A-Za-z0-9_-]+)$/.exec(p);
    if (jobMatch && req.method === 'GET') {
      const job = getJob(jobMatch[1]);
      if (!job) return json(res, 404, { ok: false, error: 'JOB_NOT_FOUND' });
      return json(res, 200, publicJob(job));
    }

    const redoMatch = /^\/v1\/jobs\/([A-Za-z0-9_-]+)\/redo$/.exec(p);
    if (redoMatch && req.method === 'POST') {
      const prev = getJob(redoMatch[1]);
      if (!prev) return json(res, 404, { ok: false, error: 'JOB_NOT_FOUND' });
      let body;
      try {
        body = parseBody(await readBody(req));
      } catch (err) {
        return json(res, 400, { ok: false, error: 'BAD_JSON', detail: String((err && err.message) || err) });
      }
      const scenes = S.normalizeScenes(body.scenes, CFG.maxScenes, (m) => log(`[${prev.id}] ${m}`));
      if (!scenes.length) return json(res, 400, { ok: false, error: 'SCENES_REQUIRED' });
      const base = prev.request || {};
      // 四个可调项：body 显式给了就用 body（重做时可以改语速/音高），否则沿用上一条任务
      const pick = (name) => (body[name] == null ? base[name] : body[name]);
      const request = S.normalizeRequest({
        scenes,
        seconds: Number(base.seconds) || 30,
        style: String(base.style || ''),
        voice: base.voice == null ? '' : String(base.voice),
        narrationSpeed: pick('narrationSpeed'),
        scenePadding: pick('scenePadding'),
        stickerDuration: pick('stickerDuration'),
        voicePitch: pick('voicePitch'),
        fresh: false,
      }, (m) => log(`[redo] ${m}`));
      const job = S.newJob(request);
      job.redoOf = prev.id;
      job.title = String(scenes[0].text || '');
      job.total = scenes.length;
      // 重做沿用原任务的项目（不新建项目）：新版本接在同一个主题下面。
      // 原任务是「未分组」的旧数据时也保持未分组，不偷偷给它造一个项目。
      const prevProjectId = String(prev.projectId || '');
      const attached = prevProjectId ? PROJECTS.attach(job, prevProjectId, request) : null;
      JOBS.set(job.id, job);
      persist(job);
      jobLog(job, `重做：基于 ${prev.id}，${scenes.length} 场，标题「${job.title}」，`
        + (attached ? `项目「${attached.projectTitle}」v${attached.version}，` : '（未分组），')
        + `语速 ${request.narrationSpeed}×，停留 ${request.scenePadding}s，表情一轮 ${request.stickerDuration}s，`
        + `音高 ${pitchText(request.voicePitch)} 半音`);
      enqueue(job);
      return json(res, 200, {
        ok: true, jobId: job.id,
        projectId: attached ? attached.projectId : '',
        version: attached ? attached.version : 0,
        projectTitle: attached ? attached.projectTitle : '未分组',
      });
    }

    const videoMatch = /^\/v1\/video\/([A-Za-z0-9_-]+)$/.exec(p);
    if (videoMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const id = videoMatch[1];
      const wantSrt = url.searchParams.get('srt') === '1';
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return json(res, 400, { ok: false, error: 'BAD_ID' });
      if (wantSrt) return sendFile(req, res, path.join(CFG.outDir, `${id}.srt`), 'application/x-subrip; charset=utf-8');
      return sendFile(req, res, path.join(CFG.outDir, `${id}.mp4`), 'video/mp4');
    }

    return json(res, 404, { ok: false, error: 'NOT_FOUND', path: p });
  } catch (err) {
    log(`HTTP 异常 ${req.method} ${p}: ${String((err && err.stack) || err).slice(0, 800)}`);
    if (!res.headersSent) return json(res, 500, { ok: false, error: 'INTERNAL', detail: String((err && err.message) || err) });
    try { res.end(); } catch { /* 忽略 */ }
  }
});

recoverStaleJobs();
server.listen(PORT, '127.0.0.1', () => {
  log(`studio-v2 启动 http://127.0.0.1:${PORT}（data=${CFG.dataDir}，缓存 ${CFG.cacheDir}）`);
});

process.on('SIGINT', () => { log('SIGINT，退出'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { log('SIGTERM，退出'); server.close(() => process.exit(0)); });
