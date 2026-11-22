'use strict';
/**
 * frame.js -- 成片装饰边框（克莱因蓝）。
 *
 * 为什么放在"渲染循环"这一层，而不是 manim 代码 / 文字卡模板里：
 *   边框是**成片这层**的装饰，和画面里画了什么无关。放在这里，manim / 文字卡 / draw
 *   走的是同一条后处理路径；换风格、改动画代码、改字幕都不用再管边框。
 *   而且片段是先加边框再落进缓存的，所以缓存里的 clip 本身就是带框的最终画面，
 *   复用缓存时不需要再叠一次。
 *
 * 什么时候加（"合适的时机"）：
 *   - manim / text 等矢量或文字画面：加。像一页讲义、一块屏幕，能补足四周留白。
 *   - aivideo（AI 生成）：不加。满幅素材本身就是一个镜头，镶一圈边会变成"相框里的插画"。
 *   - 有全幅 image 底图的场：不加。同上，画面已经是满幅照片。
 *   判定用这一场**最终实际用的引擎**（降级之后的值），不是分镜里写的 kind ——
 *   因为 manim 失败退文字卡时，最终画面是文字卡。
 *
 * 为什么用"预渲染边框 PNG + overlay"，而不是逐帧 drawbox 或 pad：
 *   1) pad 会改分辨率（1920x1080 → 1948x1108）。下游 xfade 拼接、字幕烧制、成片元数据
 *      都要跟着改宽度，每场尺寸不一致时还得额外 scale —— 为了一个装饰把整条链路搞脏，不值。
 *      drawbox 原地画在画布最外圈，分辨率不变、贴边不内缩，正是"给屏幕镶边"的效果。
 *   2) 但逐帧 drawbox 很贵：在 4 核 1080p 上实测，一个 t=14 的外框要多花 0.45~1.0s
 *      （两个框 2.2s / 4.5s 片段），比整条片段的编码还慢。
 *      同一批像素预渲染成一张 PNG、每帧只做一次 overlay，只多 0.07~0.15s。
 *      视觉结果完全一样，代价差一个数量级 —— 所以边框 PNG 用 drawbox 生成**一次**，
 *      逐帧只做 overlay。
 *   3) 外框 14px 克莱因蓝 + 内衬 2px 稍亮的蓝：两层线在同一张 PNG 里，多一层线不增加逐帧成本。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// 复用渲染层带超时保护的 ffmpeg 调用，避免再写一份 spawn
const R = require('./render.js');

/** 默认值：与 config.json 的 frame 段一一对应 */
const DEFAULTS = {
  enabled: true,
  color: '#002FA7',      // 克莱因蓝
  accent: '#4A6BC4',     // 内衬线，稍亮的蓝，做出层次
  width: 14,             // 外框厚度（像素，贴画布边缘）
  innerWidth: 2,         // 内衬线厚度（0 = 不要内线）
  skipEngines: ['aivideo'],
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * 配置归一化：手改 config.json 时很容易写错（颜色少一位、宽度写成字符串），
 * 这里一律兜住 —— 一个装饰配置写错不该让整条片子的渲染失败。
 */
function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const int = (v, def, min, max) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  const color = HEX_RE.test(String(c.color || '')) ? String(c.color).toLowerCase() : DEFAULTS.color.toLowerCase();
  const accent = HEX_RE.test(String(c.accent || '')) ? String(c.accent).toLowerCase() : DEFAULTS.accent.toLowerCase();
  const skipEngines = (Array.isArray(c.skipEngines) ? c.skipEngines : DEFAULTS.skipEngines)
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: c.enabled === undefined ? DEFAULTS.enabled : Boolean(c.enabled),
    color,
    accent,
    width: int(c.width, DEFAULTS.width, 0, 80),
    innerWidth: int(c.innerWidth, DEFAULTS.innerWidth, 0, 24),
    skipEngines,
  };
}

/**
 * 边框签名：进缓存判定。改颜色/宽度/内线/跳过引擎都要重渲，
 * 否则旧片段会一直用旧边框（这正是"改了配置却不生效"的经典坑）。
 */
function signature(cfg) {
  const f = normalize(cfg);
  return crypto.createHash('sha1')
    .update(JSON.stringify([f.enabled, f.color, f.accent, f.width, f.innerWidth, f.skipEngines]))
    .digest('hex').slice(0, 16);
}

/**
 * 这一场该不该加边框。返回 { on, reason }。
 * reason 直接进日志：`跳过边框（engine=aivideo）` 这类行是排查"这场怎么没框"的唯一线索。
 */
function decide(cfg, { engine, scene } = {}) {
  const f = normalize(cfg);
  if (!f.enabled) return { on: false, reason: 'disabled' };
  if (f.width <= 0 && f.innerWidth <= 0) return { on: false, reason: 'zero-width' };
  // 全幅图片底：画面本身是满幅素材，加框会变成相框
  if (scene && (scene.image || scene.imagePath)) return { on: false, reason: 'image' };
  const eng = String(engine || '').toLowerCase();
  if (eng && f.skipEngines.includes(eng)) return { on: false, reason: `engine=${eng}` };
  return { on: true, reason: `engine=${eng || 'unknown'}` };
}

/** 缓存是否过期：旧片段的边框配置和现在不一致，就得重渲这一场。 */
function cacheStale(entry, { frame, sig, engine, scene } = {}) {
  if (!entry) return false;
  // 1) 缓存里记过签名：签名不同 = 配置变了（换色/改宽度/关掉边框）
  if (entry.frameSig != null) return String(entry.frameSig) !== String(sig);
  // 2) 老缓存没签名（加边框之前渲的）：现在该加框而它没有 → 补渲一次。
  //    否则老项目会永远复用"没框"的片段，改了配置也看不出效果。
  return decide(frame, { engine, scene }).on && entry.framed !== true;
}

