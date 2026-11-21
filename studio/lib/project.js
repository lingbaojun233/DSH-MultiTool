'use strict';
/**
 * project.js -- 视频"项目"的存储与分段缓存。
 *
 * 为什么要有这一层：
 *   长科普视频动辄 50+ 场。以前每次改一个字都要把整片重渲一遍（几十秒到几分钟），
 *   而其中 99% 的画面根本没变。这里的做法是：每个场景单独渲成一个小片段并缓存，
 *   缓存键由"决定这张画面的所有参数"算出来 —— 参数没变就复用，变了才重渲。
 *
 * 同样的道理用在旁白上：旁白按 (文本, 音色) 缓存。只改台词时，画面一个字节都不用重画，
 * 只需要重合成那几句 + 重新混音（秒级）。
 *
 * 目录结构：
 *   projects/<id>/project.json     项目定义（分镜 + 缓存索引）
 *   projects/<id>/cache/clip-*.mp4 单场片段（缓存）
 *   projects/<id>/cache/tts-*.wav  单场旁白（缓存）
 *   projects/<id>/out/<renderId>.mp4  成片
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先写临时文件再改名：进程被杀时不会留下半截 JSON，把整个项目读坏
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function projectDir(root, id) {
  return path.join(root, id);
}

function projectFile(root, id) {
  return path.join(projectDir(root, id), 'project.json');
}

function cacheDir(root, id) {
  return path.join(projectDir(root, id), 'cache');
}

function outDir(root, id) {
  return path.join(projectDir(root, id), 'out');
}

function newId() {
  return 'p-' + crypto.randomUUID().slice(0, 8);
}

/**
 * 画面缓存键：只要这组参数不变，渲出来的片段就一定一样。
 * 特意不含 narration —— 改台词不该让画面重画（这正是"只重做声音"能省时间的原因）。
 */
function sceneKey(scene, cfg) {
  const payload = {
    kind: String(scene.kind || 'text'),
    text: String(scene.text || ''),
    html: String(scene.html || ''),
    python: String(scene.python || ''),
    // manim 脚本也进缓存键：改了代码必须重渲，不能复用旧动画
    manim: scene.manim || null,
    draw: scene.draw || null,
    steps: Array.isArray(scene.steps) ? scene.steps : null,
    seconds: Number(scene.seconds) || 0,
    textSize: scene.textSize || null,
    textColor: scene.textColor || null,
    bg: scene.bg || null,
    image: scene.image || null,
    motion: scene.motion || null,
    // 表情叠加也影响画面，必须进缓存键 —— 否则改了表情却复用旧片段
    stickers: Array.isArray(scene.stickers) ? scene.stickers : null,
    // 风格也进缓存键：manim 脚本会被注入风格色/背景，文字卡背景也来自风格。
    // 少了这一项，"同一场景换个风格重渲"会直接复用旧配色的片段，风格永远不生效。
    style: cfg.styleSig || cfg.styleId || null,
    // 文字卡的入场/出场淡化同样决定画面：改这个值必须重渲文字卡，否则新旧混一集。
    // v2 = 淡到风格底色 + 跨 xfade 中点（v1 是淡到黑，缓存必须区分开）
    edge: String(scene.kind || 'text') === 'text' ? `v2|${Number(cfg.textEdgeFade) || 0}|${cfg.styleId || ''}` : null,
    w: cfg.width, h: cfg.height, fps: cfg.fps,
  };
  return sha1(JSON.stringify(payload));
}

/** 旁白缓存键：文本 + 音色。换台词只影响这一场的音频。 */
function audioKey(text, voice) {
  return sha1(JSON.stringify({ text: String(text || ''), voice: String(voice || '') }));
}

function createProject(root, input = {}) {
  const id = newId();
  const now = new Date().toISOString();
  const project = {
    id,
    title: String(input.title || '未命名项目').slice(0, 80),
    width: Number(input.width) || 1920,
    height: Number(input.height) || 1080,
    fps: Number(input.fps) || 30,
    fade: input.fade == null ? 0.4 : Number(input.fade),
    voice: String(input.voice || ''),
    bgm: String(input.bgm || ''),
    // 项目级风格 id（styles/<id>.json）。空串表示"渲染时按人设决定"，
    // 只有真要用某个风格钉死时才写具体 id —— 见 server.js 的 resolveStyleFor()。
    style: String(input.style || ''),
    // 项目级文字卡淡化覆盖（秒）。null = 用全局配置 textEdgeFade。
    textEdgeFade: input.textEdgeFade == null ? null : Number(input.textEdgeFade),
    scenes: [],
    cache: {},       // sceneKey -> { clip, at }
    audioCache: {},  // audioKey -> { wav, ms, at }
    renders: [],     // [{ renderId, file, bytes, seconds, at, scope }]
    createdAt: now,
    updatedAt: now,
  };
  saveProject(root, project);
  return project;
}

function loadProject(root, id) {
  return readJson(projectFile(root, id), null);
}

function saveProject(root, project) {
  project.updatedAt = new Date().toISOString();
  writeJson(projectFile(root, project.id), project);
  return project;
}

function listProjects(root) {
  try {
    return fs.readdirSync(root)
      .filter((name) => fs.existsSync(path.join(root, name, 'project.json')))
      .map((name) => {
        const p = loadProject(root, name);
        if (!p) return null;
        const last = (p.renders || [])[p.renders.length - 1] || null;
        return {
          id: p.id,
          title: p.title,
          scenes: (p.scenes || []).length,
          updatedAt: p.updatedAt,
          lastRender: last ? { renderId: last.renderId, seconds: last.seconds, at: last.at } : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  } catch {
    return [];
  }
}

/**
 * 应用增量修改。AI 只发"第几场改哪个字段"，不用重发整个分镜 ——
 * 一场 60 字的分镜，改一个字只花十几 token，而不是整份 JSON。
 */
function applyPatches(project, patches) {
  const touched = [];
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.op === 'insert') {
      const at = Math.max(0, Math.min(project.scenes.length, Number(p.index)));
      const scene = normalizeScene(p.scene || {});
      project.scenes.splice(at, 0, scene);
      touched.push(at);
      continue;
    }
    const index = Number(p.index);
    if (!Number.isInteger(index) || index < 0 || index >= project.scenes.length) continue;
    if (p.op === 'delete') {
      project.scenes.splice(index, 1);
      touched.push(index);
      continue;
    }
    // 默认 op = patch：只覆盖给出的字段
    const merged = Object.assign({}, project.scenes[index], p.patch || {});
    project.scenes[index] = normalizeScene(merged);
    touched.push(index);
  }
  return touched;
}

function normalizeScene(raw) {
  const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : fallback);
  const bg = raw.bg || {};
  const seconds = Math.min(12, Math.max(1, Number(raw.seconds) || 3));
  let kind = ['text', 'rich', 'plot', 'manim'].includes(raw.kind) ? raw.kind : 'text';
  // manim 场景：模型写一段 Manim 脚本，渲染时整段交给 manim（不再走静帧 + zoompan）。
  // 脚本没有/不是字符串就把 kind 退回 text —— 否则每次渲染都会白跑一次注定失败的 manim。
  const manimSrc = raw.manim && typeof raw.manim === 'object' ? raw.manim : null;
  const manimCode = manimSrc && typeof manimSrc.code === 'string' ? manimSrc.code.trim() : '';
  const manimScene = manimSrc && /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u.test(String(manimSrc.scene || ''))
    ? String(manimSrc.scene) : null;
  const manim = manimCode ? { code: manimCode.slice(0, 8000), scene: manimScene } : null;
  // kind 只是"偏好"。有脚本就是 manim 场 —— 以前这里只在 kind==='manim' 时才认，
  // 结果"规划成 text/rich 但确实给了 manim 脚本"的场次会白白丢掉动画。
  if (manim) kind = 'manim';
  if (kind === 'manim' && !manim) kind = 'text';
  // 表情叠加：坐标用 0~1 相对值，渲染器自己换算成像素
  const stickers = (Array.isArray(raw.stickers) ? raw.stickers : [])
    .filter((s) => s && /^[0-9a-f]{6,40}$/i.test(String(s.id || '')))
    .slice(0, 4)
    .map((s) => ({
      id: String(s.id),
      at: Math.max(0, Number(s.at) || 0),
      duration: Math.min(10, Math.max(0.4, Number(s.duration) || 1.6)),
      x: Math.min(1, Math.max(0, s.x == null ? 0.82 : Number(s.x))),
      y: Math.min(1, Math.max(0, s.y == null ? 0.22 : Number(s.y))),
      scale: Math.min(0.6, Math.max(0.08, s.scale == null ? 0.22 : Number(s.scale))),
      fade: Math.min(1, Math.max(0, s.fade == null ? 0.25 : Number(s.fade))),
    }));
  return {
    kind,
    text: String(raw.text || '').slice(0, 60),
    narration: String(raw.narration || '').slice(0, 200),
    seconds: Number(seconds.toFixed(2)),
    bg: { c0: hex(bg.c0, '#101a33'), c1: hex(bg.c1, '#3a2a5a') },
    image: raw.image ? String(raw.image).slice(0, 200) : null,
    motion: raw.motion || null,
    textSize: Number(raw.textSize) || null,
    textColor: raw.textColor || null,
    // rich 场景用绘图指令（GDI+），html 是早期留给无头浏览器的路，保留但不再主推
    python: raw.python ? String(raw.python).slice(0, 4000) : null,
    manim,
    draw: raw.draw && Array.isArray(raw.draw.shapes) ? {
      title: String(raw.draw.title || raw.text || '').slice(0, 60),
      bg1: raw.draw.bg1 || '#101a33',
      bg2: raw.draw.bg2 || '#0b1220',
      shapes: raw.draw.shapes.slice(0, 120).map((s) => {
        const out = { type: String(s.type || 'text'), step: Math.min(9, Math.max(1, Number(s.step) || 1)) };
        for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'w', 'h', 'size', 'width', 'text', 'color', 'fill', 'stroke', 'align', 'dash', 'arrow', 'bold']) {
          if (s[k] != null) out[k] = s[k];
        }
        if (Array.isArray(s.runs)) out.runs = s.runs.slice(0, 20).map((r) => ({ t: String(r.t || '').slice(0, 20), sup: Boolean(r.sup), sub: Boolean(r.sub) }));
        if (Array.isArray(s.points)) out.points = s.points.slice(0, 30);
        return out;
      }),
    } : null,
    html: raw.html ? String(raw.html).slice(0, 20000) : null,
    steps: Array.isArray(raw.steps) ? raw.steps.map((s) => String(s).slice(0, 20)).slice(0, 6) : null,
    stickers,
    narrationMs: Number(raw.narrationMs) || 0,
    actualSeconds: Number(raw.actualSeconds) || Number(seconds.toFixed(2)),
  };
}