/** #002FA7 -> 0x002FA7（drawbox / 颜色源都吃这个写法） */
function ffColor(hex) {
  return '0x' + String(hex).replace(/^#/, '').toUpperCase();
}

/** 两层线的 drawbox 链，用来生成一次性的边框 PNG（也可当 PNG 生成失败时的兜底） */
function boxChain(f) {
  const parts = [];
  if (f.width > 0) {
    parts.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${ffColor(f.color)}@1:t=${f.width}:replace=1`);
  }
  if (f.innerWidth > 0) {
    // 内衬线紧贴外框内沿：只是贴边，不缩放画面（不内缩内容）
    const inset = f.width;
    parts.push(`drawbox=x=${inset}:y=${inset}:w=iw-${inset * 2}:h=ih-${inset * 2}:color=${ffColor(f.accent)}@1:t=${f.innerWidth}:replace=1`);
  }
  return parts.join(',');
}

/**
 * 生成（并复用）边框 PNG：透明画布上只画边框像素。
 * 同一份配置 + 同一分辨率只生成一次，之后每场只做 overlay。
 */
async function ensureBorderPng({ ffmpeg, dir, frame, width, height, timeoutMs = 60000 }) {
  const f = normalize(frame);
  const file = path.join(dir, `border-${signature(f)}-${width}x${height}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 200) return { ok: true, file, cached: true, ms: 0 };
  const started = Date.now();
  const chain = boxChain(f);
  const r = await R.run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${width}x${height},format=rgba`,
    '-vf', chain,
    '-frames:v', '1', file,
  ], timeoutMs);
  const ms = Date.now() - started;
  if (r.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 200) {
    try { fs.rmSync(file, { force: true }); } catch { /* 删不掉也没关系 */ }
    return { ok: false, file: null, cached: false, ms, error: String(r.stderr || '').slice(0, 400) };
  }
  return { ok: true, file, cached: false, ms };
}

/**
 * 给一个片段加边框。
 *
 * 入参：ffmpeg 可执行文件、videoIn（原片段）、out（输出片段）、frame（config.frame 段）、
 *       engine（这一场最终用的引擎）、scene（分镜，用来判断全幅图底）、
 *       fps / width / height、log（日志回调）。
 *
 * 返回 { ok, framed, file, reason, ms }：
 *   - framed=true 时 file 是**带框的新片段**（调用方要用它替换原片段）；
 *   - framed=false 时 file 就是原片段（跳过/失败都不影响出片）。
 *
 * 失败不抛异常：边框只是装饰，宁可无框出片，也不能因为一次 ffmpeg 失败丢掉整场画面。
 */
async function applyFrame({ ffmpeg, videoIn, out, frame, engine, scene, fps, width, height, timeoutMs = 120000, log, threads = 0 }) {
  const say = typeof log === 'function' ? log : () => { };
  const f = normalize(frame);
  const d = decide(f, { engine, scene });
  if (!d.on) {
    // 关掉时一声不吭（行为和加边框之前完全一致）；其它跳过原因要留痕
    if (d.reason !== 'disabled') say(`跳过边框（${d.reason}）`);
    return { ok: true, framed: false, file: videoIn, reason: d.reason, ms: 0 };
  }
  if (!videoIn || !fs.existsSync(videoIn)) {
    say('跳过边框（原片段不存在）');
    return { ok: true, framed: false, file: videoIn, reason: 'missing-input', ms: 0 };
  }
  if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    say('跳过边框（ffmpeg 不存在）');
    return { ok: true, framed: false, file: videoIn, reason: 'no-ffmpeg', ms: 0 };
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const started = Date.now();
  // 先试 PNG + overlay（每帧只叠一次，最省）；生成失败就退回逐帧 drawbox（慢，但一定有框）
  const png = await ensureBorderPng({ ffmpeg, dir: path.dirname(path.resolve(out)), frame: f, width, height, timeoutMs });
  const base = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoIn];
  // 边框 overlay 也是一次 libx264 编码：场级并行时只给 2 线程，串行时 0=吃满
  const enc = ['-an', '-threads', String(Math.max(0, Math.floor(Number(threads) || 0))),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
  if (Number(fps) > 0) enc.push('-r', String(Number(fps)));
  const args = png.ok
    ? [...base, '-i', png.file, '-filter_complex', '[0:v][1:v]overlay=0:0[v]', '-map', '[v]', ...enc, out]
    : [...base, '-vf', boxChain(f), ...enc, out];
  const r = await R.run(ffmpeg, args, timeoutMs);
  const ms = Date.now() - started;
  const size = (() => { try { return fs.statSync(out).size; } catch { return 0; } })();
  if (r.code !== 0 || size < 1000) {
    // 失败的输出可能是个只有文件头的半成品，留着比没有更危险
    try { fs.rmSync(out, { force: true }); } catch { /* 删不掉也没关系 */ }
    say(`装饰边框失败：${String(r.stderr || `exit ${r.code}`).slice(0, 200)}（用原片段）`);
    return { ok: false, framed: false, file: videoIn, reason: 'ffmpeg-failed', ms, error: String(r.stderr || '').slice(0, 400) };
  }
  return {
    ok: true, framed: true, file: out, ms,
    pngMs: png.ms, pngCached: png.cached, mode: png.ok ? 'overlay' : 'drawbox',
    color: f.color, width: f.width, innerWidth: f.innerWidth,
  };
}

module.exports = {
  DEFAULTS,
  normalize,
  signature,
  decide,
  cacheStale,
  boxChain,
  ffColor,
  ensureBorderPng,
  applyFrame,
};