/** 哪些场的缓存还能用（供渲染前预估"这次要重渲几场"）。 */
function planReuse(project, cfg, force = false) {
  const reuse = [];
  const rebuild = [];
  for (let i = 0; i < project.scenes.length; i++) {
    const key = sceneKey(project.scenes[i], cfg);
    const hit = project.cache[key];
    const exists = hit && fs.existsSync(hit.clip);
    if (!force && exists) reuse.push({ index: i, key, clip: hit.clip });
    else rebuild.push({ index: i, key });
  }
  return { reuse, rebuild };
}

function gcCache(project, keepKeys) {
  // 只保留当前分镜还在用的片段，避免项目目录无限增长。
  // 注意：这里只删文件、不动 project.cache 之外的任何东西 —— 缓存丢了顶多重渲，不能丢项目数据。
  const keep = new Set(keepKeys);
  const kept = {};
  for (const [key, val] of Object.entries(project.cache || {})) {
    if (keep.has(key)) kept[key] = val;
    else { try { fs.unlinkSync(val.clip); } catch { } }
  }
  project.cache = kept;
  return kept;
}

module.exports = {
  sha1,
  newId,
  projectDir,
  projectFile,
  cacheDir,
  outDir,
  createProject,
  loadProject,
  saveProject,
  listProjects,
  applyPatches,
  normalizeScene,
  sceneKey,
  audioKey,
  planReuse,
  gcCache,
  readJson,
  writeJson,
};
