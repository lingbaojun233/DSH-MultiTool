'use strict';
/**
 * DSH-MultiTool :: studio（视频创作）
 *
 * 分工是硬的：
 *   - DSH 只写「分镜 JSON」和旁白文字（不生成任何像素）
 *   - 画面全部由 ffmpeg 按分镜渲染（渐变背景 + 文字 + 慢推），可复现、可重渲染
 *   - 旁白用 speak 模块合成，BGM 由用户提供
 *
 * 这样"改一个字重跑"能精确控制成片，而不是每次让模型重新画一遍。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const R = require('./lib/render.js');
const P = require('./lib/project.js');
// 任务与"可重做配方"的落盘（原子写 + 标题规则）。见 lib/jobs.js 顶部注释。
const JS = require('./lib/jobs.js');
// 风格预设：配色/线宽/字体/节奏。渲染时机械地套到 manim 代码与文字卡上。
const S = require('./lib/styles.js');
// 人设 → 语气。旁白要像"她"在讲，而不是播音腔；见 lib/persona-binding.js。
const PB = require('./lib/persona-binding.js');
// 规划缓存：场级（一段 manim 代码）+ 骨架级（整份分镜）两层，见 lib/plan-cache.js 顶部注释。
const PlanCacheLib = require('./lib/plan-cache.js');
// 字幕（词级时间戳 → SRT → 烧进画面）与节奏对齐（语速/场时长/动画时长/画质档）。
// 和上面几个可选模块一样用 try：lib 文件没部署上时服务照常起来，只是这两项能力关闭。
let Subtitles = null;
let Rhythm = null;
try { Subtitles = require('./lib/subtitles.js'); } catch { Subtitles = null; }
try { Rhythm = require('./lib/rhythm.js'); } catch { Rhythm = null; }
const STYLE_DIR = path.join(__dirname, 'styles');

// 讲解画面（HTML/SVG → 无头浏览器截图）与表情叠加是后加的能力。
// 用可选 require：模块还没落地时整套渲染照旧工作，不会因为缺文件起不来。
let HTMLScene = null;
let Overlay = null;
let GdiScene = null;
let Pyplot = null;
let Manim = null;
let Wan = null;
let Frame = null;
try { HTMLScene = require('./lib/html-scene.js'); } catch { HTMLScene = null; }
try { Overlay = require('./lib/overlay.js'); } catch { Overlay = null; }
try { GdiScene = require('./lib/gdi-scene.js'); } catch { GdiScene = null; }
try { Pyplot = require('./lib/pyplot.js'); } catch { Pyplot = null; }
try { Manim = require('./lib/manim.js'); } catch { Manim = null; }
// AI 视频（wan3.0-video）：可选依赖，模块缺失时 aivideo 场自动降级文字卡，不影响整体启动
try { Wan = require('./lib/wanvideo.js'); } catch { Wan = null; }
// 成片装饰边框（克莱因蓝）：贴在 manim / 文字卡上，AI 满幅画面不加。见 lib/frame.js 顶部注释。
try { Frame = require('./lib/frame.js'); } catch { Frame = null; }

// 所有"分步静帧 → 片段"的路径统一走 buildStepClip（带淡入淡出 + 轻微推近），
// 不再用 html-scene 里那版硬切。这里覆盖一次，调用点就不用逐个改。
if (HTMLScene && typeof HTMLScene.buildSlidesClip === 'function') {
  HTMLScene.buildSlidesClip = (a) => buildStepClip({
    work: a.work, index: a.index, pngs: a.pngs,
    seconds: a.seconds, fps: a.fps, w: a.w, h: a.h,
  });
}

const DIR = __dirname;
const HOST = '127.0.0.1';

function readJson(file, fallback) {
  // 去 BOM：PowerShell 的 Set-Content -Encoding UTF8（5.1）会写 BOM，
  // 带 BOM 的 JSON.parse 直接抛异常 → 整个配置被悄悄忽略、回落到默认值。
  // 踩过一次（config.json 被 BOM 污染，maxAiVideo 设 2 却按 4 跑），这里兜住。
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

const CFG = Object.assign({
  port: 8772,
  width: 1920,
  height: 1080,
  fps: 30,
  fade: 0.4,
  // 长片（科普/讲解）动辄几十场、好几分钟。旧默认 8 场/60 秒是短视频口径，
  // 现在放开到 80 场/15 分钟 —— 真正的瓶颈是渲染时间，不是这些上限。
  maxScenes: 80,
  minSceneSeconds: 2,
  maxTotalSeconds: 900,
  ffmpeg: 'C:\\Apps\\DSH-MultiTool\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  font: 'C:\\Windows\\Fonts\\msyh.ttc',
  ioUrl: 'http://127.0.0.1:8765',
  speakUrl: 'http://127.0.0.1:8770',
  outDir: 'C:\\Apps\\DSH-MultiTool\\data\\studio',
  bgmDir: 'C:\\Apps\\DSH-MultiTool\\data\\studio\\bgm',
  // 项目（含分段缓存）放在 outDir 下的 projects\，和成片并列
  projectDir: 'C:\\Apps\\DSH-MultiTool\\data\\studio\\projects',
  // 讲解画面用无头浏览器截图；没有它就只能退回文字卡
  edgePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // 表情包（叠加时用）
  stickerDir: 'C:\\Apps\\DSH-MultiTool\\data\\stickers\\send',
  stickerUrl: 'http://127.0.0.1:8773',
  python: 'C:\\Apps\\DSH-MultiTool\\tools\\python311\\python.exe',
  // 静帧运镜模式：none=完全静止（默认，抖动为 0）；supersample=2 倍超采样后轻推；
  // zoompan=老行为（有抖动，只作回退）
  stillMotion: 'none',
  // manim 画质：-qm 720p30 起步，实际按项目宽高用 -r 覆盖，通常 -qm 就够
  manimQuality: '-qm',
  // manim 单场超时 = 基线 + 每秒时长×倍率。任务书的估算是 20s+3×，
  // 实测"带 Axes + 中文 Text"的 5 秒场在并发渲染时要 26~37 秒，
  // 所以默认给到 45s + 6×（5 秒场 = 75s），宁可多等也不让一场被误杀成文字卡。
  manimTimeoutBaseMs: 45000,
  manimTimeoutPerSecondMs: 6000,
  planTimeoutMs: 180000,
  // 逐场生成 manim 代码时的并发上限。实测串行是最大瓶颈：60 秒的稿子拆 8 场，
  // 每场一次模型调用 20~140 秒，串行就是 3~5 分钟。并发 3 在 4 核机器上是安全值
  // （本地几乎不动 cpu，只是在等远端模型）。只能往下调，不能超过 3。
  planConcurrency: 3,
  // 规划缓存（默认开）。false = 完全回到加缓存之前的行为：一个键都不查、一条都不写。
  // 场级缓存让"同一段稿子第二次做"从 2~6 分钟压到 1 秒级；骨架级缓存省掉拆场那一次调用。
  planCache: true,
  // 条目过期天数（按最后使用时间）。<=0 当永不过期，要关缓存请用 planCache:false。
  planCacheTtlDays: 30,
  // 两层共用的条目上限，超了按最后使用时间淘汰最旧的
  planCacheMaxEntries: 500,
  renderTimeoutMs: 600000,
  // 人设服务（panel）：默认风格由它决定，见 resolveStyleFor()
  personaUrl: 'http://127.0.0.1:8767',
  personaTimeoutMs: 6000,
  // 人设读不到时的兜底风格（styles/<id>.json）
  defaultStyle: 'whiteboard',
  // 文字卡标题的入场/出场淡化（秒）。0 关闭。
  // 为什么要它：xfade 是 0.4 秒重叠，两张文字卡在这个窗口里同时全亮 → 标题叠字。
  textEdgeFade: 0.15,
  // 成片装饰边框（克莱因蓝）：只贴 manim/文字卡的边，AI 满幅画面与图片底不加。
  // 判定用"最终实际用的引擎"，实现见 lib/frame.js；enabled:false = 连一次 ffmpeg 都不跑。
  frame: {
    enabled: true, color: '#002FA7', accent: '#4A6BC4', width: 14, innerWidth: 2, skipEngines: ['aivideo'],
  },
  // AI 生成画面（wan3.0-video）的成本护栏：一集最多几条。
  // 每条要 100~400 秒（实测 100 秒左右，排队/重试时会到 400 秒）、还占网关额度 ——
  // 不设上限，模型一口气写 8 场就能把额度烧光。默认 2。
  // 超出的场次在渲染时降级成文字卡并记日志（见 renderProject 的 planAiVideoQuota）。
  // 请求体可以带 maxAiVideo 覆盖本集上限（任务化之后每个任务自己决定）。
  maxAiVideo: 2,
  // 一条 AI 视频的总超时（提交 + 轮询 + 下载）。实测 100 秒出片，留到 8 分钟。
  wanTimeoutMs: 480000,
  // aivideo 场是否把参考图作为 first_frame_url 传上去。
  // 网关对未知字段常常"接受但忽略"，所以默认关闭；对照实验证实生效后再打开。
  aivideoImage: false,
  // 同时跑几个渲染任务。默认 1：manim/ffmpeg 都是 CPU 密集型，并发只会互相拖慢，
  // 而且 speak 的 BreezeBlue Starter 档并发上限就是 1。其余任务排队。
  jobConcurrency: 1,
  // 任务替模型调 io 时用的用户 id。插件/面板会带 x-dsh-user；直接 curl 提任务时
  // 没有身份，用一个固定的服务账号（默认 1）比"整个任务在写分镜阶段 E_UNAUTHORIZED"好。
  defaultUserId: 1,
  // 底部字幕带安全区（1080p 像素）：场景内容、表情包都不许低于 H-这个值。
  // 实测 marginBottom=120 + 字号 64 时字幕带占 [892,963]，所以 200 够用（含 12px 呼吸）。
  subtitleReservedPx: 200,
}, readJson(path.join(DIR, 'config.json'), {}));

/**
 * 底部"字幕带"高度（像素）：场景内容与表情包都不许低于 H-这个值。
 *
 * 为什么非要这么个数：字幕是烧在画面最下沿的（Alignment=2 + MarginV=subtitleMarginBottom），
 * manim 的 to_edge(DOWN) 和表情包的下角落都落在同一片区域，视频底边一有内容，
 * 字幕的黑底就正好压上去（用户实测反馈）。所以：
 *   1) 算出一个安全区，写进分镜/脚本提示词，让模型别把东西放那么低；
 *   2) 表情包叠图时按实际尺寸把这个区让出来（lib/overlay.js 的 bottomReserve）。
 * 字幕带高度 = 底边距 + 字高 + 一点呼吸；config 给了 subtitleReservedPx 就用它。
 */
function subtitleReservePx() {
  const explicit = Number(CFG.subtitleReservedPx);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const m = Number(CFG.subtitleMarginBottom) || 120;
  const f = Number(CFG.subtitleFontSize) || 64;
  return Math.round(m + f + 16);
}

// 把静帧模式交给渲染层（在 require 之后、任何 sceneClip 之前）
R.setStillMotion(CFG.stillMotion);

if (!CFG.projectDir) CFG.projectDir = path.join(CFG.outDir, 'projects');
// 内部服务令牌：插件替模型调 io 时用（插件没有用户 token）
if (!CFG.internalToken) CFG.internalToken = process.env.DSH_INTERNAL_TOKEN || '';

// 图片素材目录：分镜里 image 只是文件名时，render.js 要去某个目录下找图。
// 必须放在 CFG 合并之后补默认值 —— 默认值依赖 CFG.outDir，而 config.json 可能改了 outDir。
if (!CFG.imageDir) CFG.imageDir = path.join(CFG.outDir, 'images');
// 参考图（用户上传）：studio 自己的规范目录是 data/studio/uploads；
// 面板的 PUT /api/upload 落在 ../data/uploads（返回 uploadId）。两个目录都认，
// 但找面板的文件时会**复制**到 studio/uploads，避免面板的 30 分钟 TTL 把图删掉。
if (!CFG.uploadDir) CFG.uploadDir = path.join(CFG.outDir, 'uploads');
if (!CFG.panelUploadDir) CFG.panelUploadDir = path.join(DIR, '..', 'data', 'uploads');
// 人设→风格的缓存：跟成片放一起（data/studio/persona-style.json），
// 按 persona.version 失效，见 lib/styles.js 的 resolvePersonaStyle。
if (!CFG.styleCacheFile) CFG.styleCacheFile = path.join(CFG.outDir, 'persona-style.json');
// 规划缓存目录：data/studio/plan-cache/{scenes,skeletons}/<sha1>.json。
// 默认跟着 outDir 走（和 projects/jobs/library 并列），config.json 可以单独指定。
if (!CFG.planCacheDir) CFG.planCacheDir = path.join(CFG.outDir, 'plan-cache');
const planCache = PlanCacheLib.createPlanCache({
  dir: CFG.planCacheDir,
  enabled: CFG.planCache !== false,
  ttlDays: CFG.planCacheTtlDays,
  maxEntries: CFG.planCacheMaxEntries,
  log,
});
// 启动时清一次过期/超量：周末攒下的旧条目不该等到第一次写才清理。
try { planCache.sweep(); } catch { }

// AI 视频的密钥：**不写进代码、不进日志**，只从 secrets 读。
// 优先 config.wanKeyPath（服务器上是 C:\Apps\DSH-MultiTool\secrets\wan.key），
// 再退到同目录的 qwen.key，最后退到老 video 模块的 secrets.json（同一个 key）。
// 这样"新装一个 wan.key"和"沿用旧 key"都能跑，不用改配置。
if (!CFG.wanKeyPath) CFG.wanKeyPath = path.join(DIR, '..', 'secrets', 'wan.key');
if (!CFG.wanKeyJson) CFG.wanKeyJson = path.join(DIR, '..', 'video', 'secrets.json');

// 任务状态与"可重做配方"分开落盘（都在 data/studio 下，和成片并列）：
//   jobs/<jobId>.json    这一次执行到哪、成片在哪（重启后可以作废）
//   library/<jobId>.json 当初要做什么 + 最终分镜（重启后必须还在，能一键重跑）
const JOBS_DIR = path.join(CFG.outDir, 'jobs');
const LIBRARY_DIR = path.join(CFG.outDir, 'library');

// ---- 旁白驱动时长的三个常量（秒）----
// NARRATION_PAD：旁白念完之后留的余量。0.6 秒够一次换气，再短听着像被掐断。
const NARRATION_PAD = 0.6;
// NARRATION_FLOOR_PAD：总时长封顶时的绝对下限。宁可成片超一点总时长，也不能把一句话切两半。
const NARRATION_FLOOR_PAD = 0.3;
// MAX_SCENE_SECONDS：单场软上限。一张固定画面撑到 6 秒以上观众会走神；
// 但旁白本身超过 5.4 秒时这个上限让位给"不截断"（见 planWithNarration）。
const MAX_SCENE_SECONDS = 10;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.join(DIR, '..', 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DIR, '..', 'logs', 'studio.log'), line + '\n');
  } catch { }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * 渲染失败码 → HTTP 状态。
 * VOICE_UNAVAILABLE 用 503：这是"上游 TTS 没给音频"，不是请求的问题，
 * 调用方（面板/插件）应该按"稍后重试"处理，而不是当参数错误。
 */
function renderErrorStatus(result) {
  const e = String((result && result.error) || '');
  if (e === 'VOICE_UNAVAILABLE') return 503;
  if (e === 'NO_SCENES' || e === 'PLAN_REQUIRED' || e === 'PROMPT_REQUIRED') return 400;
  return 200;
}

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

async function getJson(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 10000)) });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: null }; }
  } catch (err) {
    return { status: 0, data: null, error: String(err && err.message || err) };
  }
}

// ------------------------------------------------------------ 渲染进度 ----
/**
 * 进度表：projectId -> 这一集渲染到哪一步。
 *
 * 为什么存在内存里：渲染是一个长 HTTP 请求（1~3 分钟），面板没法从响应里
 * 逐步拿到进度；但 Node 是单线程的，渲染等 ffmpeg 的 await 间隙完全可以
 * 服务 GET /v1/project/progress。所以进度只是"旁路信息"，丢了不影响出片，
 * 也不写盘（重启后旧进度本来就没意义）。
 */
const PROGRESS = new Map();
const PROGRESS_MAX = 24;

function progressStart(projectId, total) {
  const id = String(projectId || '');
  if (!id) return;
  const now = Date.now();
  PROGRESS.set(id, {
    id, status: 'running', phase: 'voice', total: Number(total) || 0, done: 0,
    current: -1, engine: '', label: '正在取旁白', error: '', detail: '',
    startedAt: now, updatedAt: now,
  });
  // 只留最近 24 个项目，别让这个 Map 跟着服务一起长
  if (PROGRESS.size > PROGRESS_MAX) {
    const oldest = [...PROGRESS.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) PROGRESS.delete(oldest[0]);
  }
}

function progressUpdate(projectId, patch) {
  const id = String(projectId || '');
  if (!id) return;
  const cur = PROGRESS.get(id) || { id, startedAt: Date.now(), total: 0, done: 0, current: -1 };
  PROGRESS.set(id, Object.assign(cur, patch || {}, { updatedAt: Date.now() }));
}

function progressGet(projectId) {
  const rec = PROGRESS.get(String(projectId || ''));
  if (!rec) return null;
  return Object.assign({}, rec, {
    elapsedMs: Date.now() - (rec.startedAt || Date.now()),
  });
}

// -------------------------------------------------------- 人设 / 绑定 ----
/**
 * 读人设。失败返回 { ok:false }，**不抛** —— 人设服务挂了只是让旁白少点个性，
 * 不该让整条视频创作链断掉。
 */
async function fetchPersona() {
  const r = await getJson(`${CFG.personaUrl}/v1/persona`, CFG.personaTimeoutMs);
  const d = r.data;
  if (!d || (d.ok === false)) return { ok: false, error: (d && d.error) || r.error || 'PERSONA_UNAVAILABLE' };
  const block = String(d.block || (d.persona && d.persona.block) || d.constitution || '');
  if (!block.trim()) return { ok: false, error: 'PERSONA_EMPTY' };
  const traits = d.traits && typeof d.traits === 'object' ? d.traits : {};
  const version = Number.isFinite(Number(d.version)) ? Number(d.version) : 0;
  // 正文第一行一般是"你是 XXX，……"，拿它当人设名给面板显示
  const nameMatch = block.match(/^(?:你是|我叫|我是)\s*([^\n，。,.！!？?]{1,20})/);
  return {
    ok: true, block, traits, version,
    name: nameMatch ? nameMatch[1].trim() : '',
  };
}

/**
 * 当前音色绑定。音色是 speak 按人设挑的（GET /v1/voice 会给 reason），
 * 这里只负责读出来 —— 两处各算一遍一定会算出不同的答案。
 */
async function fetchVoiceBinding() {
  const r = await getJson(`${CFG.speakUrl}/v1/voice`, 12000);
  const d = r.data;
  if (!d || d.ok === false) {
    return { ok: false, id: '', name: '', reason: (d && d.error) || r.error || 'VOICE_UNAVAILABLE', source: 'unavailable' };
  }
  return {
    ok: true,
    id: String(d.voiceId || ''),
    name: String(d.name || ''),
    reason: String(d.reason || ''),
    source: String(d.source || ''),
    cached: Boolean(d.cached),
    version: Number(d.version) || 0,
  };
}

/**
 * 一次拿齐"这集为什么是这个音色/风格/语气"。
 * 面板把它显示成一行：大肥鱼（迷糊版）· 白板讲解 · 温柔口语。
 */
async function resolveBinding(opts = {}) {
  const [persona, voice, styleInfo] = await Promise.all([
    fetchPersona(),
    fetchVoiceBinding(),
    resolveStyleFor({ styleId: opts.styleId || '' }),
  ]);
  const tone = PB.describeTone(persona.ok ? persona.block : '', persona.ok ? persona.traits : null);
  const voiceName = voice.ok && voice.name ? voice.name : '人设音色';
  const styleName = styleInfo.style ? styleInfo.style.name : '默认风格';
  return {
    persona: {
      name: persona.ok ? persona.name : '',
      version: persona.ok ? persona.version : 0,
      available: Boolean(persona.ok),
      error: persona.ok ? '' : persona.error,
    },
    voice: {
      id: voice.id || '', name: voiceName, reason: voice.reason || '',
      source: voice.source || '', cached: Boolean(voice.cached),
      available: Boolean(voice.ok), error: voice.ok ? '' : voice.reason,
    },
    style: {
      id: styleInfo.id, name: styleName, reason: styleInfo.reason || '',
      source: styleInfo.source || '', available: true,
    },
    tone: {
      label: tone.label,
      tags: tone.tags,
      selfRefs: tone.selfRefs,
      particles: tone.particles,
      address: tone.address,
      empty: Boolean(tone.empty),
    },
    summary: `${voiceName} · ${styleName} · ${tone.label}`,
    personaBlock: persona.ok ? persona.block : '',
    personaTraits: persona.ok ? persona.traits : {},
    styleObject: styleInfo.style,
    styleInfo,
  };
}

/**
 * 生成旁白时附带的语气块。人设读不到就返回空数组：没有依据时宁可不多写，
 * 也不要编一个"温柔"出来 —— 那会变成每次都不一样的人设。
 */
function tonePromptLines(binding, opts = {}) {
  if (!binding || !binding.tone || binding.tone.empty) return [];
  return PB.narrationTonePrompt(binding.tone, opts);
}


async function postJson(url, obj, headers = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers),
      body: JSON.stringify(obj),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { }
    return { status: res.status, data };
  } catch (err) {
    return { status: 0, data: { ok: false, error: String(err && err.message || err) } };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 分镜 ----

/**
 * 取几个表情给模型挑。优先收藏的（那是它自己"满意的"），不够再补"情绪覆盖"的。
 * 只给 10 个：给太多它会挑花眼，而且提示词会变长。
 *
 * 为什么不能只靠收藏 + /v1/list 默认顺序：没有收藏时 /v1/list 按名字排序，
 * 前 10 个会是「爱心/按钮/被击中/馋」—— 跟"时间膨胀"这种科普主题毫无关系，
 * 模型只能瞎配。这里用一组常用情绪各取一张，保证候选里有笑/哭/困/惊讶/无语，
 * 模型才可能真的挑到切题的那张。
 */
const STICKER_MOOD_SPREAD = ['笑', '哭', '睡觉', '惊吓', '汗', '生气', '点赞', '加油', '停止工作', '问号'];

async function stickerHints(limit = 10) {
  const grab = async (query) => {
    try {
      const res = await fetch(`${CFG.stickerUrl}/v1/list?${query}`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json().catch(() => null);
      return data && data.ok && Array.isArray(data.items) ? data.items : [];
    } catch { return []; }
  };
  const out = [];
  const seen = new Set();
  const push = (it) => {
    if (out.length >= limit) return false;
    const id = String((it && it.id) || '');
    if (!/^[0-9a-f]{6,40}$/i.test(id) || seen.has(id)) return false;
    seen.add(id);
    out.push({ id, name: String((it && (it.mood || it.name)) || id).slice(0, 16) });
    return true;
  };

  // 1) 收藏优先（用户/它自己点过星的）
  for (const it of await grab(`favorite=1&limit=${limit}`)) push(it);
  // 2) 收藏不够：按情绪各取一张，凑出"能表达情绪"的一组候选。
  // 用 q= 而不是 mood=：线上那版表情服务的搜索参数只有 q，传 mood 会被静默忽略，
  // 结果每次都拿回同一批「爱心/按钮」，模型根本没法挑。
  if (out.length < limit) {
    const spread = await Promise.all(
      STICKER_MOOD_SPREAD.map((m) => grab(`q=${encodeURIComponent(m)}&limit=1`)),
    );
    for (const items of spread) for (const it of items) push(it);
  }
  // 3) 还不够（表情模块缺某些情绪）：退回普通列表，至少保证候选不为空
  if (out.length < limit) {
    for (const it of await grab(`limit=${Math.max(limit * 3, 30)}`)) push(it);
  }
  return out;
}

/**
 * 把模型挑的表情打进日志：id + 情绪名 + 时间/位置。
 *
 * 自动规划"挑得切不切题"模型不会解释，日志是唯一可复盘的东西 ——
 * 这里把候选表反查成情绪名，一眼能看出"讲时间膨胀配了睡觉"这种选择。
 */
function logStickerPicks(stage, scenes, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const names = new Map(list.map((s) => [String(s.id || ''), String(s.name || '')]));
  const picks = [];
  (Array.isArray(scenes) ? scenes : []).forEach((s, i) => {
    for (const st of (s && Array.isArray(s.stickers) ? s.stickers : [])) {
      const id = String((st && st.id) || '');
      const name = names.get(id) || (list.length ? '不在候选里' : '没有候选');
      picks.push(`第${i + 1}场 ${id}=${name} @${Number(st.at) || 0}s ${Number(st.duration) || 0}s`);
    }
  });
  if (!picks.length) {
    log(`${stage}：这一集没有加表情`);
    return;
  }
  log(`${stage}：加了 ${picks.length} 个表情 -> ${picks.join('；')}`);
}

/** 把表情提示并进写分镜的参数（body 里显式给了就不覆盖）。 */
function withPlanHints(body, hints) {
  const opts = Object.assign({}, body || {});
  if (!Array.isArray(opts.stickerIds) && hints && hints.length) opts.stickerIds = hints;
  return opts;
}

/**
 * 逐场生成时的并发上限。
 *
 * 为什么封顶 3：4 核机器上「写一段 manim 脚本」是纯等远端模型（本地 cpu 几乎不动）。
 * 串行时 8 场要排 8 次队；3 路并发刚好把队伍压成三批，再多也不会有收益，
 * 只会让 io 侧排队更长、单次超时更容易踩到 planTimeoutMs。
 * config.json 的 planConcurrency 只能往下调（2 或 1，给弱机器/限流时用）。
 */
function effectivePlanConcurrency() {
  const n = Math.floor(Number(CFG.planConcurrency) || 3);
  return Math.max(1, Math.min(3, n));
}

/**
 * 简单工作池：最多 limit 个任务同时跑，结果按**原下标**回填。
 *
 * 为什么要按下标回填：完成顺序是乱的，分镜顺序不能乱 —— 按完成顺序塞数组
 * 会让第 5 场拿到第 2 场的代码，成片直接串场。
 * 为什么 worker 抛异常不打断其它场：某一场的失败只该降级那一场
 * （文字卡兜底），其它场照常出 manim。
 */
async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  if (!list.length) return results;
  const width = Math.max(1, Math.min(Math.floor(Number(limit) || 1), list.length));
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      try {
        results[i] = await worker(list[i], i);
      } catch (err) {
        results[i] = { ok: false, error: `WORKER_THROW: ${String((err && err.message) || err).slice(0, 160)}` };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => run()));
  return results;
}

/**
 * 场与场之间的渲染并发（manim 一场一个进程，4 核机器上串行会闲置 3 核）。
 *
 * 上限硬编码 2 而不是按核数算：每场内部 manim 自己还会 spawn ffmpeg，
 * 1080p 一场的峰值内存约 300~500MB，4GB / 4 核的机器上 3 路并发就开始换页。
 * config.renderConcurrency 只能往下调（1=串行）。
 *
 * 内存保护：并行前看 os.freemem()，低于 FREE_MIN_MB 就本轮降级为串行。
 * 阈值可用 config.renderFreeMemMinMb 覆盖（测试/弱机器），别去改常量。
 */
const RENDER_CONCURRENCY_MAX = 2;
const FREE_MIN_MB = 1200;

function effectiveRenderConcurrency() {
  const want = Math.floor(Number(CFG.renderConcurrency) || 2);
  const cap = Math.max(1, Math.min(RENDER_CONCURRENCY_MAX, want));
  const freeMb = Math.round(os.freemem() / 1048576);
  const needMb = Math.max(1, Math.round(
    Number(process.env.STUDIO_FREE_MIN_MB) || Number(CFG.renderFreeMemMinMb) || FREE_MIN_MB,
  ));
  if (cap <= 1) {
    return {
      limit: 1, freeMb, needMb, configured: want,
      reason: `串行渲染（renderConcurrency=${want}，硬上限 ${RENDER_CONCURRENCY_MAX}）`,
    };
  }
  if (freeMb < needMb) {
    return {
      limit: 1, freeMb, needMb, configured: want, degraded: true,
      reason: `可用内存 ${freeMb}MB < ${needMb}MB，本轮串行渲染`,
    };
  }
  return {
    limit: cap, freeMb, needMb, configured: want,
    reason: `渲染并发 ${cap}（可用内存 ${freeMb}MB ≥ ${needMb}MB，4 核留 2 路）`,
  };
}

/**
 * 场数建议：按总时长给区间，替代以前写死的「3~80 场」。
 *
 * 60 秒配「3~80 场」时模型会拆 8 场（每场 7.5 秒），一场只闪一下，像 PPT。
 * 现在按秒数给建议，并保留 80 场上限（CFG.maxScenes）。
 */
function sceneCountHint(total) {
  const t = Math.max(1, Number(total) || 0);
  if (t <= 30) return { min: 3, max: 4, per: '每场 7~10 秒' };
  if (t <= 60) return { min: 4, max: 6, per: '每场 8~15 秒' };
  if (t <= 120) return { min: 6, max: 9, per: '每场 10~20 秒' };
  // 长片按「每 15 秒 1 场」估，上下各留 2 场浮动；仍然守 80 场上限
  const n = Math.max(8, Math.round(t / 15));
  return {
    min: Math.max(8, n - 2),
    max: Math.max(8, Math.min(CFG.maxScenes, n + 2)),
    per: '每场 15 秒左右',
  };
}

/**
 * 让 DSH 写分镜。
 *
 * 现在只有两种场景：
 *   manim —— 一段 Manim 脚本，渲成真动画（默认，≥80% 场次）
 *   text  —— 渐变背景 + 一行大字（开场/转场/结论，不走 manim，快）
 *
 * 早期的 rich(GDI)/plot(matplotlib)/html(无头浏览器) 三条路仍在渲染层里，
 * 但规划不再选择它们 —— 用户要求"视频只用 manim"。
 *
 * 两段式规划：先只要分镜骨架（短、几乎不会跑偏），再逐场把"这一场讲什么"
 * 翻成一段 manim 脚本。一次只问一场 —— 输出小，失败也只影响那一场。
 */
async function askJson(promptText, opts = {}) {
  const call = async (text) => {
    const r = await postJson(`${CFG.ioUrl}/v1/input`,
      { text, sessionId: opts.sessionId || 'studio-plan', persona: false },
      ioAuthHeaders(opts.req), CFG.planTimeoutMs);
    return { ok: Boolean(r.data && r.data.ok), answer: (r.data && r.data.answer) || '' };
  };
  const first = await call(promptText);
  if (!first.ok) return { ok: false, error: 'IO_FAILED' };
  let parsed = parsePlan(first.answer);
  if (parsed) return { ok: true, json: parsed };
  // 重试：把它自己的输出贴回去，明确"只保留 JSON"
  const repair = `${promptText}\n\n你上一次的输出不是合法 JSON（开头如下）：\n${String(first.answer).slice(0, 300)}\n\n现在只输出 JSON，第一个字符必须是 {。`;
  const second = await call(repair);
  parsed = second.ok ? parsePlan(second.answer) : null;
  if (parsed) return { ok: true, json: parsed, repaired: true };
  return { ok: false, error: 'PLAN_NOT_JSON', raw: String(second.answer || first.answer).slice(0, 400) };
}

// ------------------------------------------------------------- 规划缓存 ----
// 为什么要有：一集 60 秒拆 4~8 场，每场一次模型调用 20~140 秒。用户第二次做同一主题、
// 或者只改一句旁白，明明大部分输入一字不差，却要重跑全部。这里按内容哈希复用规划结果。
//
// 两层，键都在 lib/plan-cache.js 里：
//   场级    sha1(normalize(visual_hint) | normalize(标题) | 风格签名 | 引擎) → 一段 manim 代码
//   骨架级  sha1(normalize(稿子/主题) | 秒数 | 风格签名 | 语气) → 整份分镜数组
// 场级键里必须有**标题**：manim 代码把标题写死成 Text("…")，只改标题时 hint 没变，
// 不含标题的键会命中旧代码 —— 成片里就还是旧标题（用户实测的"改了不生效"）。
// 严格不命中的情况：换风格（签名不同）、改 visual_hint 或标题（键变）、请求带 fresh:true、
// 条目损坏/过期、缓存里的代码过不了安全闸门（UNSAFE_CODE 之类，删掉重问）。

/** 风格进缓存键的指纹：第一位是风格 id，配色/线宽/字体变了签名也会变。 */
function styleCacheKey(style) {
  return S.signature(style) || 'none';
}

/**
 * 这一场"画什么"的缓存材料。
 * 有 visual_hint 就用它（写稿模式每条都有）；没有时用标题 ——
 * 那时代码本来只依赖这句话，用它当键才既不改语义又能命中。
 *
 * **不用旁白**：旁白不进 manim 代码（只走混音/字幕），放进来会让"只改台词"
 * 也重新生成一次动画。标题则必须算材料 —— 它是写死在代码里的字符串，见 sceneKey。
 */
function sceneCacheText(scene) {
  const hint = String((scene && scene.visual_hint) || '').trim();
  if (hint) return hint;
  return String((scene && scene.text) || '').trim();
}

/** 这一场进规划缓存的全部材料：hint + 标题 + 风格 + 引擎，和 manimHint 戳同一份算法。 */
function sceneCodeMaterials(scene, kind, style) {
  return {
    hint: sceneCacheText(scene),
    text: String((scene && scene.text) || ''),
    style: styleCacheKey(style),
    kind: String(kind || 'manim'),
  };
}

/**
 * 这一场能不能进缓存。
 * 参考图场不进：代码会用 ImageMobject 嵌那张图，而键里没有图的内容，
 * 换了图却命中旧代码，成片就是旧图 —— 宁可重问一次。
 */
function sceneCacheable(scene, kind) {
  if (String(kind || '').toLowerCase() !== 'manim') return false;
  if (!sceneCacheText(scene)) return false;
  const img = String((scene && (scene.imagePath || scene.image)) || '').trim();
  return !img;
}

/**
 * 单场模型调用的缓存包装：命中直接返回，未命中走 askJson 并把**过了安全闸门**的代码写回。
 *
 * 为什么安全过滤放在写缓存之前：UNSAFE_CODE / NO_LATEX 的代码是坏结果，
 * 缓存它等于把"这一场出文字卡"永久钉死 —— 下次连重问的机会都没有了。
 *
 * opts 里额外认两个字段（其余原样传给 askJson）：
 *   sceneIndex  日志里的场次号
 *   fresh       显式重新规划：不查也不写
 */
async function planSceneCode(scene, kind, style, opts = {}) {
  const index = Number.isInteger(opts.sceneIndex) ? opts.sceneIndex : null;
  const label = index == null ? 'scene#?' : `scene#${index}`;
  const fresh = opts.fresh === true;
  const keyInput = sceneCacheable(scene, kind)
    ? sceneCodeMaterials(scene, kind, style)
    : null;

  if (keyInput && !fresh) {
    const hit = planCache.getScenePlan(keyInput);
    if (hit && hit.code) {
      const clean = stripMathDelims(hit.code);
      const bad = Manim ? Manim.checkCode(clean) : 'manim 模块不可用';
      if (!bad) {
        log(`${label} 命中场级规划缓存（hint+标题 哈希 ${PlanCacheLib.shortHash(hit.key)}）`);
        return { ok: true, json: { manim: { code: clean, scene: hit.scene || null } }, cacheHit: true };
      }
      // 缓存里是坏代码：只有"代码被拒"这一种情况会走到这里（写之前已经拦过），
      // 说明是旧版本写进去的。删掉重问，别让一条坏条目把这一场永久降级。
      planCache.dropScenePlan(keyInput);
      log(`${label} 场级缓存里的代码不合格（${bad}），已删除并重新生成`);
    }
  }

  const r = await askJson(buildVisualPrompt(scene, kind, style), opts);
  if (r.ok && keyInput && !fresh) {
    const manimObj = r.json && r.json.manim && typeof r.json.manim === 'object' ? r.json.manim : null;
    const code = manimObj && typeof manimObj.code === 'string' ? stripMathDelims(manimObj.code) : '';
    // 空代码 / 过不了闸门的一律不写：缓存只存"确定能渲"的结果
    const bad = code ? (Manim ? Manim.checkCode(code) : 'manim 模块不可用') : 'EMPTY_CODE';
    if (!bad) {
      planCache.putScenePlan(Object.assign({}, keyInput, {
        code,
        scene: (manimObj && manimObj.scene) || null,
      }));
    }
  }
  return r;
}

/** 骨架级缓存的键材料。mode 区分"主题"和"整稿"两条路，两者结构不同，不能互相命中。 */
function skeletonMaterials({ text, seconds, style, mode, toneLines }) {
  const tone = Array.isArray(toneLines) ? toneLines.join('\n') : String(toneLines || '');
  return {
    text: String(text || ''),
    seconds: Number(seconds) || 0,
    style: styleCacheKey(style),
    extra: `${mode || 'plan'}\n${tone}`,
  };
}

/** 记一条骨架缓存（结构不合格时不写）。 */
function rememberSkeleton(materials, json) {
  const scenes = json && Array.isArray(json.scenes) ? json.scenes : null;
  if (!scenes || !scenes.length) return false;
  return planCache.putSkeleton(Object.assign({}, materials, {
    title: String((json && json.title) || ''),
    scenes,
  }));
}

/**
 * 分镜骨架提示词。
 *
 * 这里只允许两种画面：manim（默认，占绝对多数）和 text（文字卡）。
 * plot(matplotlib) 与 draw(GDI 图元) 的渲染分支还留在代码里，是给旧项目兜底的，
 * **不再被规划选中** —— 用户要求"视频只使用 manim"。所以提示词里连提都不提它们，
 * 提一句模型就会写一句。
 */
function buildSkeletonPrompt(prompt, total, opts = {}) {
  const style = opts.style || null;
  const hint = sceneCountHint(total);
  const stickerIds = Array.isArray(opts.stickerIds) ? opts.stickerIds.slice(0, 10) : [];
  const toneLines = Array.isArray(opts.toneLines) ? opts.toneLines : [];
  const lines = [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `给这个主题写分镜：${prompt}`,
    `总时长约 ${total} 秒。`,
    '{"title":"标题","scenes":[{"text":"这一场标题（≤14字）","narration":"旁白（≤30字，口语）","seconds":4,"visual":"manim"}]}',
    'aivideo 场的形状：{"text":"…","narration":"…","seconds":5,"visual":"aivideo","video":{"prompt":"anime style, cel shading, wide shot, blue-haired ice fairy flying over a snowy forest","size":"1280*720"}}',
    '',
    '## 画面引擎（三种取值：manim / aivideo / text）',
    '- visual 只能是 manim、aivideo 或 text。manim 仍是主力：除 aivideo 与开头结论外都用 manim。',
    '- visual 选 aivideo 的情况：需要人物、场景、动作、氛围（故事、情节、拟人化演示）',
    '- visual 选 manim 的情况：公式、坐标、曲线、精确动画、推导过程',
    `- 一条视频里 aivideo 最多 ${Math.max(0, Number(CFG.maxAiVideo) || 0)} 场（每条生成要 100 秒且占额度），其余用 manim`,
    '- manim：用 Manim 演一段真动画 —— 曲线生长、切线滑动、公式逐项变形、点在轨迹上跑、坐标轴里量出结论。',
    '- manim 场里出现的文字（写脚本时照做）：中文一律 Text(..., font="Microsoft YaHei")；',
    '  **标题 font_size ≥ 44 且必须 weight=BOLD**，正文/标注 font_size ≥ 32（不低于 28）——',
    '  Microsoft YaHei 常规字重很细，标题不加 BOLD、字号又小，成片里会细得看不清。',
    '- text：纯文字卡（渐变底 + 一行大字），只用于开场、转场、下结论；一集最多 1~2 场。',
    '- 不要写 plot / draw / rich：这两条旧路子已停用（写了也会被当成 text，白占一场）。',
    '- 讲"变化过程 / 运动 / 逐渐逼近"的场次必须用 manim，不要拿一张静止的图糊过去。',
    '',
    '## aivideo 场的 video.prompt（生成画面的唯一依据）',
    '- 必须英文：说清主体 + 动作 + 风格 + 镜头，例如 "anime style, cel shading, wide shot, a girl flying over a snowy plain, wind blowing"。',
    '- **≤120 字符**，只写一句，不要引号、不要中文、不要换行；不要把公式/坐标轴/文字写进去（那些用 manim）。',
    '- size 固定写 "1280*720"；seconds 写 5（生成片段就是 5 秒，长了会自动截断）。',
    '',
    `- 场数 ${hint.min}~${hint.max} 场；${hint.per}；加起来接近 ${total} 秒。`,
    '- 宁可少几场、每场讲透，不要一场只闪 3 秒。',
    '- narration 是给人听的：口语、一句一个意思，下一场接上一场。',
    '- 不要出现 markdown、不要解释你的做法。',
  ];
  if (style) lines.push('', `视觉风格：${style.name}（配色与节奏由后续每场的脚本落实，骨架阶段不用管）`);
  if (toneLines.length) lines.push('', ...toneLines);
  if (stickerIds.length) {
    lines.push(
      '',
      '## 角色形象 → 用表情包，不要用 manim 画（硬规则，优先级最高）',
      '- 表达**情绪、反应、自嘲、角色存在感**（"我是谁"、吐槽、惊讶、下结论、卖萌）时：**不要**用 manim 画角色形象，',
      '  改为在 stickers 里配一张对应的表情包 —— 现成的 100+ 张 GIF 比手画的好看得多，也是"大肥鱼本人在场"的唯一正确表达。',
      '- 明确例子：`介绍自己` → 配一张"大肥鱼"表情包；`说到结论` → 点赞/笑；`说到困惑` → 问号/汗。',
      '- 只有"必须精确的示意图 / 公式 / 坐标 / 曲线 / 推导"才用 manim 画；角色与情绪一律交给表情包。',
      '- 介绍自己那一场：visual 写 manim 但只画背景/标题一类无害元素，情绪由 stickers 承担；visual_hint 里**不要**写"画一只鲸鱼/大肥鱼本人"。',
      '',
      '## 表情包（可选，用来加"大肥鱼"的在场感）',
      '- 只放在情绪点上：吐槽、惊讶、结论、自嘲。没有情绪点的场次不要放。',
      '- 每条视频 1~3 处就够（不是每场都放，最多 3 场）；同一场最多 1 个。',
      '- 在场景对象里加 stickers 数组，一项长这样：',
      '  {"id":"<下面列表里的 id>","at":1.2,"duration":1.8,"x":0.82,"y":0.12,"scale":0.3}',
      '  - at：这一场里的第几秒开始，放中后段（0.5~2 秒起；且不要超过这一场的 seconds-1.5）',
      '  - duration：1.2~2.2 秒，表示"最晚在这之前必须把一轮表情播完"。播完不会消失，',
      '    而是停在最后一帧一直留到本场结束 —— 所以别把表情放在"马上要切走"的位置。',
      '  - x/y：0~1 的相对位置，放角落别挡住图和公式。**底部约 1/5 是字幕带，不许放**：',
      '    右上 0.82/0.12，左上 0.10/0.12，右下 0.82/0.62，左下 0.10/0.62（y 最大 0.68）。',
      '  - scale：0.25~0.38（占画面高度的比例；0.3 在 1080p 下约 324px 高）',
      `- 可用表情（id=情绪）：${stickerIds.map((s) => `${s.id}=${s.name}`).join('，')}`,
      '- 只能从上面这个列表里挑 id；没有合适的那一场就干脆不加，宁缺勿滥。',
      '- **但整集至少要有 1 个表情；讲"我 / 自己 / 大肥鱼"的那一场必须有**（笑、爱心、点赞都算）。',
      '  那一场不要靠 manim 画角色来"表示自己"——角色由表情包出场，画面只负责标题/示意。',
    );
  }
  return lines.join('\n');
}

/**
 * 写稿 → 分镜：拆场提示词。
 *
 * 和"给个主题写分镜"最大的区别：这一轮的旁白**必须来自稿子原话**。
 * 模型天生爱润色，所以约束写成"可以删字、可以截断，但不要换说法"，
 * 并明确"不要改写成书面语"。
 */
function buildScriptSplitPrompt(script, total, opts = {}) {
  const style = opts.style || null;
  const toneLines = Array.isArray(opts.toneLines) ? opts.toneLines : [];
  // 场数按总时长给建议，不再写死「4~10 场」：60 秒被拆成 10 场时每场只闪 6 秒，
  // 一场讲不完一个意思。上限仍然是 CFG.maxScenes（80）。
  const hint = sceneCountHint(total);
  const lines = [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `把下面这份稿子拆成分镜。总时长约 ${total} 秒，拆 ${hint.min}~${hint.max} 场，${hint.per}。`,
    '{"title":"标题","scenes":[{"text":"这一场的标题（≤14字）","narration":"这一场念的旁白（稿子原话截取，≤40字）","seconds":8,"visual_hint":"这一场画面画什么（一句话，具体到图形/公式/动作）","tool":"manim"}]}',
    '',
    '## 原话优先（最重要）',
    '- narration 必须是稿子里**出现过的话**：可以删字、可以截断、可以调顺序，但不要换说法、不要润色、不要改写成书面语。',
    '- text 是从这句原话里抽出来的短标题，≤14 字，不要另起一句。',
    '- 稿子里如果本来就是书面语，旁白照抄；不要为了"口语"把它改写掉。',
    '',
    '## 拆场',
    '- 一场只讲一个意思：转折、举例、公式、结论各成一场。',
    '- 宁可少几场、每场讲透，不要一场只闪 3 秒。',
    '- visual_hint 要写成"别人照着就能画"的一句话：画什么图形、标什么量、做什么动作。',
    '- **visual_hint 里不要写"画一条鲸鱼 / 画大肥鱼本人 / 画一个角色"**：角色形象与情绪由表情包承担，',
    '  写了 manim 就会去手绘一只鲸鱼，而那只鲸鱼一定比现成表情包难看。',
    '- 表达情绪、反应、自嘲、"我"的场次：visual_hint 只写背景/示意图（例如"标题在顶部，主体留白"），情绪交给 stickers。',
    '- tool 只能是 manim 或 text；**至少 80% 的场次用 manim**，text 只给开场/转场/一句结论。',
    '- 讲到公式、坐标轴、曲线、变化过程、对比大小的场次必须 manim。',
    '- 场数不超过 ' + hint.max + '；加起来接近 ' + total + ' 秒。',
    '- 不要 markdown、不要解释、不要在 JSON 前后加字。',
    '',
    '## 稿子',
    String(script || '').slice(0, 6000),
  ];
  if (style) lines.push('', `视觉风格：${style.name}（配色与节奏由后续每场的脚本落实）`);
  if (toneLines.length) lines.push('', ...toneLines);
  return lines.join('\n');
}


/**
 * 单场 manim 脚本的提示词。
 *
 * 这些"硬约束"是踩出来的，不是猜的：
 *   - 服务器装的是 MiKTeX（MathTex/Tex 能编译，首次约 25 秒、之后 7 秒），
 *     所以公式**必须**用 MathTex，而不是像以前那样逼模型拿 Unicode 拼。
 *   - 但 DecimalNumber / Integer / include_numbers 内部也走 TeX 且逐帧排版，
 *     又慢又容易失败 —— 坐标轴刻度数字一律禁止，要数字用 Text 手标。
 *   - 中文 Text 不指定 font 会 fallback 成没有中文字形的字体，出一排方框。
 *   - 代码要能被 checkCode 放行：文件/网络/import 越权一律拒收。
 */
function buildVisualPrompt(scene, kind, style) {
  const hint = String(scene.visual_hint || '').trim();
  // 底部字幕带换算成 manim 的坐标单位：manim 默认 frame 高 8 单位，
  // 所以 1 单位 = 画面高/8（1080p 下一单位 135px），200px 的安全区约 1.5 单位。
  const reservePx = subtitleReservePx();
  const unitPx = (Number(CFG.height) || 1080) / 8;
  const reserveUnits = Math.ceil((reservePx / unitPx) * 10) / 10;
  const head = [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `要画这一场：标题「${scene.text}」，旁白「${scene.narration}」`,
    `这一场要演 ${Number(scene.seconds) || 4} 秒。`,
    '',
  ];
  if (hint) {
    head.push(
      '## 用户指定的画面（最高优先级，必须照着画）',
      hint.slice(0, 600),
      '',
      '上面这段是用户自己写的"画什么"。把它翻译成 manim 动画：图形、元素、动作、先后顺序都要对上；',
      '不要换成另一个画法，也不要只画个标题糊过去。旁白只用来对齐节奏，不是画面内容。',
      '例外：如果这段里写的是"画一只鲸鱼 / 画大肥鱼本人 / 画一个角色"这类**角色形象**，角色部分忽略 ——',
      '角色由表情包出场，你只画除此之外的元素（示意图/公式/背景）。',
      '',
    );
  }
  // 参考图：这一场有用户上传的图，必须让模型用 ImageMobject 真的嵌进去。
  // 路径已经由 attachSceneImages 解析成绝对路径（uploads 目录内）。
  const imagePath = String(scene.imagePath || scene.image || '').trim();
  if (imagePath && String(kind || '').toLowerCase() !== 'aivideo') {
    head.push(
      '## 这一场有一张参考图（必须用上）',
      `图片绝对路径：${imagePath}`,
      '必须用 ImageMobject 把这张图嵌进画面，不要自己画一个近似图形代替它。',
      '推荐写法（背景层）：bg = ImageMobject("<上面的路径>").scale_to_fit_height(config.frame_height); bg.set_opacity(0.35); self.add(bg)',
      '也可以当画中画：ImageMobject("<上面的路径>").scale(0.4).to_corner(DR)',
      '图片路径必须原样照抄，不要改路径，也不要用 open/PIL 去读它。',
      '',
    );
  }
  // AI 生成画面：这里不问 manim 脚本，只要一条英文 prompt（生成模型只认这个）
  if (String(kind || '').toLowerCase() === 'aivideo') {
    return buildAiVideoPrompt(scene, hint).join('\n');
  }
  // 这一场已经配了表情包：明确告诉模型"角色已经出场了，别再画一遍"
  const sceneStickers = (Array.isArray(scene.stickers) ? scene.stickers : [])
    .filter((s) => s && s.id)
    .map((s) => `id=${String(s.id).slice(0, 12)} @${Number(s.at) || 0}s`)
    .join('、');
  const body = [
    '{"manim":{"scene":"TangentAnim","code":"from manim import *\\nclass TangentAnim(Scene):\\n    def construct(self):\\n        ..."}}',
    '',
    '## 不要画角色形象（硬规则，优先于上面「照着画」的指示）',
    '- 这一场的**情绪、反应、自嘲、"我"的存在感不是你该画的东西**：不要用 manim 画鲸鱼、大肥鱼、任何拟人角色。',
    '- 角色出场由渲染器贴现成的表情包 GIF 完成（现成素材比手画的好看得多）；你只画必须精确的部分：',
    '  示意图、公式、坐标轴、曲线、流程、对比。',
    '- 如果整场的重点就是"角色在表达情绪"，就只画一句短标题（Text）当背景，画面主体留给表情包。',
    '## 这一场为什么是 manim 而不是 aivideo',
    '- visual 选 aivideo 的情况：需要人物、场景、动作、氛围（故事、情节、拟人化演示）——如果这一场其实是这种，说明规划写错了，仍按 manim 画能画的部分。',
    '- visual 选 manim 的情况：公式、坐标、曲线、精确动画、推导过程。',
    '',
    '## 脚本硬约束（违反会被拒收，直接降级成文字卡）',
    '- 只写 `from manim import *` + 一个 `class <英文类名>(Scene):` 和它的 `def construct(self):`；manim.scene 必须与类名逐字一致',
    '- import 只允许 manim 和 numpy；其它一律不许',
    '- **禁止**：读写文件、网络、subprocess、open()、eval()、exec()、__import__、Scene.embed',
    '- 代码 **≤60 行**，单类，不要 __main__，不要注释掉的旧版本',
    '',
    '## 允许用的东西',
    '- 文字：Text；公式：MathTex（LaTeX 已装，直接写 r"$\\frac{dy}{dx}$" 这种，不需要 usepackage）',
    '- 图形：Axes、NumberPlane、Line、Arrow、Dot、Circle、Rectangle、Square、Polygon、SurroundingRectangle、VGroup、NumberLine、axes.plot',
    '- 动作：Write、Create、FadeIn、FadeOut、Transform、ReplacementTransform、GrowArrow、Rotate、Indicate、.animate、VGroup.arrange、self.wait',
    '- 排版：self.play(..., run_time=1.2) 控制节奏；标题用 .to_edge(UP, buff=0.5)',
    `- **底部 ${reservePx}px（约 ${reserveUnits} 个坐标单位）是字幕带，不许放任何内容**：` +
      '字幕烧在画面最下沿，东西放低了就被字幕黑底压住。',
    `  最低的元素离画面底边至少 ${reserveUnits} 个单位：要贴底就写 .to_edge(DOWN, buff=${reserveUnits})，` +
      '不要用默认的 .to_edge(DOWN)（默认 buff=0.5 会进字幕带）。',
    '',
    '## 文字排版硬约束（字重/字号，必须照做）',
    '- 中文字体一律 Text("…", font="Microsoft YaHei")：这是服务器上唯一有中文字形的字体，不写会出一排方框。',
    '- **标题**：font_size ≥ 44，并且**必须写 weight=BOLD**。Microsoft YaHei 的常规字重笔画很细，',
    '  投影到大屏、再经 ffmpeg 编码之后会糊成一片 —— 标题不加 weight=BOLD 就是不合格。',
    '- **正文/标注**：font_size ≥ 32（任何文字都不要低于 28）；正文不要比标题还大。',
    '- 写法示例：`title = Text("两点之间的度量", font="Microsoft YaHei", font_size=52, weight=BOLD).to_edge(UP)`；',
    '  正文示例：`label = Text("斜率 = 2", font="Microsoft YaHei", font_size=36)`。',
    '- 一屏里最多一个标题；标题 ≤14 字，长句拆成两行 Text 或用 VGroup 叠放，不要靠缩字号硬塞。',
    '',
    '## 三个必须避开的坑',
    '- **坐标轴不要 include_numbers=True**（刻度数字是 DecimalNumber，内部走 TeX，慢且容易失败）；要数字就用 Text 在轴旁手标',
    '- 不要用 DecimalNumber / Integer；公式只有 MathTex 一种正确写法',
    '- **MathTex 的参数不要再包 $**：写 MathTex(r"\\frac{dy}{dx}")，不要写 MathTex(r"$\\frac{dy}{dx}$") —— 包了 LaTeX 直接编译失败，整场会降级成文字卡',
    '- 不要设背景色、不要 import 颜色表：背景和配色由渲染器按风格统一注入',
    '',
    '## 排序',
    '- 按旁白顺序一步一步 self.play 出来，不要一次全摆上去；所有 run_time 加起来贴近本场秒数',
    '- 每场只讲一个点，结尾 self.wait(0.4) 收住；宁可少画，不要把画面塞满',
    '- Axes 的 y_length 不超过 5.0，轴标签放端点外侧，别让标题压住坐标轴箭头',
    '- 颜色写成十六进制的字符串（color="#4dff88"），用下面风格给的色值',
  ];
  if (sceneStickers) {
    body.push(`- 这一场已经安排了表情包（${sceneStickers}）：角色不用再画，也别占同一个角落。`);
  }
  if (style) body.push('', S.promptBlock(style));
  return head.concat(body).join('\n');
}


/**
 * 单场 AI 画面的提示词：把这一场的中文描述翻成**一条英文生成 prompt**。
 *
 * 为什么不直接把中文塞给 wan：实测生成模型对英文主体/镜头词敏感得多，
 * 而且中文 prompt 一长就容易出抽象画面。所以这里限定：英文、≤120 字符、
 * 必须含主体 + 动作 + 风格 + 镜头 —— 四个要素缺一个，生成结果就会飘。
 */
function buildAiVideoPrompt(scene, hint) {
  const lines = [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `这一场用 AI 视频模型生成画面：标题「${scene.text || ''}」，旁白「${scene.narration || ''}」`,
    `这一场 ${Number(scene.seconds) || 5} 秒（生成片段固定 5 秒，长的部分会截断）。`,
    '',
    '## 输出形状',
    '{"video":{"prompt":"anime style, cel shading, wide shot, a girl in a white coat flying over a snowy plain","size":"1280*720"}}',
    '',
    '## prompt 硬要求',
    '- **必须是英文**，只写一句，不要引号、不要换行、不要中文、不要解释。',
    '- **≤120 字符**（写长了会被截断，风格词就丢了）。',
    '- 四个要素都要有：主体（谁/什么）+ 动作（在做什么）+ 风格（anime style / cel shading / cinematic / watercolor…）+ 镜头（wide shot / close-up / tracking shot…）。',
    '- 描述"看得见的东西"：人物外貌、环境、光线、氛围。不要写抽象概念、不要写公式和坐标轴、不要把标题文字写进去。',
    '- 一条 prompt 只讲一个连续镜头（5 秒讲不了两件事）；需要多个画面就拆成另外几场。',
    '',
    '## 什么时候不该用 aivideo',
    '- 公式、坐标轴、曲线、推导过程 → 这些必须是 manim，生成模型画不出准确的图。',
    `- 一条视频里 aivideo 最多 ${Math.max(0, Number(CFG.maxAiVideo) || 0)} 场（每条生成要 100 秒且占额度），其余用 manim。`,
  ];
  if (hint) {
    lines.push(
      '',
      '## 这一场要的画面（最高优先级）',
      hint.slice(0, 600),
      '',
      '把上面这段翻成英文 prompt：主体、动作、风格、镜头都要对得上，不要换成别的场景。',
    );
  }
  const imageRef = String(scene.imagePath || scene.image || '').trim();
  if (imageRef) {
    lines.push(
      '',
      '## 参考图（首帧）',
      `这一场有一张参考图：${imageRef}`,
      'prompt 要延续这张图的构图、主体和风格，不要写成完全不同的场景（生成时这张图会作为 first_frame_url 传入）。',
    );
  }
  return lines;
}



/**
 * 去掉 MathTex/Tex 参数外面多包的一层 $...$。
 *
 * 为什么需要：MathTex 本身就在数学模式里，再包 $ 会让 LaTeX 直接编译失败。
 * 实测模型写 MathTex(r"$\frac{dy}{dx}$")，整场 manim 报 MANIM_FAILED 降级成文字卡 ——
 * 提示词里能叮嘱，但它十次里总有一两次手滑，所以这里做确定性清洗。
 * 只处理 "MathTex('...')" / "Tex('...')" 整串参数，不碰其它字符串。
 */
function stripMathDelims(code) {
  return String(code == null ? '' : code).replace(
    /\b(MathTex|Tex)\(\s*(r?)(["'])\s*\$+([\s\S]*?)\$+\s*\3\s*\)/g,
    (m, fn, raw, quote, inner) => `${fn}(${raw}${quote}${inner}${quote})`,
  );
}

// ------------------------------------------------------------ 参考图（上传）----
// 用户上传的图片：scene.image 可能是 uploadId、/api/upload/<id> 链接，或绝对路径。
// 只认两个目录（studio/uploads 与面板的 data/uploads），扩展名白名单，禁止 ..
// 逃逸 —— 分镜 JSON 是模型/面板给的，不能当成读任意文件的入口。
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function imageRoots() {
  return [CFG.uploadDir, CFG.panelUploadDir].filter(Boolean).map((p) => path.resolve(p));
}

function pathInside(dir, file) {
  const rel = path.relative(dir, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function imageExtOk(file) {
  return IMAGE_EXTS.has(path.extname(String(file || '')).toLowerCase());
}

/** 在 uploads 目录里按 uploadId 找文件（面板的文件名是 <uuid><ext>）。 */
function findUploadedById(id) {
  for (const root of imageRoots()) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(`${id}.`)) continue;
      const file = path.join(root, name);
      if (!imageExtOk(file)) continue;
      try { if (fs.statSync(file).isFile()) return file; } catch { }
    }
  }
  return '';
}

/** 面板目录里的图复制进 studio/uploads：面板 30 分钟 TTL 不能影响已经在跑的任务。 */
function copyIntoStudioUploads(src) {
  const root = path.resolve(CFG.uploadDir);
  const abs = path.resolve(src);
  if (pathInside(root, abs)) return abs;
  fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, `${crypto.randomUUID()}${path.extname(abs).toLowerCase()}`);
  fs.copyFileSync(abs, dest);
  return dest;
}

/**
 * 解析一场的 image 引用。
 * 返回 { ok, path, source } 或 { ok:false, error }，永不抛。
 */
function resolveSceneImage(ref) {
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) return { ok: false, error: 'EMPTY' };
  if (raw.includes('\0')) return { ok: false, error: 'BAD_PATH' };

  // 1) uploadId / /api/upload/<id> 链接
  let id = '';
  const m = raw.match(/\/api\/upload\/([0-9a-fA-F-]{8,64})/);
  if (m) id = m[1];
  else if (/^[0-9a-fA-F-]{8,64}$/.test(raw)) id = raw;
  if (id) {
    const found = findUploadedById(id);
    if (!found) return { ok: false, error: 'UPLOAD_NOT_FOUND' };
    if (!imageExtOk(found)) return { ok: false, error: 'BAD_EXT' };
    try {
      const copy = copyIntoStudioUploads(found);
      return { ok: true, path: copy, source: found };
    } catch (err) {
      return { ok: false, error: `COPY_FAILED(${err && err.message || err})` };
    }
  }

  // 2) 绝对路径：必须落在两个 uploads 目录之一
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const root = imageRoots().find((r) => pathInside(r, abs));
    if (!root) return { ok: false, error: 'OUTSIDE_UPLOAD_DIR' };
    if (!imageExtOk(abs)) return { ok: false, error: 'BAD_EXT' };
    if (!fs.existsSync(abs)) return { ok: false, error: 'NOT_FOUND' };
    return { ok: true, path: abs, source: abs };
  }

  // 3) 相对名：禁止 ..，只在 uploads 根下找
  const rel = raw.replace(/^[\\/]+/, '');
  if (rel.split(/[\\/]/).includes('..')) return { ok: false, error: 'PATH_TRAVERSAL' };
  for (const root of imageRoots()) {
    const abs = path.resolve(root, rel);
    if (!pathInside(root, abs) || !imageExtOk(abs) || !fs.existsSync(abs)) continue;
    return { ok: true, path: abs, source: abs };
  }
  return { ok: false, error: 'NOT_FOUND' };
}

/**
 * 给一组场景解析参考图。非法引用**只拒这一场**：记日志 + 警告 + 清掉 image，
 * 继续用分镜本身渲染（不能让一张坏图把整条任务打死）。
 */
function attachSceneImages(scenes, warnings) {
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (!s || typeof s !== 'object' || !s.image) continue;
    const ref = s.image;
    const r = resolveSceneImage(ref);
    if (!r.ok) {
      log(`scene#${i} image 被拒（${r.error}）：${String(ref).slice(0, 120)}`);
      warnings.push(`第 ${i + 1} 场：图片被拒（${r.error}），这一场不用图`);
      s.image = '';
      s.imagePath = null;
      continue;
    }
    s.image = r.path;
    s.imagePath = r.path;
    log(`scene#${i} image ${String(ref).slice(0, 48)} -> ${r.path}`
      + `${r.source && r.source !== r.path ? '（已复制到 studio/uploads）' : ''}`);
  }
  return scenes;
}

/**
 * 兜底注入：模型没把参考图写进 manim 代码时，在 construct 开头加一层半透明背景图。
 * 为什么必须兜底：提示词里写清了路径，模型仍可能不写 ImageMobject；"用了参考图"
 * 不能靠运气。图片 35% 不透明度铺满画面，上面再叠模型的动画，文字仍然可读。
 */
function ensureManimImage(code, imagePath) {
  const src = String(code || '');
  const p = String(imagePath || '').trim();
  if (!p) return { code: src, injected: false };
  // 已经引用了这张图（路径以任意引号/转义形式出现）就不动。
  // Windows 路径注入进代码时是 JSON 转义形式（\\），所以两种形态都要认，
  // 否则同一条 code 再跑一次会重复插一段背景图（渲染也不会错，但很脏）。
  if (src.includes('ImageMobject')
    && (src.includes(p) || src.includes(JSON.stringify(p)) || src.includes(path.basename(p)))) {
    return { code: src, injected: false };
  }
  const lines = src.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*def\s+construct\s*\(\s*self\s*\)\s*:/.test(l));
  if (idx < 0) return { code: src, injected: false, error: 'NO_CONSTRUCT' };
  let indent = null;
  for (let i = idx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    indent = (lines[i].match(/^\s*/) || [''])[0];
    break;
  }
  if (indent == null) indent = ((lines[idx].match(/^\s*/) || [''])[0]) + '    ';
  // JSON.stringify 产出的双引号字符串同时是合法的 Python 字符串字面量（反斜杠已转义）
  const lit = JSON.stringify(p);
  const inject = [
    `${indent}# 参考图由 studio 注入（模型未写 ImageMobject 时兜底）`,
    `${indent}bg = ImageMobject(${lit}).scale_to_fit_height(config.frame_height)`,
    `${indent}bg.set_opacity(0.35)`,
    `${indent}self.add(bg)`,
  ];
  lines.splice(idx + 1, 0, ...inject);
  return { code: lines.join('\n'), injected: true };
}

/**
 * 把本地图片编码成 data URL（first_frame_url 用）。
 * 网关如果只认公网 URL，这条路走不通 —— 由对照实验决定是否启用（CFG.aivideoImage）。
 */
function imageAsDataUrl(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const buf = fs.readFileSync(file);
  if (buf.length > 4 * 1024 * 1024) throw new Error(`IMAGE_TOO_LARGE(${buf.length})`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function planTwoStage(prompt, opts = {}) {
  const total = Number(opts.seconds) || 12;
  const style = opts.style || null;
  // 表情候选：调用方没给就自己取（收藏优先 + 情绪覆盖）。
  // 放在这里而不是各个入口，是为了让 /v1/jobs、/v1/plan、/v1/create 走同一条路 ——
  // 之前只有 /v1/create 带了候选，面板建任务那条路模型根本看不到表情列表。
  const stickerIds = Array.isArray(opts.stickerIds) && opts.stickerIds.length
    ? opts.stickerIds
    : await stickerHints();
  if (stickerIds.length) {
    log(`写分镜：表情候选 ${stickerIds.length} 个（${stickerIds.map((s) => `${s.id}=${s.name}`).join('，')}）`);
  }
  // 骨架缓存：同一个主题 + 秒数 + 风格 + 语气 → 整份分镜（含每场配的表情）。
  // 命中就跳过"写骨架"这一次调用；fresh:true 时既不查也不写（用户要一份新的）。
  const fresh = opts.fresh === true;
  const skeletonMat = skeletonMaterials({
    text: prompt, seconds: total, style, mode: 'plan', toneLines: opts.toneLines,
  });
  let skel = null;
  if (!fresh) {
    const cachedSkel = planCache.getSkeleton(skeletonMat);
    if (cachedSkel && cachedSkel.scenes.length) {
      log(`分镜骨架命中规划缓存（${cachedSkel.scenes.length} 场，跳过写骨架调用）`);
      skel = { ok: true, json: { title: cachedSkel.title || '', scenes: cachedSkel.scenes }, cacheHit: true };
    }
  }
  if (!skel) {
    skel = await askJson(buildSkeletonPrompt(prompt, total, { style, stickerIds, toneLines: opts.toneLines }), opts);
    if (!skel.ok) return skel;
    // 只写结构合格的结果：模型偶尔会回一份没法用的 JSON，那种不该进缓存
    if (!fresh) rememberSkeleton(skeletonMat, skel.json);
  }
  const scenes = Array.isArray(skel.json.scenes) ? skel.json.scenes.slice(0, CFG.maxScenes) : [];
  if (!scenes.length) return { ok: false, error: 'NO_SCENES' };

  let visuals = 0;
  let textCards = 0;
  let aiVideos = 0;
  // 本集 aivideo 上限：任务可以按请求体覆盖（默认 CFG.maxAiVideo）。
  const aiLimit = Math.max(0, Number(opts.maxAiVideo != null ? opts.maxAiVideo : CFG.maxAiVideo) || 0);
  // 阶段一（同步、按场次顺序）：定每场引擎，把要写 manim 代码的场挑出来。
  // 这一段不发请求，所以 aivideo 配额、text 计数都还是按场次顺序算的 ——
  // 和并发无关，结果和以前的串行版本一致。
  const jobs = [];
  for (let si = 0; si < scenes.length; si++) {
    const s = scenes[si];
    // 三种取值：manim / aivideo / text。plot、draw 这两条旧路子已经停用，
    // 模型写了也会被当成 text（白占一场），所以提示词里连提都不提它们。
    const visual = String(s.visual || '').trim().toLowerCase();
    if (visual === 'aivideo' || (s.video && s.video.prompt)) {
      // 护栏在规划阶段先拦一次：省得模型一口气写 8 场 aivideo，渲染时才逐场降级
      if (aiVideos >= aiLimit) {
        log(`scene#${si} aivideo 失败/不可用，降级为 文字卡：超出本集上限 ${aiLimit} 场`);
        textCards += 1;
        continue;
      }
      const aiPrompt = normalizeAiPrompt(s.video && s.video.prompt);
      if (!aiPrompt) {
        log(`scene#${si} aivideo 失败/不可用，降级为 文字卡：没有 video.prompt`);
        textCards += 1;
        continue;
      }
      s.video = { prompt: aiPrompt, size: (s.video && s.video.size) || '832*480' };
      s.kind = 'aivideo';
      aiVideos += 1;
      continue;
    }
    const kind = visual === 'manim' ? 'manim' : 'text';
    if (kind === 'text') { textCards += 1; continue; }
    jobs.push({ index: si, scene: s });
  }

  // 阶段二（并发）：逐场把"这一场讲什么"翻成一段 manim 脚本。
  // 以前这里 await 串行，8 场就是 8 次排队（每次 20~140 秒），一集光规划 3~5 分钟。
  const concurrency = effectivePlanConcurrency();
  const elapsed = new Map();
  const startedAt = Date.now();
  const results = await mapLimit(jobs, concurrency, async (job) => {
    const t0 = Date.now();
    // 逐场走缓存包装：命中直接拿回代码（零调用），未命中才问模型并写回。
    // 后面的阶段三照旧校验一遍 —— 命中路径拿到的也是同一个形状，不用分叉。
    const r = await planSceneCode(job.scene, 'manim', style, {
      ...opts, sessionId: 'studio-visual', sceneIndex: job.index,
    });
    elapsed.set(job.index, Date.now() - t0);
    return r;
  });
  const wallMs = Date.now() - startedAt;

  // 阶段三（同步、按场次顺序）：校验代码，合格就定稿，不合格只降级这一场。
  // 必须按 jobs 的下标回填 —— 完成顺序是乱的，分镜顺序不能乱。
  let maxMs = 0;
  for (let k = 0; k < jobs.length; k++) {
    const si = jobs[k].index;
    const s = jobs[k].scene;
    const r = results[k] || { ok: false, error: 'WORKER_THROW' };
    const ms = Number(elapsed.get(si)) || 0;
    if (ms > maxMs) maxMs = ms;
    if (!r.ok) {
      log(`scene#${si} manim 失败/不可用，降级为 文字卡：视觉生成失败（${String(r.error || '').slice(0, 160)}）`);
      textCards += 1;
      continue;
    }
    const code = r.json && r.json.manim && typeof r.json.manim.code === 'string' ? r.json.manim.code : '';
    if (!code.trim()) {
      log(`scene#${si} manim 失败/不可用，降级为 文字卡：模型没给 manim.code`);
      textCards += 1;
      continue;
    }
    // 先清洗常见的 Markdown/LaTeX 写法问题，再过安全闸门（否则白等一次 manim）
    const clean = stripMathDelims(code);
    // 安全过滤与 LaTeX 闸门在规划阶段就做一次：命中当场降级，
    // 不必等到渲染时才发现这段代码不能用（那要白等一次 manim）。
    const unsafe = Manim ? Manim.checkCode(clean) : 'manim 模块不可用';
    const noLat = Manim ? Manim.checkNoLatex(clean) : null;
    if (unsafe) {
      log(`scene#${si} manim 失败/不可用，降级为 文字卡：代码被拒（${unsafe}）`);
      textCards += 1;
    } else if (noLat) {
      log(`scene#${si} manim 失败/不可用，降级为 文字卡：代码含 LaTeX 组件（${noLat}）`);
      textCards += 1;
    } else {
      s.manim = { code: clean.slice(0, 8000), scene: r.json.manim.scene || null };
      s.kind = 'manim';
      // 主题模式写出来的分镜骨架通常没有 visual_hint（提示词里没要求给）。
      // 代码已经生成好了却让「画什么」空着，面板上就是"有 ✓、画什么一片空白" ——
      // 所以这里回填一句可读摘要，再把「标题+描述+风格」算成 m2 戳：
      // 之后只改标题，戳就对不上，这一场会被判成过期并重新生成。
      fillAutoHint(s, clean, `scene#${si}`);
      s.manimHint = manimStampOf(s, style);
      visuals += 1;
      log(`scene#${si} manim 生成 ${(ms / 1000).toFixed(1)} 秒（并发 ${concurrency}）`);
    }
  }
  if (jobs.length) {
    log(`逐场生成 ${jobs.length} 场（并发 ${concurrency}）完成：总 ${(wallMs / 1000).toFixed(1)} 秒，最长 ${(maxMs / 1000).toFixed(1)} 秒`);
  }
  const ratio = scenes.length ? Math.round((visuals / scenes.length) * 100) : 0;
  log(`两段式规划：${scenes.length} 场，manim ${visuals} 场（${ratio}%），aivideo ${aiVideos} 场，文字卡 ${textCards} 场`);
  // 把"挑了哪几个表情、配给第几场"写进日志：自动挑选是否切题只能靠这条复盘
  logStickerPicks('两段式规划', scenes, stickerIds);
  return { ok: true, json: { title: skel.json.title || '', scenes }, visuals, aiVideos, manimRatio: ratio };
}

// ------------------------------------------------ 三种创作入口（两个新口） --

const MANIM_HINT_WORDS = [
  '公式', '方程', '函数', '曲线', '坐标', '轴', '导数', '微分', '积分', '斜率', '切线',
  '极限', '向量', '矩阵', '概率', '几何', '面积', '体积', '增长', '下降', '变化', '对比',
  '运动', '轨迹', '动画', '画一', '画出', '坐标轴', 'graph', 'plot', 'math', 'formula',
];

/**
 * 这一场该用哪个引擎？tool 显式给了就听用户的；空着才由这里判断。
 * 判断标准故意写得"宁可多画"：讲到公式/图形/变化过程就用 manim ——
 * 用户要的是动画，一张静止的文字卡看起来像 PPT。
 */
function decideTool(scene) {
  const raw = String((scene && scene.tool) || '').trim().toLowerCase();
  // kind 是分镜保存后的引擎标记（面板/项目里的场景只有 kind，没有 tool）。
  // 以前这里只看 tool，于是"面板回填 kind:'aivideo'"的场被当成文字卡 —— 这就是
  // 空白视频那个 bug 的来源。kind 和 tool 都认，且 tool 优先（它更显式）。
  const rawKind = String((scene && scene.kind) || '').trim().toLowerCase();
  if (raw === 'manim' || raw === 'text') {
    return { tool: raw, reason: `用户指定：${raw}` };
  }
  const videoPrompt = normalizeAiPrompt(scene && scene.video && scene.video.prompt);
  if (raw === 'aivideo' || videoPrompt) {
    return {
      tool: 'aivideo',
      reason: videoPrompt ? '分镜里给了 video.prompt，直接按它生成画面' : '用户指定：aivideo',
    };
  }
  // tool 没写时按 kind 兜底：kind:'manim' + 已有代码 → 直接沿用，别再问一次模型
  const givenCode = scene && scene.manim && typeof scene.manim.code === 'string'
    ? scene.manim.code.trim() : '';
  if (rawKind === 'manim' && givenCode) {
    return { tool: 'manim', reason: '分镜里已有 manim 代码，直接沿用' };
  }
  if (rawKind === 'aivideo') {
    return { tool: 'aivideo', reason: '分镜标记为 aivideo' };
  }
  if (rawKind === 'text') {
    return { tool: 'text', reason: '分镜标记为 text' };
  }
  const hint = String((scene && scene.visual_hint) || '').trim();
  if (hint) return { tool: 'manim', reason: '用户写了「画什么」，按画面描述生成 manim' };
  const text = `${(scene && scene.text) || ''} ${(scene && scene.narration) || ''}`.toLowerCase();
  const hit = MANIM_HINT_WORDS.find((w) => text.includes(w));
  if (hit) return { tool: 'manim', reason: `内容里有「${hit}」，适合用 manim 画` };
  if (!String((scene && scene.narration) || '').trim() && !String((scene && scene.text) || '').trim()) {
    return { tool: 'text', reason: '这一场是空的，只能出文字卡' };
  }
  return { tool: 'text', reason: '没有公式/图形线索，按文字卡处理（想画就填「画什么」）' };
}

function clampSceneSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.min(10, Math.max(3, Math.round(n * 10) / 10));
}

/**
 * 这组分镜是不是"已经补全过"（每一场都带 manim 代码 / video.prompt / 明确的 text）？
 *
 * 用于重跑配方：库里的 scenes 是**最终分镜**，直接拿去渲就行。
 * 再走一遍 fillScenes 虽然不会发模型请求（已有代码会沿用），但会把 seconds
 * 重新夹到 3~10 —— 旁白撑长的场次被改短，缓存键就变了，重跑等于重渲。
 * 所以能直通的就直通，一个字段都不动。
 */
/**
 * manim 代码戳的版本前缀。
 *
 * m2 = 「标题也算材料」的算法：sha1(hint | text | style | kind)。
 * 升级前的戳只有一句「画什么」（m1），没法判断标题改没改过 —— 读到 m1 一律当过期，
 * 重生成一次就带上了 m2，之后才判断得出来。这是有意的：宁可多花一次生成，
 * 也不要继续播旧标题（用户实测的"改了不生效"）。
 */
const MANIM_STAMP_PREFIX = 'm2:';

/**
 * 这一场 manim 代码的「内容戳」。
 *
 * 调的是规划缓存的**同一个** sceneKey：缓存决定"要不要重新问模型"，
 * 戳决定"手上这份代码算不算当前标题/描述的"。两边算法必须逐字一致，
 * 否则会出现"缓存说没变、戳说变了"，或者更糟 —— 两边都以为没变，成片还是旧标题。
 */
function manimStampOf(scene, style) {
  return MANIM_STAMP_PREFIX + PlanCacheLib.sceneKey(sceneCodeMaterials(scene, 'manim', style));
}

/**
 * 这一场的 manim 代码是不是为**当前**的「画什么 + 标题 + 风格」生成的？
 *
 * 代码生成时会把这一步的材料算成戳记在**场景级 manimHint** 上（见 fillScenes /
 * planTwoStage）。戳放在场景级而不是 manim 对象里，是为了不污染画面缓存键：
 * sceneKey 会把 manim 整个序列化，戳塞进去会让老项目第一次重跑就全部重渲。
 *
 * 返回 false 的含义是"代码过期，必须重新生成"：
 *   - 用户改了「画什么」（提示词变了，代码还是旧的）；
 *   - 用户改了标题（代码里的 Text("旧标题") 还是旧的）← 这条以前漏了，就是用户实测的 bug；
 *   - 戳是升级前的旧格式/空串（无法判断，只能重生成一次）。
 */
function manimHintMatches(scene, style) {
  const manim = scene && scene.manim;
  if (!manim || typeof manim.code !== 'string' || !manim.code.trim()) return true;
  // scene.manimHint 是正式字段；manim.hint 只用于兼容短命的中间版本
  const stamp = scene && scene.manimHint != null
    ? scene.manimHint
    : (manim.hint != null ? manim.hint : null);
  if (stamp == null) return false;
  if (!String(stamp).startsWith(MANIM_STAMP_PREFIX)) return false;
  return String(stamp) === manimStampOf(scene, style);
}

// ------------------------------------------- 「画什么」回填（写稿模式的补丁）--
/**
 * 写稿模式拆出来的场次只有 text/narration，没有 visual_hint。fillScenes 拿这两句
 * 当材料生成了 manim 代码，却从来没把"这一场画什么"写回场景 —— 面板上「画什么」
 * 一栏空着、状态却是 ✓：用户不知道它画的是什么，想改也只能从零描述一句。
 *
 * 这里补一条：**代码生成成功但 visual_hint 为空**时，回填一句可读的摘要，并打上
 * visualHintAuto 标记（面板据此提示"这句是自动生成的"）。两种来源，优先从代码读：
 *   1) 代码摘要：把代码里出现的主要元素（Axes / plot / Dot / Line / MathTex / Text…）
 *      拼成一句话。它比标题更接近"实际画了什么"，用户照着改也更容易；
 *   2) 标题/旁白摘要：代码里认不出元素时，退回 text（没有 text 就用 narration）。
 * 回填值末尾固定加「（自动生成，可改写）」：一眼能看出这不是自己写的。
 */
const HINT_AUTO_SUFFIX = '（自动生成，可改写）';
// 摘要正文上限：回填值总长按 60 字算，先减掉后缀；中文按字符切，别切半个字。
const HINT_SUMMARY_MAX = 60 - Array.from(HINT_AUTO_SUFFIX).length;

// manim 代码里"看得出画了什么"的元素 → 人话。按**在代码里第一次出现的位置**排序，
// 摘要读起来就有先后（先坐标轴、再曲线、再点/连线）。只收常见的十几种：
// 全量覆盖既做不到也没必要，认不出来的场次走标题/旁白兜底。
const MANIM_ELEMENT_WORDS = [
  { re: /\bNumberPlane\b/, word: '坐标网格' },
  { re: /\bAxes\b/, word: '坐标轴' },
  { re: /\bNumberLine\b/, word: '数轴' },
  { re: /\.plot\s*\(/, word: '曲线' },
  { re: /\bMathTex\b/, word: '公式' },
  { re: /\bTex\b/, word: '公式' },
  { re: /\bCircle\b/, word: '圆' },
  { re: /\bSquare\b/, word: '方块' },
  { re: /\bRectangle\b/, word: '矩形' },
  { re: /\bPolygon\b/, word: '多边形' },
  { re: /\bLine\b/, word: '连线' },
  { re: /\bArrow\b/, word: '箭头' },
  { re: /\bDot\b/, word: '点' },
  { re: /\bBrace\b/, word: '标注框' },
  { re: /\bSurroundingRectangle\b/, word: '高亮框' },
  { re: /\bText\b/, word: '文字' },
];

/** 从一段 manim 代码里读出一句"画了什么"，最多 5 个元素；认不出就返回空串。 */
function manimCodeSummary(code) {
  const src = String(code == null ? '' : code);
  if (!src.trim()) return '';
  const hits = [];
  for (const el of MANIM_ELEMENT_WORDS) {
    const m = el.re.exec(src);
    if (m && m.index >= 0) hits.push({ at: m.index, word: el.word });
  }
  hits.sort((a, b) => a.at - b.at);
  const words = [];
  for (const hit of hits) {
    if (words.includes(hit.word)) continue;
    words.push(hit.word);
    if (words.length >= 5) break;
  }
  return words.join(' + ');
}

/** 标题/旁白的规范化摘要：空白压成一个空格，取 text（没有就用 narration），守住字数。 */
function titleNarrationSummary(scene) {
  const text = String((scene && scene.text) || '').replace(/\s+/g, ' ').trim();
  const narration = String((scene && scene.narration) || '').replace(/\s+/g, ' ').trim();
  return (text || narration).slice(0, HINT_SUMMARY_MAX);
}

/**
 * 给一场回填「画什么」（只在 hint 为空时动手；用户/模型写过的绝不覆盖）。
 * 返回 true = 真的回填了。
 */
function fillAutoHint(scene, code, label) {
  if (!scene) return false;
  if (String(scene.visual_hint || '').trim()) return false;
  const fromCode = manimCodeSummary(code);
  const fromTitle = fromCode ? '' : titleNarrationSummary(scene);
  const body = fromCode || fromTitle || '这一场的动画';
  const how = fromCode ? '「代码摘要」' : (fromTitle ? '「标题/旁白摘要」' : '「通用占位」');
  scene.visual_hint = `${body}${HINT_AUTO_SUFFIX}`;
  // 标记只在这一处置位：面板据此把那行小字换成"这句是自动生成的"。
  scene.visualHintAuto = true;
  log(`${label} 无 hint，回填${how}作为画什么：「${scene.visual_hint}」`);
  return true;
}

/**
 * 读旧数据时补「画什么」：hint 为空但有 manim 代码 → 用同一套规则回填。
 *
 * 为什么读的时候也要补（而不只是生成时补）：升级前存下的配方/项目里 hint 本来就是
 * 空的，面板打开还是空白一片、重做也无从下手。这里只改**返回给调用方的视图**，
 * 不动磁盘上的存档 —— 用户真的改了 hint 才会写新值。
 *
 * 为什么不补 manimHint 戳：戳是 m2 哈希，必须由"生成这段代码时的标题/风格"算出来；
 * 在读接口里凭空补一个，要么恒等于当前材料（于是把旧代码永久钉成"有效"），
 * 要么恒不相等（每次都重生成）。缺戳就明说"代码可能过期"，让重做那一轮去重生成。
 */
function withAutoHints(scenes) {
  // 调用方拿它串在"读不到这条"之后（rerun / 详情），空值必须原样透传，别变成 [] 掩盖 404
  if (!scenes) return scenes;
  const list = arrayOf(scenes);
  if (!list.length) return list;
  let changed = false;
  const out = list.map((s, i) => {
    if (!s || typeof s !== 'object') return s;
    const code = s.manim && typeof s.manim.code === 'string' ? s.manim.code : '';
    if (!code.trim()) return s;
    if (String(s.visual_hint || '').trim()) return s;
    const next = Object.assign({}, s);
    if (!fillAutoHint(next, code, `scene#${i}`)) return s;
    changed = true;
    return next;
  });
  return changed ? out : list;
}

function scenesLookFinal(list, style) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return false;
  return arr.every((s) => {
    if (!s || typeof s !== 'object') return false;
    const code = s.manim && typeof s.manim.code === 'string' && s.manim.code.trim();
    const video = s.video && typeof s.video.prompt === 'string' && s.video.prompt.trim();
    // 代码在、但戳对不上当前「画什么 + 标题 + 风格」= 代码过期：不能走"直通"，
    // 要让 fillScenes 把这一场重新生成（其余场仍会原样沿用，不会全部重来）。
    if (code && !manimHintMatches(s, style)) return false;
    if (code || video) return true;
    const kind = String(s.kind || '').toLowerCase();
    const tool = String(s.tool || '').toLowerCase();
    return kind === 'text' || tool === 'text';
  });
}

/**
 * AI 画面 prompt 的规范化：压成一行、去引号、守住 120 字符。
 *
 * 为什么必须在这里截：生成模型对 prompt 长度敏感（长了会丢风格/镜头词），
 * 而模型又很爱写 200 字符的长句。截断比整场降级好 —— 至少画面还是对的。
 */
function normalizeAiPrompt(value) {
  let text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!text) return '';
  if (/[\u4e00-\u9fff]/.test(text)) {
    // 不拒收（画得出来总比文字卡好），但明确记一笔：英文 prompt 效果稳定得多
    log(`ai 画面 prompt 含中文，效果可能不稳：${text.slice(0, 40)}…`);
  }
  return text.slice(0, 120);
}

/** 这一场手里有没有 AI 画面素材（和 sceneEngines 用同一个判据）。 */
function isAiVideoScene(scene) {
  return Boolean(scene && scene.video && typeof scene.video.prompt === 'string' && scene.video.prompt.trim());
}

/**
 * 成本护栏：一集最多 maxAiVideo 条 aivideo。
 *
 * 返回 { allowed:Set<场次下标>, degraded:[场次下标], total, max }。
 * 为什么按"场次顺序"分配名额，而不是按"这次渲到第几条"：
 *   同一集反复渲染时要稳定。缓存里已有的那几条继续复用，超出的永远是同样几场降级，
 *   不会这次降第 5 场、下次降第 3 场，成片风格跟着跳。
 */
function planAiVideoQuota(scenes, max) {
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  const allowed = new Set();
  const degraded = [];
  let used = 0;
  const list = Array.isArray(scenes) ? scenes : [];
  for (let i = 0; i < list.length; i++) {
    if (!isAiVideoScene(list[i])) continue;
    if (used < limit) {
      allowed.add(i);
      used += 1;
    } else {
      degraded.push(i);
    }
  }
  return { allowed, degraded, total: used + degraded.length, max: limit };
}

/**
 * 写稿模式：稿子 → 分镜。
 * 只拆场、只抽原话，**不生成 manim 代码**（那一步由 /v1/storyboard/from-scenes 做），
 * 因为用户下一步大概率要改标题和秒数，先花几十秒写代码是浪费。
 */
async function splitScript(script, opts = {}) {
  const total = Math.min(CFG.maxTotalSeconds, Math.max(10, Number(opts.seconds) || 60));
  const style = opts.style || null;
  const fresh = opts.fresh === true;
  const skeletonMat = skeletonMaterials({
    text: script, seconds: total, style, mode: 'script', toneLines: opts.toneLines,
  });
  let r = null;
  if (!fresh) {
    const cached = planCache.getSkeleton(skeletonMat);
    if (cached && cached.scenes.length) {
      log(`写稿拆场命中规划缓存（${cached.scenes.length} 场，跳过拆场调用）`);
      r = { ok: true, json: { title: cached.title || '', scenes: cached.scenes }, cacheHit: true };
    }
  }
  if (!r) {
    const prompt = buildScriptSplitPrompt(script, total, { style, toneLines: opts.toneLines });
    r = await askJson(prompt, { ...opts, sessionId: 'studio-script' });
    if (!r.ok) return r;
    // 结构合格才写：坏 JSON/空数组不落盘
    if (!fresh) rememberSkeleton(skeletonMat, r.json);
  }

  const rawScenes = Array.isArray(r.json.scenes) ? r.json.scenes.slice(0, CFG.maxScenes) : [];
  if (!rawScenes.length) return { ok: false, error: 'NO_SCENES' };

  const scenes = rawScenes.map((s, i) => {
    const tool = String(s.tool || '').trim().toLowerCase() === 'text' ? 'text' : 'manim';
    return {
      index: i,
      text: String(s.text || '').slice(0, 20),
      narration: String(s.narration || '').slice(0, 80),
      seconds: clampSceneSeconds(s.seconds),
      visual_hint: String(s.visual_hint || '').slice(0, 300),
      tool,
    };
  });
  // 场数不足时补一句提示，不强行拆 —— 稿子本来就短的时候硬拆会变成一句一场。
  const hint = sceneCountHint(total);
  const warnings = [];
  if (scenes.length < hint.min) warnings.push(`只拆出 ${scenes.length} 场（这个时长建议 ${hint.min}~${hint.max} 场），稿子可能太短；可以手加几场。`);
  const manimCount = scenes.filter((s) => s.tool === 'manim').length;
  if (scenes.length && manimCount / scenes.length < 0.8) warnings.push('manim 占比不足 80%，会让成片更像 PPT。');
  log(`写稿拆场：${scenes.length} 场，manim ${manimCount} 场，${total} 秒`);
  return {
    ok: true,
    title: String(r.json.title || script.slice(0, 12) || '未命名').slice(0, 60),
    scenes,
    warnings,
  };
}

/**
 * 分镜模式：把用户填的每一场补成能渲染的场景。
 *
 * 关键一步是 visual_hint → manim code：用户写"画坐标轴、曲线上两个点，连线，
 * 然后让点靠近变成切线"，这里把它当成**最高优先级的画面要求**喂给写脚本的模型，
 * 再把返回的代码过一遍安全/LaTeX 闸门。代码不合格就降级文字卡并把原因带回前端，
 * 不能假装成功。
 */
async function fillScenes(inputScenes, opts = {}) {
  const style = opts.style || null;
  // 按下标预分配：并发完成后按下标回填，分镜顺序永远等于用户填的顺序。
  const scenes = new Array(inputScenes.length);
  // 告警先带场次号收集，最后按场次顺序摊平 —— 并发完成后警告的产出顺序是乱的，
  // 但用户在面板上看到的应该是一条按场次排的清单。
  const warnItems = [];
  const addWarn = (i, text) => warnItems.push({ i, text });
  let manimCount = 0;
  let textCount = 0;
  let aiVideoCount = 0;
  let fallbackCount = 0;
  const aiLimit = Math.max(0, Number(opts.maxAiVideo != null ? opts.maxAiVideo : CFG.maxAiVideo) || 0);
  // aivideo 名额在阶段一按场次顺序先占住（和渲染期 planAiVideoQuota 同一口径）。
  // 以前是「这一场生成成功才 +1」，并发之后不能再这么算 —— 否则第 3 场的名额
  // 要等第 1 场生成完才知道，顺序会随完成时间漂移，超出的场次每次都不一样。
  let aiQuotaUsed = 0;
  const jobs = [];

  // 阶段一（同步、按场次顺序）：不需要模型的场次当场定下来；
  // 要发模型的（manim 代码 / aivideo 英文 prompt）排进 jobs，第二阶段并发跑。
  for (let i = 0; i < inputScenes.length; i++) {
    const src = inputScenes[i] || {};
    // 表情：面板里手动选的表情必须带过去。这里以前是手写字段，stickers 被丢掉 ——
    // 用户加完表情、点「补全动画」，表情就全没了，渲出来一个都没有。
    // 现在走 project.js 的同一份白名单，并且**真的丢了要出声**：
    // 这条日志是"分镜有表情、项目里没有"能定位到补全这一环的唯一证据。
    const stickerNorm = P.normalizeStickers(src.stickers);
    if (stickerNorm.dropped.length) {
      log(`scene#${i} 表情丢弃 ${stickerNorm.dropped.length} 个：`
        + stickerNorm.dropped.slice(0, 4).map((d) => `${d.id}（${d.reason}）`).join('、'));
    }
    const base = {
      index: i,
      text: String(src.text || '').slice(0, 60),
      narration: String(src.narration || '').slice(0, 200),
      seconds: clampSceneSeconds(src.seconds),
      visual_hint: String(src.visual_hint || '').slice(0, 600),
      // 参考图：原引用先带着，prepareJob 会统一解析成绝对路径（attachSceneImages）
      image: src.image ? String(src.image).slice(0, 240) : '',
      imagePath: src.imagePath ? String(src.imagePath).slice(0, 320) : '',
      stickers: stickerNorm.list,
      tool: String(src.tool || '').trim().toLowerCase(),
      kind: 'text',
      // 「画什么」是自动回填的（面板要据此提示）。只有沿用已有代码时才继承；
      // 代码重新生成时由 fillAutoHint 决定，用户改过描述的场次不会带这个标记。
      visualHintAuto: false,
      manim: null,
      video: null,
      status: 'text',
      note: '',
    };
    const decided = decideTool(src);
    base.tool = decided.tool;
    base.tool_reason = decided.reason;

    // 已经带 manim 代码的场景：直接用，不再问模型。
    // 两条路都走这里：重跑配方（library rerun）和"面板把分镜回填给我"。
    // 必须一个模型调用都不发 —— 否则重跑会重写代码，缓存键全变，
    // "画面能复用就复用" 直接失效；更糟的是模型可能把好代码写成坏代码。
    if (decided.tool === 'manim') {
      const given = src.manim && typeof src.manim.code === 'string' ? src.manim.code.trim() : '';
      if (given && manimHintMatches(src, style)) {
        base.kind = 'manim';
        base.manim = { code: given.slice(0, 8000), scene: (src.manim && src.manim.scene) || null };
        // 代码是沿用的：上一轮如果标过"这句 hint 是自动生成的"，标记继续有效。
        if (src.visualHintAuto) base.visualHintAuto = true;
        // 旧配方/旧项目里"有代码、没画什么"的场次：沿用代码的同时把 hint 补上，
        // 面板重做时才有内容可改（不补的话这张卡片永远是空的）。
        fillAutoHint(base, given, `scene#${i}`);
        base.manimHint = manimStampOf(base, style);
        base.status = 'manim';
        manimCount += 1;
        scenes[i] = base;
        // 明确记一条"没调用模型"：验收"只改标题 → 只有那一场重新生成"时，
        // 其余场次这里各有一行沿用日志，缺那一场的就是被重生成的 —— 一目了然。
        log(`scene#${i} 沿用已有 manim 代码（戳匹配 ${String(base.manimHint).slice(0, 6)}…，不调用模型）`);
        continue;
      }
      if (given) {
        // 旧代码是按上一句「画什么」或**上一个标题**生成的：继续用就等于"改了也不生效"。
        // 丢掉它走下面的重新生成；其它场不受影响（各自判断各自的戳）。
        // 日志里同时打旧戳和新戳的开头：验收时能直接看出"这一场是被判过期才重生成的"。
        const oldStamp = String(src.manimHint == null || src.manimHint === '' ? '(空)' : src.manimHint);
        log(`scene#${i} 代码是按旧标题/旧「画什么」生成的，丢掉旧 manim 代码重新生成`
          + `（旧戳 ${oldStamp.slice(0, 10)}… → 新戳 ${manimStampOf(base, style).slice(0, 10)}…）`);
      }
    }

    if (decided.tool === 'text') {
      textCount += 1;
      base.status = 'text';
      scenes[i] = base;
      continue;
    }

    // ---- AI 画面：不要 manim 脚本，只要一条英文 prompt ----
    if (decided.tool === 'aivideo') {
      if (aiQuotaUsed >= aiLimit) {
        base.status = 'fallback';
        base.note = `本集 aivideo 已到上限（${aiLimit} 场），这一场出文字卡`;
        // 规划阶段的降级同样要写日志：场次 + 原引擎 + 新引擎 + 原因
        log(`scene#${i} aivideo 超出本集上限（${aiLimit} 场），降级为 文字卡：${base.note}`);
        addWarn(i, `第 ${i + 1} 场：${base.note}`);
        fallbackCount += 1;
        textCount += 1;
        scenes[i] = base;
        continue;
      }
      aiQuotaUsed += 1;
      // 用户已经写了 video.prompt 就直接用；只写了中文「画什么」才让模型翻英文
      const givenPrompt = normalizeAiPrompt(src.video && src.video.prompt);
      const givenSize = (src.video && src.video.size) || '832*480';
      if (givenPrompt) {
        base.kind = 'aivideo';
        base.video = { prompt: givenPrompt, size: /^\d{2,5}\*\d{2,5}$/.test(String(givenSize)) ? String(givenSize) : '832*480' };
        base.status = 'aivideo';
        aiVideoCount += 1;
        scenes[i] = base;
        continue;
      }
      // 没给 prompt 不一定是错：用户可能只写了中文「画什么」，这里负责翻成英文。
      // 但要留痕 —— 之前这一步失败时只在返回体里塞个 note，日志里什么都没有。
      log(`scene#${i} 是 aivideo 但没有 video.prompt，先用「画什么」生成画面描述`);
      jobs.push({ index: i, kind: 'aivideo', base, src, givenSize });
      continue;
    }

    // 剩下的是 manim：要把「这一场画什么」翻成一段脚本（最大的一批请求）
    jobs.push({ index: i, kind: 'manim', base, src });
  }

  // 阶段二（并发）：最多 3 路同时问模型。串行时 8 场 = 8 次排队，
  // 每次 20~140 秒，一集光规划就要 3~5 分钟 —— 这是最大的瓶颈。
  const concurrency = effectivePlanConcurrency();
  const elapsed = new Map();
  const startedAt = Date.now();
  const results = await mapLimit(jobs, concurrency, async (job) => {
    const t0 = Date.now();
    const kind = job.kind === 'aivideo' ? 'aivideo' : 'manim';
    // 逐场走缓存包装：manim 场命中就是零调用；aivideo 场不在缓存范围（只缓存 manim 代码）。
    const r = await planSceneCode(job.base, kind, style, {
      ...opts,
      sessionId: kind === 'aivideo' ? 'studio-aivideo' : 'studio-scene',
      sceneIndex: job.index,
    });
    elapsed.set(job.index, Date.now() - t0);
    return r;
  });
  const wallMs = Date.now() - startedAt;

  // 阶段三（同步、按场次顺序）：校验结果，合格就定稿，失败只降级这一场。
  // 必须按 jobs 的下标回填 —— 完成顺序是乱的，分镜顺序不能乱。
  let maxMs = 0;
  for (let k = 0; k < jobs.length; k++) {
    const job = jobs[k];
    const i = job.index;
    const base = job.base;
    const r = results[k] || { ok: false, error: 'WORKER_THROW' };
    const ms = Number(elapsed.get(i)) || 0;
    if (ms > maxMs) maxMs = ms;

    if (job.kind === 'aivideo') {
      let aiPrompt = null;
      let aiSize = job.givenSize;
      const got = r.ok && r.json && r.json.video && typeof r.json.video === 'object' ? r.json.video : null;
      aiPrompt = normalizeAiPrompt(got && got.prompt);
      if (got && got.size) aiSize = got.size;
      if (!aiPrompt) {
        // 翻译失败不该让整场作废：wan 也能吃中文，只是效果不如英文。
        // 直接用用户写的「画什么」兜底 —— 有画面总比变成文字卡强。
        const rawHint = String((base && (base.visual_hint || base.text)) || '').trim();
        if (rawHint) {
          aiPrompt = rawHint.slice(0, 400);
          log(`scene#${i} 英文画面描述生成失败（${r.error || '无 prompt'}），改用原始描述直接生成：${rawHint.slice(0, 40)}…`);
          addWarn(i, `第 ${i + 1} 场：英文描述没生成出来，直接用中文提示词（效果可能不稳）`);
        } else {
          base.status = 'fallback';
          base.note = r.ok ? '模型没给出 video.prompt，这一场出文字卡' : `画面描述生成失败（${r.error}），这一场出文字卡`;
          // 明确的降级日志：场次 + 原因，和 normalizeScene 的告警同一个口径
          log(`scene#${i} 是 aivideo 但没有 video.prompt，降级文字卡（${base.note}）`);
          addWarn(i, `第 ${i + 1} 场：${base.note}`);
          fallbackCount += 1;
          textCount += 1;
          scenes[i] = base;
          continue;
        }
      }
      base.kind = 'aivideo';
      base.video = { prompt: aiPrompt, size: /^\d{2,5}\*\d{2,5}$/.test(String(aiSize)) ? String(aiSize) : '832*480' };
      base.status = 'aivideo';
      aiVideoCount += 1;
      scenes[i] = base;
      log(`scene#${i} ai 画面描述生成 ${(ms / 1000).toFixed(1)} 秒（并发 ${concurrency}）`);
      continue;
    }

    if (!r.ok) {
      base.status = 'fallback';
      base.note = `动画生成失败（${r.error}），这一场会出文字卡`;
      log(`scene#${i} manim 失败/不可用，降级为 文字卡：${String(r.error || 'askJson 失败').slice(0, 200)}`);
      addWarn(i, `第 ${i + 1} 场：${base.note}`);
      fallbackCount += 1;
      textCount += 1;
      scenes[i] = base;
      continue;
    }
    const manimObj = r.json && r.json.manim && typeof r.json.manim === 'object' ? r.json.manim : null;
    const code = manimObj && typeof manimObj.code === 'string' ? manimObj.code.trim() : '';
    if (!code) {
      base.status = 'fallback';
      base.note = '模型没给出 manim.code，这一场会出文字卡';
      log(`scene#${i} manim 失败/不可用，降级为 文字卡：模型没给 manim.code`);
      addWarn(i, `第 ${i + 1} 场：${base.note}`);
      fallbackCount += 1;
      textCount += 1;
      scenes[i] = base;
      continue;
    }
    // 和两段式规划同一套闸门：规划阶段就拦住，别等渲染白等一次 manim。
    // 先清洗 MathTex 外面多包的 $（模型常见手滑），再做安全检查。
    const clean = stripMathDelims(code);
    const unsafe = Manim ? Manim.checkCode(clean) : 'manim 模块不可用';
    const noLat = Manim ? Manim.checkNoLatex(clean) : null;
    if (unsafe || noLat) {
      base.status = 'fallback';
      base.note = `代码被拒（${unsafe || noLat}），这一场会出文字卡`;
      log(`scene#${i} manim 失败/不可用，降级为 文字卡：代码被拒（${unsafe || noLat}）`);
      addWarn(i, `第 ${i + 1} 场：${base.note}`);
      fallbackCount += 1;
      textCount += 1;
      scenes[i] = base;
      continue;
    }
    base.kind = 'manim';
    base.manim = { code: clean.slice(0, 8000), scene: (manimObj && manimObj.scene) || null };
    // 写稿模式拆出来的场次没有「画什么」：代码生成成功后回填一句可读摘要，
    // 面板上这张卡片才有内容（用户也能在这句的基础上改，改了就重新生成这一段）。
    fillAutoHint(base, clean, `scene#${i}`);
    // 戳 = sha1(画什么 | 标题 | 风格 | 引擎)，和场级缓存键同一个函数。
    // 只改标题时这里算出来的戳会和存档里那份不同 —— 下次重做就知道该重新生成。
    base.manimHint = manimStampOf(base, style);
    base.status = 'manim';
    manimCount += 1;
    scenes[i] = base;
    log(`scene#${i} manim 生成 ${(ms / 1000).toFixed(1)} 秒（并发 ${concurrency}）`);
  }

  // 告警按场次顺序摊平（并发时产出顺序是乱的，面板上应该从第 1 场往下读）
  const warnings = warnItems.sort((a, b) => a.i - b.i).map((w) => w.text);
  const ratio = scenes.length ? Math.round((manimCount / scenes.length) * 100) : 0;
  log(`分镜补全：${scenes.length} 场，manim ${manimCount} 场（${ratio}%），aivideo ${aiVideoCount} 场，文字卡 ${textCount} 场，降级 ${fallbackCount} 场`);
  if (jobs.length) {
    log(`逐场生成 ${jobs.length} 场（并发 ${concurrency}）完成：总 ${(wallMs / 1000).toFixed(1)} 秒，最长 ${(maxMs / 1000).toFixed(1)} 秒`);
  }
  return {
    ok: true,
    scenes,
    stats: { total: scenes.length, manim: manimCount, aivideo: aiVideoCount, text: textCount, fallback: fallbackCount, manimRatio: ratio },
    warnings,
  };
}

/**
 * 把"代码过期"的场次重新生成（就地改 project.scenes，成功后落盘）。
 *
 * 什么时候会过期：用户改了标题 / 改了「画什么」，但项目里存的还是上一次那份 manim 代码。
 * 面板改标题时**不会**清代码（只有改「画什么」才清），所以这条路必须由服务端兜住，
 * 否则"重做"只是拿旧代码重渲一遍 —— 用户看到的就是"改了没生效"。
 *
 * 只碰 manim 场，且只碰戳对不上的那几场：
 *   - 旁白改动不影响戳（旁白不进代码）→ 这一场只重渲/重配音，不花模型调用；
 *   - 单场重新生成失败就保留旧代码并记一条日志（有画面总比整集失败强）。
 */
async function refreshStaleManimScenes(project, style, opts = {}) {
  const list = Array.isArray(project && project.scenes) ? project.scenes : [];
  const stale = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const code = s && s.manim && typeof s.manim.code === 'string' ? s.manim.code.trim() : '';
    if (!code) continue;
    if (String(s.kind || '') === 'aivideo') continue;
    if (manimHintMatches(s, style)) continue;
    stale.push(i);
  }
  if (!stale.length) return { stale: [], regenerated: [], failed: [] };

  log(`代码过期检查：${stale.length}/${list.length} 场的 manim 代码是按旧标题/旧「画什么」生成的`
    + `（第 ${stale.map((i) => i + 1).join('、')} 场），重新生成这几场`);
  const results = await mapLimit(stale, effectivePlanConcurrency(), async (i) => {
    const r = await planSceneCode(list[i], 'manim', style, {
      ...opts, sceneIndex: i, sessionId: 'studio-scene',
    });
    return r;
  });

  const regenerated = [];
  const failed = [];
  for (let k = 0; k < stale.length; k++) {
    const i = stale[k];
    const r = results[k] || { ok: false, error: 'WORKER_THROW' };
    const manimObj = r.ok && r.json && r.json.manim && typeof r.json.manim === 'object' ? r.json.manim : null;
    const raw = manimObj && typeof manimObj.code === 'string' ? manimObj.code.trim() : '';
    const clean = raw ? stripMathDelims(raw) : '';
    const bad = clean ? (Manim ? Manim.checkCode(clean) : 'manim 模块不可用') : 'EMPTY_CODE';
    if (bad) {
      failed.push({ index: i, error: String(r.error || bad) });
      log(`scene#${i} 代码重新生成失败（${String(r.error || bad).slice(0, 120)}），沿用旧代码`);
      continue;
    }
    const s = list[i];
    s.manim = { code: clean.slice(0, 8000), scene: manimObj.scene || null };
    s.kind = 'manim';
    // 回填顺序和 fillScenes 一致：先补「画什么」（只在空的时候），再算戳 ——
    // 否则戳是按旧 hint 算的，下次又会判成过期、无限重生成。
    fillAutoHint(s, clean, `scene#${i}`);
    s.manimHint = manimStampOf(s, style);
    regenerated.push(i);
    log(`scene#${i} 代码已按当前标题重新生成（${r.cacheHit ? '命中规划缓存' : '调用模型'}）`);
  }
  if (regenerated.length) {
    try { P.saveProject(CFG.projectDir, project); } catch (err) {
      log(`项目落盘失败（重新生成的代码本次仍会用，只是下次可能又判过期）：${(err && err.message) || err}`);
    }
  }
  return { stale, regenerated, failed };
}

/**
 * 渲染前给个量级：面板底部那行"预计：8 场 / 60 秒 / 约 3 分钟 / 约 27 credits"。
 * 系数来自实测：8 场 60 秒全 manim ≈ 192 秒，其中旁白 8 句串行约 30 秒；
 * credits 按 speak 的 0.185/字（BreezeBlue 结算口径）估。
 */
function estimateRender(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  let manim = 0;
  let text = 0;
  let aivideo = 0;
  let chars = 0;
  let sum = 0;
  for (const s of list) {
    // 还没补代码的分镜（写稿刚拆完）也要按 tool 预估：否则会报"0 场 manim"，
    // 用户看到的渲染时间会小得离谱。
    const isAi = Boolean(s && (s.kind === 'aivideo' || s.tool === 'aivideo' || (s.video && s.video.prompt)));
    const isManim = Boolean(s && (s.kind === 'manim' || (s.manim && s.manim.code) || s.tool === 'manim'));
    if (isAi) aivideo += 1;
    else if (isManim) manim += 1;
    else text += 1;
    chars += String((s && s.narration) || '').length;
    sum += Number((s && s.seconds) || 0);
  }
  const videoSeconds = Math.max(0, sum - CFG.fade * Math.max(0, list.length - 1));
  // aivideo 一条要等 ~100 秒（实测），比 manim 慢得多，预估里必须体现，否则用户以为秒出
  const renderSeconds = Math.round(manim * 20 + text * 3 + aivideo * 110 + chars * 0.22);
  const credits = Math.round(chars * 0.185 * 10) / 10;
  return {
    scenes: list.length,
    manim,
    text,
    aivideo,
    seconds: Number(videoSeconds.toFixed(1)),
    renderSeconds,
    renderMinutes: Math.round((renderSeconds / 60) * 10) / 10,
    narrationChars: chars,
    credits,
  };
}

/** 把分镜写进项目（新建或更新同一个草稿项目），返回给前端的项目摘要。 */
function saveDraftProject(input) {  const { projectId, title, scenes, style, voice } = input;
  let project = projectId ? P.loadProject(CFG.projectDir, String(projectId)) : null;
  if (!project) {
    project = P.createProject(CFG.projectDir, {
      title: title || '未命名项目',
      width: CFG.width, height: CFG.height, fps: CFG.fps, fade: CFG.fade,
      voice: voice || '',
      style: style || '',
    });
  }
  project.title = String(title || project.title || '未命名项目').slice(0, 80);
  // 空串表示"按人设决定"，这是契约的一部分，不能被 || 覆盖成别的
  project.style = style == null ? project.style : String(style);
  project.voice = voice == null ? project.voice : String(voice);
  project.scenes = scenes.map((s, i) => P.normalizeScene(s, { label: `scene#${i}`, onDegrade: log }));
  P.saveProject(CFG.projectDir, project);
  return {
    id: project.id,
    title: project.title,
    scenes: project.scenes.length,
    style: project.style,
    voice: project.voice,
  };
}


/*
 * 这里原来有一个 buildPlanPrompt：一次性让模型写整份"rich/draw 分镜"。
 * 它和两段式规划是两条腿，行为不一致，而且它教模型写 draw 图元 ——
 * 现在画面只走 manim，/v1/create 也改成走 planTwoStage（同一套提示词），
 * 于是整段删掉。plot/draw 的**渲染**分支仍在（旧项目兼容），只是不再被规划选中。
 */

function parsePlan(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(s);
    if (obj && Array.isArray(obj.scenes) && obj.scenes.length) return obj;
    // 单场脚本的响应形状是 {"manim":{"scene","code"}}，没有 scenes。
    // 以前这里只认 scenes，于是每一场 manim 都被判成 PLAN_NOT_JSON 降级成文字卡 ——
    // "画什么"再具体也出不了动画。两种形状都是合法规划结果。
    if (obj && obj.manim && typeof obj.manim === 'object'
      && typeof obj.manim.code === 'string' && obj.manim.code.trim()) return obj;
  } catch { }
  return null;
}

/** 分镜归一化：把模型可能给出的坏值收进合法范围，避免渲染阶段炸掉。 */
function normalizePlan(plan) {
  const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : fallback);
  // 可选字符串字段：没有/不是字符串/空白 → null。故意不在这里校验取值是否"认识"，
  // 因为不认识的值由渲染层兜底（渲染层拿到不认识的 motion 会退回默认慢推），
  // 这里过于严格反而会丢掉调用方后续可能加的新玩法。
  const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const MOTIONS = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right'];
  const scenes = (plan.scenes || []).slice(0, CFG.maxScenes).map((s, i) => {
    // 统一交给 project.js 的 normalizeScene：字段白名单只该有一份。
    // 之前这里手写了一份，结果 kind/html/steps/stickers 全被丢掉 —— 讲解画面永远出不来。
    const normalized = P.normalizeScene(s, { label: `scene#${i}`, onDegrade: log });
    normalized.seconds = Math.min(MAX_SCENE_SECONDS, Math.max(CFG.minSceneSeconds, Number(s.seconds) || normalized.seconds));
    normalized.actualSeconds = normalized.seconds;
    normalized.narrationMs = 0;
    // 时长被夹回合法区间后，picture 缓存键依赖它，所以要在写完 seconds 之后再定
    return normalized;
  });
  if (!scenes.length) {
    const fallback = P.normalizeScene({ text: plan.title || '短视频', seconds: 3 });
    fallback.actualSeconds = fallback.seconds;
    scenes.push(fallback);
  }

  // 总时长封顶：超了就把每场按比例压回来
  // 注意这里只是"计划时长"的粗调；真正的封顶在 planWithNarration（那里知道旁白有多长，
  // 才知道哪一场压不得）。
  let total = scenes.reduce((a, s) => a + s.seconds, 0);
  if (total > CFG.maxTotalSeconds + CFG.fade * (scenes.length - 1)) {
    const target = CFG.maxTotalSeconds;
    const gaps = CFG.fade * (scenes.length - 1);
    const k = (target + gaps) / total;
    for (const s of scenes) s.seconds = Math.max(CFG.minSceneSeconds, Number((s.seconds * k).toFixed(2)));
    total = scenes.reduce((a, s) => a + s.seconds, 0);
    for (const s of scenes) s.actualSeconds = s.seconds;
  }
  // xfade 是重叠转场：成片比"场次之和"短 (n-1)*fade 秒
  const span = Math.max(0.5, total - CFG.fade * (scenes.length - 1));
  return { title: String(plan.title || '').slice(0, 60), scenes, totalSeconds: Number(span.toFixed(2)) };
}

// ------------------------------------------------------- 旁白驱动时长 ----

/**
 * 解析 WAV 头，拿到"算时长"和"补静音"要用的几个数。
 * 返回 null 表示这不是一个能理解的无压缩 WAV（那就不碰它，宁可少个保险也不写坏文件）。
 */
function parseWav(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let format = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let dataOffset = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      byteRate = buf.readUInt32LE(body + 8);   // 采样率(4)之后是 byteRate(4)
      blockAlign = buf.readUInt16LE(body + 12); // 一个采样帧的字节数
    } else if (id === 'data') {
      dataOffset = body;
      // 有的工具把 size 写成 0 或 0xFFFFFFFF 表示"到文件尾"，这种按剩余字节算
      dataSize = (size === 0 || size === 0xFFFFFFFF || body + size > buf.length) ? buf.length - body : size;
      break;
    }
    if (size <= 0) break;              // 坏头：块长 0 会让循环打转
    offset = body + size + (size % 2); // RIFF 块按偶数字节对齐，奇数长度补 1 字节
  }
  if (!byteRate || !dataOffset || !dataSize) return null;
  // 只认 PCM(1) / IEEE float(3) / EXTENSIBLE(0xFFFE)：这几种"补零字节"就是静音，
  // 其它编码（ADPCM 之类）补零会变成噪音，宁可不补。
  if (format !== 1 && format !== 3 && format !== 0xFFFE) return null;
  return { format, byteRate, blockAlign: blockAlign || 1, dataOffset, dataSize };
}

/**
 * 从 WAV 头里算时长（毫秒）。不依赖 ffprobe 子进程：
 * 一次渲染要量好几条 wav，每条 fork 一个进程太慢，而且服务器上不一定装了 ffprobe。
 *
 * 公式：时长(秒) = data 块载荷字节数 / byteRate
 *   - byteRate（fmt 块 +8，4 字节小端）= 采样率 × 声道数 × 位深/8，单位"字节/秒"
 *   所以毫秒 = dataSize / byteRate × 1000。
 * 兼容：fmt 可能是 WAVE_FORMAT_EXTENSIBLE（18/40 字节），byteRate 位置不变；
 *   chunk 之间可能插 LIST/fact 等块，所以循环找块而不是读死偏移。
 */
function wavDurationMs(buf) {
  const w = parseWav(buf);
  if (!w) return null;
  return Math.round((w.dataSize / w.byteRate) * 1000);
}

/**
 * 把 wav 的 data 块尾部补静音到指定秒数（原地改文件）。
 *
 * 为什么需要：render.js 的 mixAudio 用的是 `amix duration=longest` + `-shortest`，
 * 音频轨到"最后一句旁白结束"就没了，成片会被剪到那一刻 —— 末场画面直接消失。
 * 把最后一条旁白的**临时** wav 补静音到片尾，音频轨就够长了，成片不再被剪。
 * 为什么补 wav 而不是加一条静音轨：加静音轨会改变 amix 的输入数（它默认按输入数归一化音量），
 * 旁白会莫名变小；补在已有文件尾部则完全不改混音结构。
 * 也不改 render.js —— 等那边 mixAudio 去掉 -shortest 或加 apad，这里就退化成无操作。
 */
function padWavToSeconds(file, seconds) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  const w = parseWav(buf);
  if (!w) return false;
  const cur = w.dataSize / w.byteRate;
  const target = Number(seconds);
  if (!(target > cur + 0.02)) return false;  // 已经够长，不动
  const padBytes = Math.round(((target - cur) * w.byteRate) / w.blockAlign) * w.blockAlign;
  if (padBytes <= 0) return false;
  const head = Buffer.from(buf.subarray(0, w.dataOffset));             // 到 data 载荷开头
  const payload = buf.subarray(w.dataOffset, w.dataOffset + w.dataSize);
  const tail = buf.subarray(w.dataOffset + w.dataSize);                // data 之后若还有块，保留
  const out = Buffer.concat([head, payload, Buffer.alloc(padBytes), tail]);
  out.writeUInt32LE(w.dataSize + padBytes, w.dataOffset - 4);          // data 块大小
  out.writeUInt32LE(out.length - 8, 4);                                // RIFF 块大小
  try { fs.writeFileSync(file, out); } catch { return false; }
  return true;
}

/**
 * 让音轨至少铺到片尾：给"结束得最晚"的那条旁白补静音。
 * 没有任何旁白时不用管（mixAudio 走的是 -c:v copy 分支，没有 -shortest，不会被剪）。
 */
function guardAudioTail(narrations, totalSeconds) {
  let last = null;
  for (const n of narrations) {
    const end = (Number(n.at) || 0) + (Number(n.ms) || 0) / 1000;
    if (!last || end > last.end) last = { n, end };
  }
  if (!last || !(totalSeconds > 0)) return false;
  // 补静音补在**副本**上：直接改缓存里的那条 wav，会把"片尾静音"算进这句旁白的时长，
  // 下次渲染（尤其是改了语速、后期缓存没命中时）量到的旁白会莫名变长，场时长跟着错。
  const src = last.n.file;
  const copy = `${src.replace(/\.wav$/i, '')}-tail.wav`;
  let target = src;
  try {
    fs.copyFileSync(src, copy);
    target = copy;
  } catch { target = src; }
  const ok = padWavToSeconds(target, totalSeconds - (Number(last.n.at) || 0));
  if (ok && target !== src) last.n.file = target;
  return ok;
}

/** 量一个音频文件的毫秒数：先自己解 WAV 头，解不出来才退回 ffprobe。 */
async function measureAudioMs(file) {
  try {
    const ms = wavDurationMs(fs.readFileSync(file));
    if (ms && ms > 0) return ms;
  } catch { }
  const probe = path.join(path.dirname(CFG.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!fs.existsSync(probe)) { log('measure: 无 wav 头且找不到 ffprobe，按 0 处理 ' + file); return 0; }
  const r = await R.run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 15000);
  const sec = Number(String(r.stdout || '').trim());
  if (!Number.isFinite(sec) || sec <= 0) { log('measure: ffprobe 也没量出时长 ' + file); return 0; }
  return Math.round(sec * 1000);
}

/**
 * 把"旁白实测毫秒"算进每场时长。纯函数（不碰磁盘/网络），方便直接单测。
 *
 * 规则（按顺序，后一条可压过前一条）：
 *   1. 每场 want = max(原计划秒数, 旁白秒数 + 0.6)：旁白比画面长就拉长；画面本来就长则不动
 *   2. seconds = clamp(want, minSceneSeconds, 6)
 *   3. 旁白自己超过 5.4 秒时，6 秒软上限让位给"不截断"：seconds = max(seconds, 旁白 + 0.6)
 *      —— 8 秒的解说塞进 6 秒只能截断，截断比"这场偏长"难看得多
 *   4. 成片时长 = Σseconds - (n-1)×fade（xfade 重叠转场）。超过 maxTotalSeconds 时按比例压，
 *      但只压"下限以上的部分"：每场下限 = max(minSceneSeconds, 旁白秒数 + 0.3)
 *   5. 若连"下限之和"都塞不进上限，就全部取下限，总时长允许超出 —— 宁可超时长，不能截话
 *
 * 返回新的 plan（不改传入对象）；每场带 actualSeconds（最终用的时长）与 narrationMs。
 */
function planWithNarration(plan, narrationMs, cfg) {
  const C = cfg || CFG;
  const list = Array.isArray(narrationMs) ? narrationMs : [];
  const minSec = Number(C.minSceneSeconds) || 2;
  const fade = Number(C.fade) >= 0 ? Number(C.fade) : 0.4;
  const cap = Number(C.maxTotalSeconds) || 60;
  const round2 = (v) => Number(v.toFixed(2));

  const scenes = (plan.scenes || []).map((s, i) => {
    const raw = Number(list[i]);
    const ms = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
    const speak = ms / 1000;
    const planned = Number(s.seconds) > 0 ? Number(s.seconds) : minSec;
    const need = ms > 0 ? speak + NARRATION_PAD : 0;   // 这场至少要多长才够把这句念完
    const want = Math.max(planned, need);
    const soft = Math.min(MAX_SCENE_SECONDS, Math.max(minSec, want));
    const seconds = round2(need > 0 ? Math.max(soft, need) : soft);
    return Object.assign({}, s, { seconds, actualSeconds: seconds, narrationMs: ms });
  });

  const gaps = Math.max(0, fade) * Math.max(0, scenes.length - 1);
  const sumSec = () => scenes.reduce((a, s) => a + Number(s.seconds || 0), 0);
  let span = sumSec() - gaps;

  if (span > cap + 1e-6) {
    // 每场"压到不能再压"的位置：旁白念完还要留 0.3 秒，否则下一场会盖掉尾音
    const floors = scenes.map((s) => {
      const need = s.narrationMs > 0 ? s.narrationMs / 1000 + NARRATION_FLOOR_PAD : 0;
      return round2(Math.min(Number(s.seconds), Math.max(minSec, need)));
    });
    const floorSum = floors.reduce((a, b) => a + b, 0);
    const targetSum = cap + gaps;               // 想让 Σseconds 落到的地方
    const room = targetSum - floorSum;          // 下限之外还能自由分配的额度
    const extra = sumSec() - floorSum;          // 当前超出下限的总量
    // k 只作用于"下限以上"的部分：这样长旁白的场不会被扁平地砍掉
    const k = extra > 1e-9 && room > 0 ? Math.min(1, room / extra) : 0;
    scenes.forEach((s, i) => {
      const v = floors[i] + (Number(s.seconds) - floors[i]) * k;
      s.seconds = round2(Math.max(floors[i], v)); // 四舍五入不能把某场压破下限
      s.actualSeconds = s.seconds;
    });
    span = sumSec() - gaps;
  }

  const totalSeconds = Number(Math.max(0.5, span).toFixed(2));
  return Object.assign({}, plan, {
    scenes,
    totalSeconds,
    // 面板要能看出"这次是为旁白超了总时长"
    overBudget: totalSeconds > cap + 0.05,
  });
}

// ------------------------------------------------------------------ 渲染 ----

/**
 * speak 返回的是 wav 字节，不能走 postJson（它会当文本读）。单独实现。
 *
 * 返回值统一成 { ok, file, status, error }：调用方要能区分
 * "这句没合成出来"和"整条链路挂了"，并在渲染前把失败拦下来
 * （见 renderProject 的 VOICE_UNAVAILABLE）。以前这里失败返回 null，
 * 上层默默跳过 —— 成片于是缺一句旁白，没人知道为什么。
 */
async function fetchSpeech(text, voice, outFile) {
  if (!text) return { ok: false, error: 'EMPTY_TEXT' };
  const ctrl = new AbortController();
  // 150 秒/句：BreezeBlue Starter 档并发上限是 1，speak 内部虽然做了串行队列，
  // 但排队 + 合成叠加起来一句可能要几十秒（8 句串行整集 35~60 秒）。
  // 给 90 秒会把"正在排队"误判成"合成失败"，白白让整集失败。
  const timer = setTimeout(() => ctrl.abort(), 150000);
  try {
    const res = await fetch(`${CFG.speakUrl}/v1/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text, voice }),
      signal: ctrl.signal,
    });
    const ct = String(res.headers.get('content-type') || '');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`speak HTTP ${res.status}: ${String(body).slice(0, 200)}`);
      // speak 在 strict 模式下把失败原因写在 JSON 里（BREEZEBLUE_UNAVAILABLE /
      // QUEUE_TIMEOUT / 重试次数）。面板要能说"已重试 4 次"，所以这里必须解析出来，
      // 不能只回一个 SPEAK_HTTP_503。
      const info = parseSpeakFailure(body);
      return {
        ok: false, error: `SPEAK_HTTP_${res.status}`, status: res.status,
        speakError: info.speakError, attempts: info.attempts, retries: info.retries,
        detail: String(body).slice(0, 400),
      };
    }
    if (!ct.startsWith('audio/')) {
      // strict 模式下拿不到音色时 speak 会回 JSON（ok:false）而不是音频；
      // 任何非音频响应都当"没拿到"，不能拿它当静音混进去。
      const body = await res.text().catch(() => '');
      log(`speak 返回的不是音频（${ct || 'no content-type'}）: ${String(body).slice(0, 200)}`);
      const info = parseSpeakFailure(body);
      return {
        ok: false, error: 'SPEAK_NO_AUDIO', status: res.status,
        speakError: info.speakError, attempts: info.attempts, retries: info.retries,
        detail: String(body).slice(0, 400),
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return { ok: false, error: 'SPEAK_TOO_SHORT', status: res.status, detail: `${buf.length} bytes` };
    fs.writeFileSync(outFile, buf);
    return { ok: true, file: outFile, status: res.status };
  } catch (err) {
    log('speak failed: ' + (err && err.message || err));
    return { ok: false, error: 'SPEAK_FAILED', detail: String(err && err.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 speak 的失败响应里抽原因。响应可能是 JSON，也可能是纯文本/HTML（代理错误页），
 * 所以解析失败一律退回空值，调用方按"连不上"处理。
 */
function parseSpeakFailure(body) {
  const out = { speakError: '', attempts: 0, retries: 0 };
  try {
    const d = JSON.parse(String(body || ''));
    if (!d || typeof d !== 'object') return out;
    out.speakError = String(d.error || d.code || (d.lastError ? 'SPEAK_FAILED' : '') || '');
    out.attempts = Number(d.attempts) || 0;
    out.retries = Number(d.retries) || 0;
    if (!out.attempts && d.billing && Number(d.billing.attempts)) out.attempts = Number(d.billing.attempts);
  } catch { /* 非 JSON：保持空值 */ }
  return out;
}



function pickBgm(nameOrPath) {
  const want = String(nameOrPath || '').trim();
  if (!want) return null;
  if (fs.existsSync(want)) return want;
  const guess = path.join(CFG.bgmDir, want);
  if (fs.existsSync(guess)) return guess;
  const withExt = path.join(CFG.bgmDir, want + '.mp3');
  if (fs.existsSync(withExt)) return withExt;
  return null;
}

// ------------------------------------------------------------- 风格预设 ----

/**
 * 这次渲染用哪个风格？
 *   项目 JSON 的 style → 请求里的 style → 人设（缓存按 version 失效）→ 默认。
 * 结果里带 reason，方便面板/日志解释"为什么这集是蓝的"。
 */
async function resolveStyleFor(opts = {}) {
  return S.resolvePersonaStyle({
    stylesDir: STYLE_DIR,
    personaUrl: CFG.personaUrl,
    cacheFile: CFG.styleCacheFile,
    fallbackId: CFG.defaultStyle,
    timeoutMs: CFG.personaTimeoutMs,
    styleId: opts.styleId || '',
  });
}

/** 把风格并进"进缓存键的 cfg"：换风格必须让画面重渲（否则复用旧配色）。 */
function styleCfg(style) {
  return Object.assign({}, CFG, { styleId: style ? style.id : '', styleSig: S.signature(style) });
}

/**
 * 这一场该按什么顺序试哪些引擎（纯函数，好测）。
 *
 * 这是"rich 场景坐标轴丢失"的根因所在：以前是按 s.kind 分派的，
 *   - kind 是 manim 但 manim.code 丢了 → normalizeScene 把 kind 改回 text →
 *     manim 分支不跑、rich 分支（要求 kind==='rich' || manimFailed）也不跑 →
 *     场景里的 draw.shapes 就**被吞掉了**，最后出的是文字卡（坐标轴没了）。
 * 现在改成按"手里到底有什么素材"排序，kind 只当作附加线索：
 *   manim 脚本 > AI 生成画面 > matplotlib 代码 > draw 图元 > html > 文字卡
 * 有 draw 就一定会排在链条里，前一个引擎失败就轮到它。
 */
/**
 * 引擎名 → 面板上那句进度文案。用户只认识"manim"和"文字卡"，
 * plot/draw/html 是内部回退路径，原样显示反而让人以为出错了。
 */
function engineLabel(eng) {
  if (eng === 'manim') return 'manim';
  if (eng === 'text') return '文字卡';
  if (eng === 'aivideo') return 'AI 画面';
  if (eng === 'plot') return '图表';
  if (eng === 'draw') return '图形';
  if (eng === 'html') return '讲解画面';
  return String(eng || '画面');
}

function sceneEngines(s) {
  const sc = s || {};
  const hasManim = Boolean(sc.manim && typeof sc.manim.code === 'string' && sc.manim.code.trim());
  // AI 生成画面的判据和 project.js 的 normalizeScene 一致：有 video.prompt 才算
  const hasVideo = Boolean(sc.video && typeof sc.video.prompt === 'string' && sc.video.prompt.trim());
  const hasPython = Boolean(sc.python && String(sc.python).trim());
  const hasDraw = Boolean(sc.draw && Array.isArray(sc.draw.shapes) && sc.draw.shapes.length);
  const hasHtml = Boolean(sc.html && String(sc.html).trim());
  const out = [];
  if (hasManim) out.push('manim');
  if (hasVideo) out.push('aivideo');
  if (hasPython) out.push('plot');
  if (hasDraw) out.push('draw');
  if (hasHtml) out.push('html');
  // 这一场是 aivideo 场（两种素材都有）时，AI 画面优先：
  // 用户明确选了生成画面，先按它来；失败再退 manim（自愈规则："aivideo 失败 → manim"）。
  if (hasVideo && String(sc.kind || '') === 'aivideo') {
    const at = out.indexOf('aivideo');
    if (at > 0) { out.splice(at, 1); out.unshift('aivideo'); }
  }
  out.push('text');
  return out;
}

/**
 * 把 AI 生成的片段对到本项目的规格（宽高/fps/时长）。
 *
 * wan 只出 5 或 10 秒，而这一场可能是 3 秒（截断）也可能被旁白拉长到 12 秒（补足）。
 * 直接复用 manim 那条 normalizeClip：缩放补边 + 克隆末帧补足 + -t 截断，
 * 已经是目标规格且时长够就只复制，不多花一次编码。
 * Manim 模块缺失时（比如只装了 ffmpeg 的精简部署）退回到本地 ffmpeg 命令，别让 aivideo 白生成。
 */
async function fitAiVideoClip({ inFile, work, index, seconds, w, h, fps, threads = 0 }) {
  const out = path.join(work, `wan-${index}-norm.mp4`);
  if (Manim && typeof Manim.normalizeClip === 'function') {
    const norm = await Manim.normalizeClip({ ffmpeg: CFG.ffmpeg, inFile, outFile: out, w, h, fps, seconds, threads });
    return norm && norm.ok
      ? { ok: true, file: norm.file, reencoded: Boolean(norm.reencoded) }
      : { ok: false, error: `WAN_NORMALIZE_FAILED: ${(norm && norm.error || '').slice(0, 200)}` };
  }
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
    'tpad=stop_mode=clone:stop_duration=2',
    'format=yuv420p',
  ].join(',');
  const r = await R.run(CFG.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', inFile,
    '-vf', vf, '-t', String(Number(seconds) || 5),
    '-threads', String(Math.max(0, Math.floor(Number(threads) || 0))),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out,
  ], 180000);
  if (r.code !== 0 || !fs.existsSync(out)) {
    return { ok: false, error: `WAN_NORMALIZE_FAILED: ${String(r.err || r.out || '').slice(-200)}` };
  }
  return { ok: true, file: out, reencoded: true };
}

/** AI 视频密钥：只从 secrets 读，返回 { key, source }；source 只用于日志（不含密钥）。 */
function wanKeyInfo() {
  if (!Wan) return { key: '', source: '' };
  return Wan.resolveKey({
    envKey: process.env.WAN_API_KEY || '',
    keyPath: CFG.wanKeyPath,
    keyFiles: [path.join(DIR, '..', 'secrets', 'qwen.key')],
    jsonFiles: [CFG.wanKeyJson],
  });
}


/**
 * 跑一个引擎，返回 { ok, file, error, applied }。失败只返回错误，不抛。
 * 各引擎的"成功判据"不一样（manim 要 mp4、GDI/pyplot 要 png 再合成片段），
 * 所以统一在这里收口，renderProject 只关心"成没成"。
 */
async function renderSceneEngine({ eng, s, index, style, work, renderQuality, threads = 0 }) {
  const w = CFG.width;
  const h = CFG.height;
  const fps = CFG.fps;
  if (eng === 'manim') {
    if (!Manim) return { ok: false, error: 'MANIM_MODULE_MISSING' };
    if (!fs.existsSync(CFG.python)) return { ok: false, error: 'NO_PYTHON' };
    // 风格注入在这里做：颜色/背景/线宽/字体都改成风格值，模型写 BLUE 也会被换掉。
    // 参考图在风格注入之前兜底注入：模型没写 ImageMobject 也能看到图。
    let manimCode = s.manim.code;
    const imagePath = s.imagePath || (s.image ? (resolveSceneImage(s.image).path || '') : '');
    if (imagePath) {
      const inj = ensureManimImage(manimCode, imagePath);
      if (inj.injected) {
        manimCode = inj.code;
        log(`scene#${index} 参考图已注入 manim 背景层：${path.basename(imagePath)}`);
      } else if (inj.error) {
        log(`scene#${index} 参考图注入失败（${inj.error}），按模型代码继续`);
      }
    }
    const styled = S.applyToManimCode(manimCode, style);
    // 动画时长对齐旁白：把 run_time / self.wait 的数字拉伸或压缩到这一场的秒数（只动数字，不动结构）。
    // 压缩下限由 config.animCompressFloor 控制（默认 0.85 = 最多快 15%），放不下不再强压。
    const aligned = Rhythm
      ? Rhythm.alignManimCode(styled.code, Number(s.seconds) || 0, CFG.animCompressFloor)
      : { code: styled.code, before: 0, after: 0, action: 'off' };
    if (Rhythm && aligned.action !== 'none') {
      log(`scene#${index} manim 时长对齐(${aligned.action}) 自然 ${aligned.before}s -> 实际 ${aligned.after}s`
        + `（本场 ${s.seconds}s，系数 ${Number(aligned.factor).toFixed(2)}`
        + `${aligned.floorHit ? '，已到压缩下限 0.85，多出的部分会被截掉' : ''}）`);
    }
    // 画质档：medium=-qm@项目分辨率（默认），low=-ql@半分辨率（草稿，快约一倍），high=-qh
    const qp = Rhythm
      ? Rhythm.qualityPlan({ renderQuality: renderQuality || CFG.renderQuality, manimQuality: CFG.manimQuality, w, h, fps })
      : { quality: CFG.manimQuality || '-qm', w, h, fps, level: 'legacy' };
    const mm = await Manim.renderManim({
      python: CFG.python, work, index, code: aligned.code, sceneName: s.manim.scene,
      quality: qp.quality, seconds: s.seconds,
      // 注意：w/h 是**产出规格**（normalizeClip 的目标），renderW/renderH 才是 manim 实际渲染分辨率。
      // 草稿档要的是"少画像素再放大"，不是"交出 540p 成片"。
      w, h, fps, renderW: qp.w, renderH: qp.h, ffmpeg: CFG.ffmpeg,
      timeoutBaseMs: CFG.manimTimeoutBaseMs, timeoutPerSecondMs: CFG.manimTimeoutPerSecondMs,
      threads,
    });
    if (!mm.ok) {
      // UNSAFE_CODE / NO_LATEX 是策略性拒收，带上 detail 方便排查是哪一行
      return { ok: false, error: `${mm.error}${mm.detail ? `(${mm.detail})` : ''}` };
    }
    log(`scene#${index} manim 渲完 ${mm.ms}ms（质量档 ${qp.level}/${qp.quality} ${qp.w}x${qp.h}→${w}x${h}，${mm.reencoded ? '已统一到项目规格' : '原始规格'}）` +
      ` 风格=${styled.style.id} 换色=${styled.applied.colors} 背景=${styled.applied.background} 线宽=${styled.applied.stroke} 字体=${styled.applied.font}` +
      // 文字兜底统计：Text 一共几处、补了几处 BOLD、抬了几处字号、补了几处中文字体。
      // 用户嫌"字很细"时，先看这一行就知道是"模型没写"还是"兜底没生效"。
      ` 文字=${mm.textEnhance ? mm.textEnhance.calls : 0}处(BOLD+${mm.textEnhance ? mm.textEnhance.bold : 0}` +
      ` 字号+${mm.textEnhance ? mm.textEnhance.sized : 0} 中文字体+${mm.textEnhance ? mm.textEnhance.font : 0})` +
      `${mm.partialFreed ? ` 清缓存 ${Math.round(mm.partialFreed / 1048576)}MB` : ''}`);
    // anim/animBefore 带出去：字幕模块用它报"旁白/场/动画"三个数
    return { ok: true, file: mm.file, applied: styled.applied, anim: aligned.after, animBefore: aligned.before };
  }
  if (eng === 'aivideo') {
    if (!Wan) return { ok: false, error: 'WAN_MODULE_MISSING' };
    const keyInfo = wanKeyInfo();
    if (!keyInfo.key) {
      return {
        ok: false,
        error: 'WAN_KEY_MISSING: 没有密钥（配 config.wanKeyPath 指向 secrets\\wan.key，或放 secrets\\qwen.key）',
      };
    }
    // 首帧参考图：只有 CFG.aivideoImage 打开（对照实验证实网关真的吃这个字段）才传。
    // 传本地文件时编码成 data URL —— 服务器端口不对外，网关拿不到我们的上传链接。
    let firstFrameUrl = '';
    if (s.imagePath && CFG.aivideoImage) {
      try {
        firstFrameUrl = imageAsDataUrl(s.imagePath);
        log(`scene#${index} ai 画面带首帧参考图（data URL ${Math.round(firstFrameUrl.length / 1024)}KB）：${path.basename(s.imagePath)}`);
      } catch (err) {
        log(`scene#${index} 首帧参考图编码失败，本条不带图：${err && err.message || err}`);
      }
    } else if (s.imagePath) {
      log(`scene#${index} 有参考图，但 aivideoImage 关闭（网关是否生效未证实），本条不带图`);
    }
    // 密钥来源只打路径，密钥本身永远不进日志
    log(`scene#${index} ai 画面生成中（prompt=${String(s.video.prompt).slice(0, 60)}… 密钥来自 ${path.basename(keyInfo.source)}${firstFrameUrl ? ' 带首帧图' : ''}）`);
    const clip = await Wan.generateClip({
      key: keyInfo.key,
      prompt: s.video.prompt,
      seconds: s.seconds,
      size: s.video.size,
      firstFrameUrl,
      work, index,
      timeoutMs: CFG.wanTimeoutMs,
      ffmpeg: CFG.ffmpeg,
    });
    if (!clip.ok) {
      return { ok: false, error: clip.error, taskId: clip.taskId, ms: clip.ms };
    }
    // 5/10 秒的产物对到本场秒数：短的克隆末帧补足、长的截断，规格统一到项目宽高
    const norm = await fitAiVideoClip({ inFile: clip.file, work, index, seconds: s.seconds, w, h, fps, threads });
    if (!norm.ok) return { ok: false, error: norm.error };
    log(`scene#${index} ai 画面完成 ${clip.ms}ms（task=${clip.taskId} ${clip.width}x${clip.height} ${clip.duration}s ${Math.round(clip.bytes / 1024)}KB${clip.firstFrame ? ' 首帧图已提交' : ''}）` +
      `${norm.reencoded ? ' → 已对齐项目规格' : ''}`);
    return { ok: true, file: norm.file, taskId: clip.taskId, ms: clip.ms, firstFrame: Boolean(clip.firstFrame) };
  }
  if (eng === 'plot') {
    if (!Pyplot || !fs.existsSync(CFG.python)) return { ok: false, error: 'PYPLOT_UNAVAILABLE' };
    const py = await Pyplot.renderPyplot({ python: CFG.python, work, index, code: s.python, w, h });
    if (!py || !py.ok) return { ok: false, error: `PYPLOT_FAILED: ${(py && py.error || '').slice(0, 200)}` };
    const slides = await buildStepClip({ work, index, pngs: [py.png], seconds: s.seconds, fps, w, h });
    if (!slides || !slides.ok) return { ok: false, error: `STEP_CLIP_FAILED: ${(slides && slides.error || '').slice(0, 200)}` };
    return { ok: true, file: slides.file };
  }
  if (eng === 'draw') {
    if (!GdiScene) return { ok: false, error: 'GDI_MODULE_MISSING' };
    const stills = await GdiScene.renderGdiStills({
      psScript: path.join(DIR, 'lib', 'draw.ps1'),
      work, index, spec: s.draw, w, h,
    });
    if (!stills || !stills.ok) return { ok: false, error: `GDI_FAILED: ${(stills && stills.error || '').slice(0, 200)}` };
    const slides = HTMLScene
      ? await HTMLScene.buildSlidesClip({ ffmpeg: CFG.ffmpeg, work, index, pngs: stills.pngs, seconds: s.seconds, fps, w, h })
      : await R.concatClips({ ffmpeg: CFG.ffmpeg, clips: stills.pngs, out: path.join(work, `slides-${index}.mp4`), threads });
    if (!slides || !slides.ok) return { ok: false, error: `STEP_CLIP_FAILED: ${(slides && slides.error || '').slice(0, 200)}` };
    return { ok: true, file: slides.file, steps: stills.pngs.length };
  }
  if (eng === 'html') {
    if (!HTMLScene) return { ok: false, error: 'HTML_MODULE_MISSING' };
    const stills = await HTMLScene.renderHtmlStills({
      edgePath: CFG.edgePath, work, index, html: s.html, title: s.text, steps: s.steps,
      w, h, timeoutMs: 30000,
    });
    if (!stills || !stills.ok) return { ok: false, error: `HTML_FAILED: ${(stills && stills.error || '').slice(0, 200)}` };
    const slides = await HTMLScene.buildSlidesClip({ ffmpeg: CFG.ffmpeg, work, index, pngs: stills.pngs, seconds: s.seconds, fps, w, h });
    if (!slides || !slides.ok) return { ok: false, error: `STEP_CLIP_FAILED: ${(slides && slides.error || '').slice(0, 200)}` };
    return { ok: true, file: slides.file };
  }
  return { ok: false, error: `UNKNOWN_ENGINE_${eng}` };
}



/**
 * 一次性渲染（旧接口 /v1/render 与 /v1/create 走这里）。
 * 内部生成一个临时项目、scope='all' 全量渲染 —— 和项目模式共用同一套渲染代码，
 * 避免"两条路径行为不一致"这种最难查的 bug。
 */
async function renderPlan(plan, opts = {}) {
  const norm = normalizePlan(plan);
  const project = P.createProject(CFG.projectDir, {
    title: norm.title || '一次性渲染',
    width: CFG.width, height: CFG.height, fps: CFG.fps, fade: CFG.fade,
    voice: opts.voice || '', bgm: opts.bgm || '',
    style: opts.style || '',
  });
  project.scenes = norm.scenes.map((s, i) => P.normalizeScene(s, { label: `scene#${i}`, onDegrade: log }));
  P.saveProject(CFG.projectDir, project);

  const r = await renderProject(project, opts, 'all');
  if (!r.ok) return r;
  return {
    ok: true,
    file: r.file,
    jobId: r.renderId,
    bytes: r.bytes,
    seconds: r.seconds,
    plan: r.plan,
    narrationCount: r.narrationCount,
    overBudget: r.overBudget,
    ms: r.ms,
    style: r.style,
  };
}

/**
 * 把若干张静帧串成一个"分步讲解"片段。
 *
 * 3B1B 那类片子的观感来自两点：每一步之间是**渐变**而不是硬切，且画面**一直在缓慢运动**。
 * 所以这里每张图先各自做一次轻微 zoompan（1.00→1.04），再用 xfade 连接。
 * 代价是每步多一次编码（约 0.3s/步），换来的是不再像 PPT 翻页。
 */
async function buildStepClip({ work, index, pngs, seconds, fps = 30, w, h, fade = 0.35 }) {
  if (!pngs.length) return { ok: false, error: 'NO_PNGS' };
  const n = pngs.length;
  if (n === 1) {
    return R.sceneClip({ ffmpeg: CFG.ffmpeg, work, index, stillPng: pngs[0], seconds, w, h, fps });
  }
  // 每步至少 0.8 秒，否则过渡会盖住内容
  const minStep = 0.8;
  const per = Math.max(minStep, (seconds + fade * (n - 1)) / n);
  const clips = [];
  for (let k = 0; k < n; k++) {
    const c = await R.sceneClip({
      ffmpeg: CFG.ffmpeg, work, index: `${index}-s${k}`, stillPng: pngs[k],
      seconds: Number(per.toFixed(3)), w, h, fps,
    });
    if (!c.ok) return { ok: false, error: `STEP_CLIP_FAILED#${k}: ${(c.error || '').slice(0, 200)}` };
    clips.push(c.file);
  }
  const out = path.join(work, `steps-${index}.mp4`);
  const cat = await R.concatClips({ ffmpeg: CFG.ffmpeg, clips, durations: clips.map(() => per), out, fade });
  return cat.ok ? { ok: true, file: out } : { ok: false, error: `STEP_CONCAT_FAILED: ${(cat.error || '').slice(0, 200)}` };
}

// ------------------------------------------------------- 项目渲染（增量） --

/**
 * 拿一段旁白：命中缓存直接返回，否则合成并写进缓存。
 * 缓存键是 (文本, 音色)，所以"只改台词"时只有改到的那几场需要重新合成。
 *
 * 失败返回 { error, status }（不带 wav）—— 不写缓存，下次还会重试。
 * 任务化之后这里多了"每句重试 2 次（间隔 3s/8s）"：一句拿不到不该让整集失败，
 * 渲染层会把这一场静音并记 warnings，整集继续出片（见 renderProject）。
 */
async function getSpeechCached(project, scene, voice, cdir, opts = {}) {
  const text = String(scene.narration || '');
  if (!text) return null;
  const key = P.audioKey(text, voice);
  const hit = project.audioCache[key];
  if (hit && fs.existsSync(hit.wav)) return { wav: hit.wav, ms: hit.ms, key, cached: true, attempts: 0 };

  const wav = path.join(cdir, `tts-${key}.wav`);
  const retries = Math.max(0, Number(opts.retries == null ? 2 : opts.retries) || 0);
  const delays = Array.isArray(opts.delays) && opts.delays.length ? opts.delays : [3000, 8000];
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const waitMs = Math.max(0, Number(delays[Math.min(attempt - 1, delays.length - 1)]) || 0);
      log(`旁白重试 ${attempt}/${retries}（等 ${Math.round(waitMs / 1000)}s 再合成）：${text.slice(0, 24)}…`);
      await sleep(waitMs);
    }
    const got = await fetchSpeech(text, voice, wav);
    if (got && got.ok) {
      const ms = await measureAudioMs(got.file);
      project.audioCache[key] = { wav: got.file, ms, at: new Date().toISOString() };
      return { wav: got.file, ms, key, cached: false, attempts: attempt + 1 };
    }
    last = got || {};
    log(`旁白失败（第 ${attempt + 1}/${retries + 1} 次）：${last.error || 'SPEAK_FAILED'}`
      + `${last.speakError ? `/${last.speakError}` : ''} ${String(last.detail || '').slice(0, 120)}`);
  }
  return {
    error: (last && last.error) || 'SPEAK_FAILED',
    status: (last && last.status) || 0,
    speakError: (last && last.speakError) || '',
    attempts: (last && last.attempts) || (retries + 1),
    retries: (last && last.retries) || retries,
    detail: (last && last.detail) || '',
    key,
    tried: retries + 1,
  };
}

/**
 * 把旁白塞进已定的画面长度里（audio-only 重做时用）。
 * 画面不能动，所以：短了就留白（mix 时 apad 处理），长了就用 atempo 加速到装得下。
 * 加速上限 1.25 倍 —— 再快人声就不自然了，宁可让它略超一点。
 */
async function fitNarration(wav, ms, maxSeconds, work, index) {
  const limit = Math.max(0.5, maxSeconds - 0.25) * 1000;
  if (!ms || ms <= limit) return { wav, ms };
  const tempo = Math.min(1.25, ms / limit);
  if (tempo <= 1.01) return { wav, ms };
  const out = path.join(work, `fit-${index}.wav`);
  const r = await R.run(CFG.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wav, '-filter:a', `atempo=${tempo.toFixed(3)}`, out,
  ], 120000);
  if (r.code !== 0 || !fs.existsSync(out)) {
    log(`scene#${index} 旁白压缩失败，保持原速（可能轻微超出该场）`);
    return { wav, ms };
  }
  const newMs = Math.round(ms / tempo);
  log(`scene#${index} 旁白 ${Math.round(ms)}ms -> ${newMs}ms（atempo=${tempo.toFixed(2)}）以塞进 ${maxSeconds}s`);
  return { wav: out, ms: newMs };
}

/**
 * 等一会儿。配音重试的间隔（3s/8s）用它，不引入额外依赖。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * manim 首次渲染失败 → 把 stderr 尾部（≤400 字符）贴回模型，让它修一次。
 *
 * 为什么值得多花一次模型调用：模型写 manim 代码的失败率不低（MathTex 包 $、
 * include_numbers、少个冒号），直接降级文字卡等于把用户要的动画扔了。
 * 模型看到真实报错后大部分能改对；改不对再按引擎链降级，成本只是一次调用。
 *
 * 返回 { ok, code, scene } 或 { ok:false, error }。
 */
async function repairManimScene({ scene, index, style, errorText, req }) {
  const tail = String(errorText || '')
    .replace(/^MANIM_[A-Z]+\([^)]*\)\s*/, '')
    .replace(/^UNSAFE_CODE\(([^)]*)\)\s*/, '代码被安全闸门拒收（$1）：')
    .trim()
    .slice(-400);
  const code = scene && scene.manim && scene.manim.code ? String(scene.manim.code) : '';
  const lines = [
    `上一次生成的 manim 代码报错了：${tail || '未知错误'}`,
    '请修正后重新输出完整脚本，只输出 JSON。',
    '',
    `这一场：标题「${(scene && scene.text) || ''}」，旁白「${(scene && scene.narration) || ''}」，${Number(scene && scene.seconds) || 4} 秒。`,
    scene && scene.visual_hint ? `用户指定的画面：${String(scene.visual_hint).slice(0, 400)}` : '',
    '',
    '## 输出形状',
    '{"manim":{"scene":"类名","code":"from manim import *\\nclass 类名(Scene):\\n    def construct(self):\\n        ..."}}',
    '',
    '## 硬约束（违反会再次失败）',
    '- 只写 from manim import * + 一个 class X(Scene) 和它的 def construct(self)，类名与 manim.scene 逐字一致',
    '- 只修报错相关的地方，不要整段重写成别的画面；不要 include_numbers=True / DecimalNumber / Integer',
    '- MathTex 参数不要再包 $；中文 Text 必须 font="Microsoft YaHei"',
    '- 代码 ≤60 行，单类，不要 __main__，不要读写文件/网络/subprocess',
    '',
    '## 报错的代码（供你定位）',
    code.slice(0, 4000),
  ].filter(Boolean);
  const r = await askJson(lines.join('\n'), { req, sessionId: 'studio-manim-repair' });
  if (!r.ok) return { ok: false, error: r.error || 'REPAIR_FAILED' };
  const obj = r.json && r.json.manim && typeof r.json.manim === 'object' ? r.json.manim : null;
  const fixed = obj && typeof obj.code === 'string' ? stripMathDelims(obj.code.trim()) : '';
  if (!fixed) return { ok: false, error: 'REPAIR_NO_CODE' };
  const unsafe = Manim ? Manim.checkCode(fixed) : null;
  if (unsafe) return { ok: false, error: `REPAIR_UNSAFE(${unsafe})` };
  const noLat = Manim ? Manim.checkNoLatex(fixed) : null;
  if (noLat) return { ok: false, error: `REPAIR_NO_LATEX(${noLat})` };
  const sceneName = obj && typeof obj.scene === 'string' && obj.scene.trim() ? obj.scene.trim() : null;
  return { ok: true, code: fixed.slice(0, 8000), scene: sceneName };
}

/**
 * 给一场的片段加装饰边框（克莱因蓝）。
 *
 * 单独抽成函数，渲染循环里只有一行调用 —— 这样边框的判定/降级/耗时统计全收在这，
 * 渲染主流程不被装饰逻辑搅乱，也不会和"表情叠加"那段互相干扰。
 *
 * 判定用的是这一场**最终实际用的引擎**（manim 失败退文字卡时传进来的是 text），
 * 不是分镜里的 kind：降级之后画面是什么，就该按什么决定加不加框。
 *
 * 失败不致命：边框只是装饰，异常全部吞掉、返回原片段 —— 不能因为一次 ffmpeg 失败
 * 把整场画面丢掉。返回 { file, framed, ms }，file 是最终该进缓存的片段。
 */
async function applySceneFrame({ clipFile, engine, scene, index, work, threads = 0 }) {
  if (!Frame || !clipFile) return { file: clipFile, framed: false, ms: 0 };
  try {
    // 每场一个边框目录：场级并行时两场不会同时写同一张 border-*.png（半截 PNG 会让 overlay 失败）
    const frameDir = path.join(work, `frame-${index}`);
    const r = await Frame.applyFrame({
      ffmpeg: CFG.ffmpeg,
      videoIn: clipFile,
      out: path.join(frameDir, 'out.mp4'),
      frame: CFG.frame,
      engine,
      scene,
      fps: CFG.fps,
      width: CFG.width,
      height: CFG.height,
      log: (msg) => log(`scene#${index} ${msg}`),
      threads,
    });
    if (r && r.framed) {
      log(`scene#${index} 装饰边框 ${r.width}px ${String(r.color).toUpperCase()}`
        + `（内线 ${r.innerWidth}px，${r.mode}） ${r.ms}ms${r.pngMs ? `（边框图 ${r.pngMs}ms）` : ''}`);
      return { file: r.file, framed: true, ms: r.ms };
    }
    return { file: (r && r.file) || clipFile, framed: false, ms: (r && r.ms) || 0 };
  } catch (err) {
    log(`scene#${index} 装饰边框异常：${String((err && err.message) || err).slice(0, 160)}（用原片段）`);
    return { file: clipFile, framed: false, ms: 0 };
  }
}

/**
 * 渲染一个项目。
 *   scope='auto'  内容优先：旁白决定每场时长，只有受影响的场需要重画（默认）
 *   scope='all'   全部重画（换了分辨率/字体/需要绝对一致时用）
 *   scope='audio' 画面优先：所有片段必须已存在，只重做旁白与混音 —— 秒级完成
 *
 * 任务化之后这里承担"自愈"的两层：
 *   1) 场景级：manim 首次失败 → 把 stderr 尾部贴回模型修一次 → 再失败退 aivideo
 *      → 再失败退文字卡；任何一场彻底没画面就跳过它（≥1 场成功仍然出片）。
 *   2) 配音级：每句重试 2 次（3s/8s）仍失败 → 这一场静音继续；全部旁白都失败
 *      才按失败上报，但画面照样渲完、成片照样保留（不丢已完成的部分）。
 *
 * 返回里带 reuse/rendered 两个计数，调用方一眼能看出"这次省了多少"；
 * scenes[] 是每场的最终引擎与状态（ok/degraded/failed），warnings 是给人看的原因。
 */
async function renderProject(project, opts = {}, scope = 'auto') {
  const started = Date.now();
  // 项目级字幕开关：请求体带了就钉进项目（下次不传也记得），不带则用项目自己的值
  if (opts.subtitles != null) project.subtitles = Boolean(opts.subtitles);
  const voice = opts.voice || project.voice || '';
  const cdir = P.cacheDir(CFG.projectDir, project.id);
  const odir = P.outDir(CFG.projectDir, project.id);
  fs.mkdirSync(cdir, { recursive: true });
  fs.mkdirSync(odir, { recursive: true });

  const work = path.join(os.tmpdir(), `studio-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(work, { recursive: true });

  // 进度：内存进度表给 /v1/project/progress 用，onProgress 给任务（GET /v1/jobs/:id）用。
  const report = (patch) => {
    progressUpdate(project.id, patch);
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress(patch); } catch { /* 进度回写失败不能影响渲染 */ }
    }
  };
  // 取消：只在场次边界检查。ffmpeg/manim 正在跑的时候硬杀会留下半个片段，
  // 反而要重渲一次；等这一场结束再停，已完成的片段全部保留。
  const abortCheck = () => {
    if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
      const err = new Error('CANCELLED');
      err.code = 'CANCELLED';
      throw err;
    }
  };

  const warnings = [];
  const sceneResults = [];
  const voiceFailed = [];
  let narrationWanted = 0;
  const repaired = new Set();

  try {
    if (!project.scenes.length) return { ok: false, error: 'NO_SCENES' };
    const sceneTotal = project.scenes.length;
    progressStart(project.id, sceneTotal);

    // ---- 0) 风格：项目钉死的 > 请求里的 > 人设决定的 ----
    const styleInfo = await resolveStyleFor({ styleId: opts.style || project.style });
    const style = styleInfo.style;
    // 文字卡淡化：项目可以覆盖（0 = 关掉），默认用全局配置
    const edgeFade = project.textEdgeFade == null ? (Number(CFG.textEdgeFade) || 0) : Math.max(0, Number(project.textEdgeFade) || 0);
    // 画质档：请求体可以单集覆盖（草稿预览用 low），否则用 config.renderQuality。
    // 它进 sceneKey，所以换档会重渲、不会复用另一档的片段。
    const qualityLevel = String(opts.renderQuality || CFG.renderQuality || '');
    const sceneCfg = Object.assign(styleCfg(style), { textEdgeFade: edgeFade, renderQuality: qualityLevel });
    const pal = S.textPalette(style);
    log(`风格 ${style.id}（${styleInfo.source}）：${styleInfo.reason}`);

    // ---- 1) 旁白：逐句拿；失败重试 2 次，仍失败就这一场静音，整集继续 ----
    // 关键改动（旧行为）：以前任何一句拿不到就整集 VOICE_UNAVAILABLE，前面渲的画面全白费。
    const speeches = [];
    const narrationMs = project.scenes.map(() => 0);
    for (let i = 0; i < project.scenes.length; i++) {
      const s = project.scenes[i];
      if (!s.narration) { speeches.push(null); continue; }
      narrationWanted += 1;
      report({
        phase: 'voice', current: i, done: i, total: sceneTotal,
        label: `正在合成第 ${i + 1}/${sceneTotal} 句旁白`,
      });
      const raw = await getSpeechCached(project, s, voice, cdir, { retries: 2, delays: [3000, 8000] });
      // 语速 1.00（不加速）+ 裁掉两头静音：句首 200~300ms 静音会让字幕比人声早出现，
      // 句尾 200~600ms 静音会让"说完到切画面"多出半拍。1.0 时 polishSpeech 直接跳过 atempo。
      // 这里做完，下面量到的毫秒数就是最终音频的长度（字幕对齐也用它）。
      const got = Rhythm && raw && raw.wav
        ? await Rhythm.polishSpeech(raw, {
          scene: s, voice, cdir, ffmpeg: CFG.ffmpeg, speed: CFG.narrationSpeed,
          measureMs: measureAudioMs, index: i, log,
        })
        : raw;
      if (!got || !got.wav) {
        const tried = Number((got && got.tried) || 3);
        const reason = String((got && (got.speakError || got.detail || got.error)) || 'SPEAK_FAILED').slice(0, 160);
        voiceFailed.push({
          index: i,
          text: String(s.narration).slice(0, 40),
          error: (got && got.error) || 'SPEAK_FAILED',
          speakError: (got && got.speakError) || '',
          attempts: tried,
          detail: (got && got.detail) || '',
        });
        speeches.push(null);
        warnings.push(`第 ${i + 1} 场没有声音：配音合成失败（${reason}，已重试 ${Math.max(0, tried - 1)} 次），这一场静音继续`);
        log(`scene#${i} 旁白最终没拿到，这一场静音继续出片：${reason}`);
        continue;
      }
      speeches.push(got);
      narrationMs[i] = got.ms;
    }
    const allVoiceFailed = narrationWanted > 0 && voiceFailed.length === narrationWanted;
    if (voiceFailed.length) {
      log(`旁白部分失败：${voiceFailed.length}/${narrationWanted} 条没拿到（scene#${voiceFailed.map((m) => m.index).join(',')}），这些场次静音，整集继续渲染`);
    }
    if (allVoiceFailed) {
      log(`全部旁白都失败（${narrationWanted} 条）：任务按 failed 上报，但画面继续渲完并保留成片`);
      warnings.push(`全部旁白都失败（${narrationWanted} 条），成片没有声音`);
    }

    // ---- 2) 时长 ----
    let finalPlan;
    if (scope === 'audio') {
      // 画面优先：沿用分镜里已有的 seconds，不让旁白改节奏
      const total = project.scenes.reduce((a, s) => a + s.seconds, 0) - CFG.fade * (project.scenes.length - 1);
      finalPlan = { scenes: project.scenes.map((s) => Object.assign({}, s, { actualSeconds: s.seconds })), totalSeconds: Number(Math.max(0.5, total).toFixed(2)) };
    } else {
      // 动画自然时长（拉伸/压缩之前的脚本时长）先算出来：repadPlan 用它做
      // "别把动画压成快进"的兜底（场时长 = max(旁白 + pad, 自然时长 × 压缩下限)）。
      // estimateCodeSeconds 只数 run_time / self.wait，不执行代码，毫秒级、可缓存。
      if (Rhythm) {
        for (const s of project.scenes) {
          const code = s.manim && s.manim.code ? String(s.manim.code) : '';
          s.animNaturalSeconds = code ? Rhythm.estimateCodeSeconds(code) : 0;
        }
      }
      finalPlan = planWithNarration({ scenes: project.scenes }, narrationMs);
      // 节奏对齐：场时长 = max(旁白时长 + 小尾巴, 动画自然时长 × 0.85)。
      // planWithNarration 的老口径是 max(计划秒数, 旁白+0.6)：规划写 8 秒、旁白只有 3 秒时
      // 这一场会白留 5 秒空画面 —— 观众看到"话早说完了，画面还在那杵着"。
      if (Rhythm) finalPlan = Rhythm.repadPlan(finalPlan, narrationMs, CFG);
      // 因为"动画不赶"而被拉长的场次要说清楚多留了多少秒（每场 1~2 秒是可接受的代价）
      const grown = finalPlan.scenes.filter((s) => Number(s.animExtraSeconds) > 0.05);
      if (grown.length) {
        log(`动画兜底：${grown.length} 场为"动画不赶"加长（${
          grown.map((s) => `#${finalPlan.scenes.indexOf(s) + 1} 自然${Number(s.animNaturalSeconds).toFixed(2)}s→场${s.seconds}s(+${s.animExtraSeconds}s)`).join('，')
        }）`);
      }
      const clamped = finalPlan.scenes.filter((s) => s.animClamped);
      if (clamped.length) {
        log(`动画兜底：${clamped.length} 场动画太长被单场上限夹住（压缩比会低于 0.85，属极端情况）`);
      }
      // 把重算后的时长写回项目：下次 audio-only 才有据可依
      for (let i = 0; i < project.scenes.length; i++) {
        project.scenes[i].seconds = finalPlan.scenes[i].seconds;
        project.scenes[i].actualSeconds = finalPlan.scenes[i].actualSeconds;
        project.scenes[i].narrationMs = finalPlan.scenes[i].narrationMs;
        project.scenes[i].animNaturalSeconds = finalPlan.scenes[i].animNaturalSeconds;
      }
    }

    // ---- 2.5) AI 画面配额：一集最多 maxAiVideo 条 ----
    // 每条要等 100~400 秒、还占网关额度。超出的场次在这里就定死降级，
    // 渲染循环里直接跳过 aivideo 引擎 —— 而不是"渲到一半才发现超预算"。
    const maxAi = Math.max(0, Number(opts.maxAiVideo != null ? opts.maxAiVideo : CFG.maxAiVideo) || 0);
    const aiQuota = planAiVideoQuota(finalPlan.scenes, maxAi);
    if (aiQuota.total > aiQuota.allowed.size) {
      log(`成本护栏：本集 aivideo ${aiQuota.total} 场，上限 ${aiQuota.max} 场；`
        + `第 ${aiQuota.degraded.map((i) => i + 1).join('、')} 场降级为文字卡（省额度/时间）`);
    }

    // ---- 3) 画面片段：能复用就复用；不能复用就按引擎链自愈 ----
    // 边框配置签名：进缓存判定。改了颜色/宽度/内线/开关就要重渲，否则旧片段会一直用旧边框。
    const frameSig = Frame ? Frame.signature(CFG.frame) : '';
    const timeline = [];      // [{ scene, index }] 真正进了成片的场次（跳过失败的场）
    let reused = 0;
    let rendered = 0;
    const totalScenes = finalPlan.scenes.length;

    // 表情普查：**渲染入口**这一行是排查"表情去哪了"的第一现场。
    // 分镜/项目里有、这里没有 → 丢在更上游（规划/补全/落盘），别在渲染段里找；
    // 这里有、成片没有 → 才轮到下面的叠加分支说话。
    const stickerCountOf = (list) => (Array.isArray(list) ? list : [])
      .reduce((a, s) => a + (s && Array.isArray(s.stickers) ? s.stickers.length : 0), 0);
    const stickerDetailOf = (list) => (Array.isArray(list) ? list : [])
      .map((s, i) => `S${i}:${s && Array.isArray(s.stickers) ? s.stickers.length : 0}`).join(' ');
    const planStickerTotal = stickerCountOf(finalPlan.scenes);
    log(`render 入口：${totalScenes} 场，stickers 总数 ${planStickerTotal}（明细 ${stickerDetailOf(finalPlan.scenes) || '无'}）`);
    // 规划前后对不上 = stickers 在"时长规划/节奏对齐"这一步被吃掉了（repadPlan 等纯函数）
    const projectStickerTotal = stickerCountOf(project.scenes);
    if (projectStickerTotal !== planStickerTotal) {
      log(`render 入口警告：项目里 ${projectStickerTotal} 个表情，规划后只剩 ${planStickerTotal} 个 —— stickers 在时长规划这一步丢了`);
    }
    // 本集表情账本：叠加 / 跳过 / 复用（已带表情）各几场，收尾时一行报清楚
    const stickerStat = { want: 0, applied: 0, skippedScenes: 0, reusedWithStickers: 0, retried: 0 };

    // 3.0 缓存判定先单独跑一遍：命中的场直接复用，**不占并发名额**。
    // slots 按原下标存结果；最后统一按分镜顺序取 clips —— 并发完成顺序是乱的，
    // 按完成顺序拼会串场（第 5 场跑到第 2 场的位置）。
    const slots = new Array(totalScenes).fill(null);
    const pending = [];
    let scenesDone = 0;
    for (let i = 0; i < finalPlan.scenes.length; i++) {
      abortCheck();
      const s = finalPlan.scenes[i];
      const key = P.sceneKey(s, sceneCfg);
      const hit = project.cache[key];
      const hasClip = hit && fs.existsSync(hit.clip);
      // 这一场想要几个表情（0 = 本来就不该有，不必重渲）
      const wantStickers = Array.isArray(s.stickers) ? s.stickers.length : 0;
      stickerStat.want += wantStickers;
      const appliedInCache = hit ? Number(hit.stickersApplied) || 0 : 0;
      // 什么情况下"缓存里的片段不能要，必须重渲这一场"：
      //   1) 上一轮表情没叠上（stickersSkipped）—— 素材目录修好后要能自己补上；
      //   2) 缓存条目是"表情叠加功能上线之前"写的（没有 stickersApplied 字段）——
      //      那份片段根本没叠过表情，却也没标记跳过，以前就这么被无声复用了；
      //   3) 条目里记着叠了 0 个、又没标"跳过"—— 说明那次渲染压根没走叠加分支。
      // 不重渲的后果是这份"没表情"的片段被缓存永久钉住，表情再也回不来。
      const stickerStaleReason = (!wantStickers || !hit) ? '' : (
        hit.stickersSkipped ? '上次表情没叠上'
          : (hit.stickersApplied == null ? '缓存是老格式、没有表情记录'
            : (appliedInCache <= 0 ? '缓存里记着 0 个表情' : '')));
      // scope=audio 的语义是"只重做声音"，不能为了补表情去重渲画面：只记一行提示。
      const retryStickers = Boolean(stickerStaleReason) && scope !== 'audio';
      const stickerOnlyInAudio = Boolean(stickerStaleReason) && scope === 'audio';
      // 边框配置变了（换色/改宽度/关掉）：这份片段的边框不是当前配置 → 重渲这一场。
      const frameStale = Frame
        ? Frame.cacheStale(hit, { frame: CFG.frame, sig: frameSig, engine: hit && hit.engine, scene: s })
        : false;
      const canReuse = scope !== 'all' && hasClip && !retryStickers && !frameStale;
      if (retryStickers) {
        stickerStat.retried += 1;
        log(`scene#${i} ${stickerStaleReason}，这次重渲这一场补表情（其它场照旧复用）`);
      }
      if (stickerOnlyInAudio) log(`scene#${i} ${stickerStaleReason}，但本次是 scope=audio（只重做声音），画面不动；要补表情请用 scope=all`);
      if (frameStale) log(`scene#${i} 边框配置变了，重渲这一场（其它场照旧复用）`);
      if (canReuse) {
        // 复用片段时也要把"这一场动画多长"带回来：否则节奏表里动画/系数两列全是 0，
        // 重跑一次就看不出"压缩比有没有到 0.85"（大部分真实使用都是复用）。
        s.animSeconds = Number(hit.animSeconds) || 0;
        slots[i] = {
          index: i,
          scene: s,
          clip: hit.clip,
          sceneResult: { index: i, engine: String(hit.engine || 'cache'), status: 'ok', note: '复用缓存' },
        };
        reused += 1;
        scenesDone += 1;
        // 命中缓存的场不走叠加分支，不写这一行就等于"这一场的表情无声消失"。
        if (wantStickers) {
          stickerStat.reusedWithStickers += 1;
          log(`scene#${i} 表情跳过（缓存复用，片段已叠 ${appliedInCache} 个${hit.stickersSkipped ? '、上次标记跳过' : ''}）`);
        }
        report({ phase: 'scenes', current: i, done: scenesDone, total: totalScenes, engine: 'cache', label: `第 ${i + 1}/${totalScenes} 场复用缓存` });
        continue;
      }
      pending.push(i);
    }

    // 3.1 并发决策：config 可配 1/2，硬上限 2；可用内存低于阈值时本轮降级为串行。
    const conc = effectiveRenderConcurrency();
    log(conc.reason);
    // 只有一场要渲时并发没有意义（limit=1，走和以前完全一样的串行路径）
    const limit = pending.length > 1 ? conc.limit : 1;
    // 单场编码线程：并行时每场 2 线程（给另一个 manim 留核），串行时 0（ffmpeg 自己吃满）
    const sceneThreads = limit > 1 ? 2 : 0;
    if (pending.length) {
      log(`逐场编码线程：-threads ${sceneThreads}${limit > 1 ? '（每场 2 线程，给其它 manim 留核）' : '（串行，让 ffmpeg 吃满）'}`);
    }

    /**
     * 渲一场：引擎链自愈 → 文字卡兜底 → 表情 → 边框 → 落缓存。
     *
     * 只写自己 index 的临时文件（manim 的 media-<i>/、frame-<i>/、ov-<i>.mp4…），
     * 所以两场同时跑不会互相踩。project.cache 的写入是同步段，saveProject 也是
     * 同步的临时文件+改名，两场同时落盘不会把项目 JSON 写坏。
     *
     * 返回 { index, scene, clip, sceneResult, ms }；clip=null 表示这场失败、不进成片。
     */
    const renderOneScene = async (i) => {
      abortCheck();
      const tScene = Date.now();
      const s = finalPlan.scenes[i];
      const key = P.sceneKey(s, sceneCfg);
      // 按"手里有什么素材"排引擎链（sceneEngines），逐个试，谁先成用谁。
      let chain = sceneEngines(s);
      // 成本护栏之外的场次不许再调生成接口：直接把它从链条里摘掉。
      if (chain.includes('aivideo') && !aiQuota.allowed.has(i)) {
        chain = chain.filter((e) => e !== 'aivideo');
        log(`scene#${i} aivideo 超出本集上限（${aiQuota.max} 场），降级为 ${engineLabel(chain[0] || 'text')}`);
      }
      const firstEng = chain[0] || 'text';
      const originallyText = firstEng === 'text';
      report({
        phase: 'scenes', current: i, done: scenesDone, total: totalScenes,
        engine: firstEng, label: `第 ${i + 1}/${totalScenes} 场 ${engineLabel(firstEng)} 渲染中…`,
      });

      let clipFile = null;
      let engine = 'text';
      let note = '';
      let degraded = false;
      for (let ci = 0; ci < chain.length; ci++) {
        const eng = chain[ci];
        if (eng === 'text') break;
        const next = chain[ci + 1] || 'text';
        let got = null;
        try {
          got = await renderSceneEngine({ eng, s, index: i, style, work, renderQuality: qualityLevel, threads: sceneThreads });
        } catch (err) {
          got = { ok: false, error: String((err && err.message) || err) };
        }

        // ---- manim 自愈：第一次失败就把 stderr 尾部贴回模型，让它改一次 ----
        if (eng === 'manim' && got && !got.ok && !repaired.has(i) && opts.manimRepair !== false) {
          repaired.add(i);
          const rawError = String(got.error || 'unknown');
          const preview = rawError.replace(/^MANIM_[A-Z]+\([^)]*\)\s*/, '').slice(0, 120);
          log(`scene#${i} manim 失败（${preview || rawError.slice(0, 80)}），把错误贴回给模型重试一次`);
          const fix = await repairManimScene({ scene: s, style, errorText: rawError, req: opts.req });
          if (fix.ok) {
            // finalPlan.scene 是副本，得同步回项目，否则下次渲染又拿旧代码
            s.manim = { code: fix.code, scene: fix.scene || (s.manim && s.manim.scene) || null };
            // 修好的代码仍是"按当前标题/描述生成"的，戳要一起刷新 ——
            // 否则下次重渲会把它判成过期，白跑一次重新生成。
            s.manimHint = manimStampOf(s, style);
            if (project.scenes[i]) {
              project.scenes[i].manim = s.manim;
              project.scenes[i].manimHint = s.manimHint;
            }
            try { P.saveProject(CFG.projectDir, project); } catch { }
            log(`scene#${i} manim 修正代码已返回（${fix.code.length} 字符），重新渲染一次`);
            try {
              got = await renderSceneEngine({ eng: 'manim', s, index: i, style, work, renderQuality: qualityLevel, threads: sceneThreads });
            } catch (err) {
              got = { ok: false, error: String((err && err.message) || err) };
            }
            if (got && got.ok) {
              degraded = true;
              note = `manim 首次失败，把错误贴回模型修正后成功（${preview.slice(0, 80)}）`;
              warnings.push(`第 ${i + 1} 场：manim 首次报错，已把错误贴回模型修正后重渲成功`);
            } else {
              note = `manim 修正后仍失败：${String((got && got.error) || '').slice(0, 140)}`;
            }
          } else {
            note = `manim 修复失败（${fix.error}）`;
            log(`scene#${i} manim 修复失败（${fix.error}），按引擎链继续降级`);
          }
        }

        if (got && got.ok) {
          clipFile = got.file;
          engine = eng;
          // 记下这场的"动画原始时长"（manim 对齐后的脚本时长），字幕/节奏表要用它
          if (got.anim != null) s.animSeconds = Number(got.anim) || 0;
          if (!degraded) {
            if (ci > 0) {
              degraded = true;
              note = `${engineLabel(chain[ci - 1])} 失败，退回 ${engineLabel(eng)}`;
            } else if (!note) {
              note = '';
            }
          }
          break;
        }
        // 每次降级都写一条：原引擎 / 新引擎 / 原因。排查时能对上到底是哪一场变成了什么。
        const reason = String((got && got.error) || 'unknown').slice(0, 200);
        log(`scene#${i} ${engineLabel(eng)} 失败/不可用，降级为 ${engineLabel(next)}：${reason}`);
        if (!note) note = `${engineLabel(eng)} 失败：${reason}`;
      }

      // ---- 文字卡：永远的最后兜底（渐变底 + 一行大字） ----
      if (!clipFile) {
        if (!originallyText) degraded = true;
        engine = 'text';
        try {
          const stillScene = Object.assign({}, s, { bg: pal.bg, textColor: pal.textColor });
          const still = await R.sceneStill({
            ffmpeg: CFG.ffmpeg, work, index: i, scene: stillScene,
            w: CFG.width, h: CFG.height, font: CFG.font,
            imageDir: CFG.imageDir, image: s.image || undefined, motion: s.motion || undefined,
          });
          if (!still.ok) throw new Error(`SCENE_STILL_FAILED: ${(still.error || '').slice(0, 200)}`);
          const clip = await R.sceneClip({
            ffmpeg: CFG.ffmpeg, work, index: i, stillPng: still.png,
            seconds: s.seconds, w: CFG.width, h: CFG.height, fps: CFG.fps,
            image: s.image || undefined, motion: s.motion || undefined,
            edgeFade: s.image ? 0 : edgeFade,
            // 转场重叠时长传下去：文字卡的淡化要跨过 xfade 的中点，两张卡的标题才不会重影
            edgeLead: Number(CFG.fade) || 0,
            // 淡到风格底色而不是黑：白板这类浅色风格淡到黑会变成一下黑屏闪烁
            edgeColor: pal.bg.c0,
            threads: sceneThreads,
          });
          if (!clip.ok) throw new Error(`SCENE_CLIP_FAILED: ${(clip.error || '').slice(0, 200)}`);
          clipFile = clip.file;
          if (!note) note = originallyText ? '' : '降级为文字卡';
          if (degraded) warnings.push(`第 ${i + 1} 场：${note.slice(0, 120)}`);
        } catch (err) {
          // 连文字卡都出不来（ffmpeg 挂了/磁盘满）：跳过这一场，保住其它场。
          const reason = String((err && err.message) || err).slice(0, 200);
          warnings.push(`第 ${i + 1} 场没有画面，已跳过：${reason}`);
          log(`scene#${i} 连文字卡都失败，跳过这一场：${reason}`);
          return {
            index: i, scene: s, clip: null, ms: Date.now() - tScene,
            sceneResult: { index: i, engine: 'none', status: 'failed', note: `画面生成失败：${reason}` },
          };
        }
      }

      // 表情叠加：加"大肥鱼"的在场感。失败不致命 —— 画面对了比表情重要。
      // 这一步在片段落进缓存之前跑，所以缓存里的 clip 本身就是"已经带表情"的最终画面；
      // 复用缓存时不需要再叠一次（再叠会重复叠两层）。
      let stickerApplied = 0;
      let stickerMs = 0;
      let stickerSkipped = false;
      const wantedStickers = Array.isArray(s.stickers) ? s.stickers.length : 0;
      if (wantedStickers) {
        if (!Overlay) {
          stickerSkipped = true;
          stickerStat.skippedScenes += 1;
          log(`scene#${i} 跳过表情（stickers=${wantedStickers} 但 Overlay 未加载，用原片段）`);
        } else {
          const ovStarted = Date.now();
          try {
            const ov = await Overlay.overlayStickers({
              ffmpeg: CFG.ffmpeg, stickerDir: CFG.stickerDir, work, index: i,
              videoIn: clipFile, out: path.join(work, `ov-${i}.mp4`),
              w: CFG.width, h: CFG.height, stickers: s.stickers,
              // 表情不许压进底部字幕带：按字幕样式算出的安全区高度传下去，
              // 超出就由 overlay 按实际尺寸往内推（y 会被夹小）
              bottomReserve: subtitleReservePx(),
              threads: sceneThreads,
            });
            stickerMs = Date.now() - ovStarted;
            if (ov && ov.ok && ov.applied > 0) {
              clipFile = ov.file;
              stickerApplied = ov.applied;
              stickerStat.applied += ov.applied;
              // 日志里带上"播完一轮 + 停末帧"的时长，排查"表情怎么还停在那儿"时一眼能看出来
              const detail = (ov.details || [])
                .map((d) => `${d.id}@${d.at}s(${d.kind}${d.cached ? '/缓存' : ''},${d.transcodeMs || 0}ms,`
                  + `播${d.playSec || 0}s+停${d.freezeSec || 0}s${d.yClamped ? ',已上推' : ''})`)
                .join('，');
              log(`scene#${i} 表情叠加 ${ov.applied} 个 ${stickerMs}ms：${detail}`);
              if (Array.isArray(ov.skipped) && ov.skipped.length) {
                log(`scene#${i} 表情跳过 ${ov.skipped.length} 个：`
                  + ov.skipped.map((x) => `${x.id}@${x.at}s（${x.reason}）`).join('，'));
              }
            } else {
              stickerSkipped = true;
              stickerStat.skippedScenes += 1;
              // 失败原因要写全：常见的是 stickerDir 指错（文件不存在）或 GIF 转码失败，
              // 只说"跳过了"没法排查，所以把 overlay 的 skipped 明细也带上。
              const why = (Array.isArray(ov && ov.skipped) ? ov.skipped : [])
                .map((x) => `${x.id}（${x.reason}）`).join('，');
              log(`scene#${i} 表情叠加跳过：${String((ov && (ov.warning || ov.error)) || '没有可叠加的表情').slice(0, 200)}`
                + (why ? `；原因：${why}` : '') + '（用原片段，不影响出片）');
            }
          } catch (err) {
            stickerMs = Date.now() - ovStarted;
            stickerSkipped = true;
            stickerStat.skippedScenes += 1;
            log(`scene#${i} 表情叠加异常：${String((err && err.message) || err).slice(0, 200)}（用原片段，不影响出片）`);
          }
        }
      } else {
        // 没有表情也要留一行：以前这里完全沉默，"这场为什么没表情"永远查不出来。
        // 有它才能一眼分清"本来就 0 个"和"本该有、渲染时没了"。
        log(`scene#${i} 跳过表情（stickers=0）`);
      }

      // 装饰边框（克莱因蓝）：贴边不内缩；AI 满幅画面与图片底不加。接线只这一处，实现见 lib/frame.js。
      const frame = await applySceneFrame({ clipFile, engine, scene: s, index: i, work, threads: sceneThreads });
      clipFile = frame.file || clipFile;

      const dest = path.join(cdir, `clip-${key}.mp4`);
      fs.copyFileSync(clipFile, dest);
      // engine 记下来：排查"这场的坐标轴为什么没了"时一眼看出是哪个引擎出的片
      project.cache[key] = {
        clip: dest,
        engine,
        style: style.id,
        at: new Date().toISOString(),
        // 对齐后的动画时长（脚本自然时长 × 系数）：复用片段时节奏表靠它显示"动画/系数"
        animSeconds: Number(s.animSeconds) || 0,
        // 表情结果也记进缓存索引：stickersSkipped=true 的片段下一轮会重渲一次，
        // 不能把"素材目录坏了"这种失败长期缓存住；overlayMs 用来估算每场多花多少秒。
        stickersApplied: stickerApplied,
        stickersSkipped: stickerSkipped,
        overlayMs: stickerMs,
        // 边框结果也记进缓存：framed=true 便于排查"这场为什么有框/没框"；
        // frameSig 用来发现"改了颜色/宽度却没重渲"——签名对不上就重渲这一场。
        framed: Boolean(frame.framed),
        frameMs: Number(frame.ms) || 0,
        frameSig,
      };
      // 每渲完一场就落盘：进程被杀时已完成的片段不会丢，重跑直接复用。
      try { P.saveProject(CFG.projectDir, project); } catch { }
      rendered += 1;
      if (degraded && !note) warnings.push(`第 ${i + 1} 场降级为 ${engineLabel(engine)}`);
      return {
        index: i,
        scene: s,
        clip: dest,
        ms: Date.now() - tScene,
        sceneResult: {
          index: i,
          engine,
          status: degraded ? 'degraded' : 'ok',
          // 没降级时也把"加了几个表情"写上：任务卡上一眼能看出这场的表情生效了
          note: note || (stickerApplied ? `表情 ${stickerApplied} 个` : ''),
        },
      };
    };

    // 3.2 工作池：只对需要渲染的场并发；mapLimit 保证结果按原下标回填。
    if (pending.length) {
      const poolStarted = Date.now();
      let longestMs = 0;
      const done = await mapLimit(pending, limit, async (i) => {
        let r;
        try {
          r = await renderOneScene(i);
        } catch (err) {
          // 单场异常只降级这一场（CANCELLED 在池外再用 abortCheck 抛出去）
          const reason = String((err && err.message) || err).slice(0, 200);
          r = {
            index: i, scene: finalPlan.scenes[i], clip: null, ms: 0,
            sceneResult: { index: i, engine: 'none', status: 'failed', note: `渲染异常：${reason}` },
          };
        }
        longestMs = Math.max(longestMs, Number(r.ms) || 0);
        scenesDone += 1;
        const eng = (r.sceneResult && r.sceneResult.engine) || 'none';
        report({
          phase: 'scenes', current: i, done: scenesDone, total: totalScenes, engine: r.sceneResult ? r.sceneResult.engine : '',
          label: r.clip
            ? `第 ${i + 1}/${totalScenes} 场 ${engineLabel(eng)} 完成`
            : `第 ${i + 1}/${totalScenes} 场失败，已跳过`,
        });
        return r;
      });
      for (const r of done) if (r) slots[r.index] = r;
      const wallMs = Date.now() - poolStarted;
      // 验收看的数字：并发 N 场一共花了多少墙钟、最慢那一场多少秒。
      log(`渲染 ${pending.length} 场（并发 ${limit}）完成：总 ${(wallMs / 1000).toFixed(1)} 秒，最长 ${(longestMs / 1000).toFixed(1)} 秒`);
    }
    // 取消是在场次边界生效的：池里正在跑的那一场跑完，剩下的不再开新场。
    abortCheck();

    // 3.3 按分镜顺序组装：完成顺序 ≠ 分镜顺序，clips/timeline/sceneResults 一律按 index 取。
    const clips = [];
    for (let i = 0; i < totalScenes; i++) {
      const r = slots[i];
      if (!r) continue;
      if (r.sceneResult) sceneResults.push(r.sceneResult);
      if (!r.clip) continue;
      clips.push(r.clip);
      timeline.push({ scene: r.scene, index: i });
    }

    // 表情账本收尾：本集"想要几个 / 真叠了几个 / 几场复用 / 几场跳过"一次说清。
    // 这条和入口那条一起看，就能判断表情是在"入口之前"还是"叠加这一步"丢的。
    if (stickerStat.want || stickerStat.applied || stickerStat.retried) {
      log(`表情汇总：本集计划 ${stickerStat.want} 个，叠加 ${stickerStat.applied} 个，`
        + `复用已带表情 ${stickerStat.reusedWithStickers} 场，跳过 ${stickerStat.skippedScenes} 场`
        + (stickerStat.retried ? `，为补表情重渲 ${stickerStat.retried} 场` : ''));
    }

    // 一场都没成功：这才是真的没法出片（正常情况下文字卡永远成功）。
    if (!clips.length) {
      report({ status: 'failed', phase: 'failed', label: '所有场次都没有画面', error: 'ALL_SCENES_FAILED' });
      return { ok: false, error: 'ALL_SCENES_FAILED', scenes: sceneResults, warnings, ms: Date.now() - started, voice: { wanted: narrationWanted, failed: voiceFailed } };
    }

    // ---- 4) 拼接（可缓存：画面没变就不用重拼）----
    // 被跳过的场次不再占用时间轴，成片是"保留下来的场次"按顺序拼起来。
    const timelineScenes = timeline.map((t) => t.scene);
    const totalSeconds = Number(Math.max(0.5, timelineScenes.reduce((a, s) => a + Number(s.seconds || 0), 0)
      - CFG.fade * Math.max(0, timelineScenes.length - 1)).toFixed(2));
    const durations = timelineScenes.map((s) => Number(s.seconds) || 0);
    finalPlan.totalSeconds = totalSeconds;

    report({ phase: 'concat', label: '正在拼接画面', total: totalScenes, done: totalScenes });
    // 只换声音时最值钱的一步：拼接要跑一次全片编码，几十秒的片子就是 1~3 秒白花。
    // 片段的时间戳/大小也进 key：同一场重渲（表情重试、manim 修复）产出的文件名不变，
    // 只看 basename 会把"重渲前的拼接结果"当成还能用 —— 表情就是这样被偷偷丢掉的。
    const clipStamp = (file) => {
      try {
        const st = fs.statSync(file);
        return `${path.basename(file)}:${st.size}:${Math.round(st.mtimeMs)}`;
      } catch {
        return path.basename(file);
      }
    };
    const joinedKey = P.sha1(JSON.stringify({
      clips: clips.map(clipStamp), durations, fade: CFG.fade, w: CFG.width, h: CFG.height, fps: CFG.fps,
    }));
    let joined = null;
    if (project.joined && project.joined.key === joinedKey && fs.existsSync(project.joined.file) && scope !== 'all') {
      joined = project.joined.file;
      log(`复用拼接结果 ${path.basename(joined)}`);
    } else {
      joined = path.join(cdir, `joined-${joinedKey}.mp4`);
      const cat = await R.concatClips({ ffmpeg: CFG.ffmpeg, clips, durations, out: joined, fade: CFG.fade, threads: 0 });
      if (!cat.ok) return { ok: false, error: `CONCAT_FAILED: ${(cat.error || '').slice(0, 300)}`, scenes: sceneResults, warnings, ms: Date.now() - started, voice: { wanted: narrationWanted, failed: voiceFailed } };
      project.joined = { key: joinedKey, file: joined, at: new Date().toISOString() };
    }

    // ---- 5) 旁白排位（跳过场次不占位；静音场只占画面时间）----
    const narrations = [];
    let at = 0;
    for (const item of timeline) {
      const s = item.scene;
      const sp = speeches[item.index];
      if (sp) {
        let wav = sp.wav;
        let ms = sp.ms;
        if (scope === 'audio') {
          // 只重做声音时，画面长度是既定的，旁白要自己塞进去
          const fitted = await fitNarration(wav, ms, s.seconds, work, item.index);
          wav = fitted.wav; ms = fitted.ms;
        }
        narrations.push({ file: wav, at: Math.max(0, at), ms });
      }
      at += Number(s.seconds) - CFG.fade;
    }
    guardAudioTail(narrations, totalSeconds);

    // ---- 5.5) 字幕：先按实际拼接偏移算时间轴，写 srt，再烧进画面 ----
    // 烧在"拼接后的画面"上、混音那步是 -c:v copy，所以全程只多一次编码（而且按 srt 缓存）。
    // 任何一步失败都不影响出片：subRes 为 null 时下面照旧用原 joined。
    const subRes = Subtitles
      ? await Subtitles.finish({
        project, timeline, speeches, fade: CFG.fade, cfg: CFG,
        joined, cdir, style, log,
        // 字幕烧制是全场一次，串行阶段：-threads 0 让 ffmpeg 吃满
        threads: 0,
        renderQualityLabel: Rhythm
          ? Rhythm.qualityPlan({ renderQuality: CFG.renderQuality, manimQuality: CFG.manimQuality, w: CFG.width, h: CFG.height, fps: CFG.fps }).level
          : '',
      }).catch((err) => {
        log(`字幕收尾异常（不影响出片）：${(err && err.message) || err}`);
        return null;
      })
      : null;
    if (subRes && subRes.rows && subRes.rows.length) {
      // 节奏表：每场的 旁白/场/动画 三个数差 ≤0.5s 才算"节奏对上"；
      // 最后两个数 自然/系数 用来看"动画有没有被压缩"（系数 <0.85 就是压得太狠）。
      log(`节奏表（旁白/场/动画/动画自然/系数）：${subRes.rows
        .map((r) => `#${r.index + 1} ${r.narration}/${r.scene}/${r.anim}/${r.natural}/${r.scale}`)
        .join(' | ')}`);
    }

    // 成片落在 outDir 根下（面板按 jobId 直接取 /api/studio/video?id=），
    // 项目目录里只留缓存与记录，避免两处路径含义不一致。
    const renderId = crypto.randomUUID();
    const outFile = path.join(CFG.outDir, `${renderId}.mp4`);
    report({ phase: 'mix', label: '正在混音' });
    const mixed = await R.mixAudio({
      ffmpeg: CFG.ffmpeg, videoIn: (subRes && subRes.videoIn) || joined, narrations,
      bgm: pickBgm(opts.bgm || project.bgm), totalSeconds, out: outFile, threads: 0,
    });
    if (!mixed.ok) {
      return { ok: false, error: `AUDIO_FAILED: ${(mixed.error || '').slice(0, 300)}`, scenes: sceneResults, warnings, ms: Date.now() - started, voice: { wanted: narrationWanted, failed: voiceFailed } };
    }

    const stat = fs.statSync(outFile);
    // 字幕发到成片旁边（<outDir>/<renderId>.srt），和 mp4 并列：
    // GET /v1/video/<renderId>.srt 直接下载，任务结果里也带这个路径。
    const srtOut = Subtitles && subRes && subRes.srt
      ? Subtitles.publish({ srt: subRes.srt, cfg: CFG, renderId })
      : '';
    const record = {
      renderId, file: outFile, bytes: stat.size,
      seconds: totalSeconds, at: new Date().toISOString(),
      scope, reused, rendered, ms: Date.now() - started,
      style: style.id,
      srt: srtOut,
    };
    project.renders = (project.renders || []).concat([record]).slice(-10);
    try { P.saveProject(CFG.projectDir, project); } catch { }
    log(`project ${project.id} render scope=${scope} reused=${reused} rendered=${rendered} skipped=${timelineScenes.length - rendered}`
      + ` style=${style.id} ${Math.round(stat.size / 1024)}KB ${Date.now() - started}ms`
      + `${voiceFailed.length ? ` 静音场=${voiceFailed.map((f) => f.index + 1).join(',')}` : ''}`);
    report({
      status: 'done', phase: 'done', done: totalScenes, total: totalScenes,
      label: `做好了：${totalSeconds} 秒`,
      renderId, file: outFile, seconds: totalSeconds, bytes: stat.size, ms: Date.now() - started,
    });

    const voiceSummary = { wanted: narrationWanted, ok: narrationWanted - voiceFailed.length, failed: voiceFailed, attempts: voiceFailed.reduce((a, f) => Math.max(a, Number(f.attempts) || 0), 0) };
    const base = {
      ok: true, ...record,
      plan: finalPlan,
      narrationCount: narrations.length,
      overBudget: finalPlan.overBudget || false,
      // 字幕与节奏的实测证据：srt 路径、字幕条数、每场 旁白/场/动画 三个数。
      // 面板/任务卡可以直接展示"差 ≤0.5 秒"，出问题也能一眼看出是哪一场没对上。
      subtitles: subRes ? {
        srt: srtOut || '',
        cues: Array.isArray(subRes.cues) ? subRes.cues.length : 0,
        stats: subRes.stats || {},
        burnMs: Number(subRes.burnMs) || 0,
        rows: Array.isArray(subRes.rows) ? subRes.rows : [],
      } : null,
      style: { id: style.id, name: style.name, source: styleInfo.source, reason: styleInfo.reason, personaVersion: styleInfo.personaVersion || 0 },
      scenes: sceneResults,
      warnings,
      voice: voiceSummary,
    };
    if (allVoiceFailed) {
      // 规则：全部旁白都失败 → 任务 failed 且要有明确 error。
      // 但画面已经渲完、成片已经存在，绝不删——record 里的 renderId/file/bytes 照旧返回。
      const first = voiceFailed[0] || {};
      return Object.assign({}, base, {
        ok: false,
        error: 'VOICE_UNAVAILABLE',
        speakError: first.speakError || '',
        attempts: voiceSummary.attempts,
        hint: `全部旁白都没拿到（${narrationWanted}/${narrationWanted} 场）；画面已渲完并保留成片（无声音）。修好 speak 后用 /v1/library/:id/rerun 重跑，已渲画面会复用。`,
      });
    }
    return base;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { }
  }
}
// ---------------------------------------------------------------- 任务化 ----
/**
 * 任务状态机：
 *
 *   queued ──(排队)──> running ──(prepare → voice → scenes → concat → mix)──> done
 *                         │
 *                         └──(任何没兜住的异常 / 全部旁白失败)──> failed
 *
 * 为什么要有这一层：以前 POST /v1/create 是一个长 HTTP 请求，中间任何一步抛错
 * 都等于"全错"，用户点一次只拿到 500，前面渲好的场次全白费。现在请求体先落库、
 * 立刻返回 jobId，服务端按任务跑到"至少产出一个 mp4"为止。
 *
 * 并发上限 JOB_CONCURRENCY（默认 1）：manim/ffmpeg 都是 CPU 密集型，并发只会互相拖慢；
 * speak 的 BreezeBlue Starter 档并发上限也是 1。其余任务排队，GET 里能看到 queuePosition。
 */
const JOB_CONCURRENCY = Math.max(1, Math.min(4, Number(CFG.jobConcurrency) || 1));
const JOB_KEEP = 200;
const JOBS = new Map();
const JOB_QUEUE = [];
const JOB_ACTIVE = new Set();
let jobsReady = false;

function jobFilePath(jobId) { return path.join(JOBS_DIR, `${jobId}.json`); }
function libFilePath(id) { return path.join(LIBRARY_DIR, `${id}.json`); }

function jobLog(job, msg) {
  log(`[job ${job && job.jobId}] ${msg}`);
}

function jobError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/**
 * 把提交请求的身份头固化成一个小对象存进任务里。
 *
 * 为什么要固化：任务在 HTTP 响应之后才执行，req 对象已经不可靠；而且 io 的内部通道
 * 必须带 x-dsh-user（否则 E_UNAUTHORIZED）。插件/面板会带用户身份；直接 curl 没有，
 * 就回落到 defaultUserId（默认 1）—— 至少让"服务端负责到底"在无人值守时也成立。
 */
function jobAuthContext(req) {
  const headers = {};
  const src = (req && req.headers) || {};
  if (src.authorization) headers.authorization = String(src.authorization);
  const uid = Number(src['x-dsh-user'] || process.env.DSH_USER_ID || 0);
  const fallback = Math.max(1, Number(CFG.defaultUserId) || 1);
  headers['x-dsh-user'] = String(Number.isInteger(uid) && uid > 0 ? uid : fallback);
  const sid = String(src['x-dsh-session'] || process.env.DSH_SESSION_ID || '');
  if (sid) headers['x-dsh-session'] = sid;
  return { headers };
}

function uniq(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const s = String(item == null ? '' : item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 落盘时去掉内存字段（req 是 HTTP 请求对象，序列化会炸）。 */
function jobRecord(job) {
  const rec = Object.assign({}, job);
  delete rec.req;
  delete rec._lastSave;
  delete rec._dirty;
  // _libScenes 是从配方文件读出来的视图缓存，不该跟着任务落盘（否则重启后是旧快照）
  delete rec._libScenes;
  return rec;
}

/**
 * 启动时恢复任务表。
 *
 * 关键规则：进程重启后，running/queued 的任务已经不可能继续（执行它的进程没了），
 * 一律标 failed + error='服务重启，任务中断'。不这么做它们会永远挂在 running，
 * 调用方一直轮询、用户以为还在渲。
 *
 * 已完成（done/failed）的任务原样保留 —— GET /v1/jobs/:id 重启后仍能读到结果。
 */
function ensureJobs() {
  if (jobsReady) return;
  jobsReady = true;
  try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch { }
  try { fs.mkdirSync(LIBRARY_DIR, { recursive: true }); } catch { }
  let recovered = 0;
  for (const rec of JS.listRecords(JOBS_DIR)) {
    const jobId = String(rec.jobId || rec.id || '');
    if (!JS.isSafeId(jobId)) continue;
    rec.jobId = jobId;
    if (rec.status === 'running' || rec.status === 'queued') {
      const nowIso = new Date().toISOString();
      rec.status = 'failed';
      rec.phase = 'failed';
      rec.label = '服务重启，任务中断';
      rec.error = '服务重启，任务中断';
      rec.finishedAt = nowIso;
      rec.elapsedMs = Math.max(0, Date.parse(nowIso) - Date.parse(rec.createdAt || nowIso));
      rec.scenes = (Array.isArray(rec.scenes) ? rec.scenes : []).map((s) => ({
        index: Number(s && s.index) || 0,
        engine: String((s && s.engine) || ''),
        status: s && s.status === 'ok' ? 'ok' : 'failed',
        // 中断时的 note 直接写清楚原因；"等待渲染"这种进度文案会被覆盖掉
        note: s && s.status === 'ok' ? String((s && s.note) || '') : '服务重启，任务中断',
      }));
      try { JS.writeJson(jobFilePath(jobId), rec); } catch (err) { log('恢复任务写盘失败: ' + (err && err.message || err)); }
      recovered += 1;
      // 配方状态跟着改成 failed，但 request/scenes 一个字节都不动 —— 重启后照样能重跑
      try {
        const item = JS.readJson(libFilePath(jobId), null);
        if (item && item.status !== 'done') {
          item.status = 'failed';
          item.updatedAt = nowIso;
          JS.writeJson(libFilePath(jobId), item);
        }
      } catch { }
    }
    JOBS.set(jobId, rec);
  }
  if (JOBS.size > JOB_KEEP) {
    const sorted = [...JOBS.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    JOBS.clear();
    for (const rec of sorted.slice(0, JOB_KEEP)) JOBS.set(rec.jobId, rec);
  }
  if (recovered) log(`任务恢复：${recovered} 个 running/queued 任务标记为 failed（服务重启，任务中断）`);
}

function getJob(jobId) {
  ensureJobs();
  const id = String(jobId || '');
  if (!JS.isSafeId(id)) return null;
  const mem = JOBS.get(id);
  if (mem) return mem;
  const rec = JS.readJson(jobFilePath(id), null);
  if (rec && JS.isSafeId(String(rec.jobId || id))) {
    rec.jobId = String(rec.jobId || id);
    JOBS.set(rec.jobId, rec);
    return rec;
  }
  return null;
}

function saveJob(job, force = false) {
  const now = Date.now();
  if (!force && job._lastSave && now - job._lastSave < 800) {
    job._dirty = true;
    return;
  }
  job._lastSave = now;
  job._dirty = false;
  try {
    JS.writeJson(jobFilePath(job.jobId), jobRecord(job));
  } catch (err) {
    log(`任务落盘失败 ${job.jobId}: ${err && err.message || err}`);
  }
}

/**
 * 配方落盘（library/<jobId>.json）。request 是**原封不动的提交体**，
 * scenes 是最终解析出的分镜（含 manim code / video.prompt）。
 * 任务失败也要写 —— 用户最需要重跑的正是失败的那一次。
 */
function saveLibrary(job, patch = {}, initial = false) {
  try {
    // 配方里换了分镜 → GET /v1/jobs/:id 的 hint 缓存作废，下次轮询重新读
    if (patch && Array.isArray(patch.scenes)) job._libScenes = null;
    const file = libFilePath(job.jobId);
    const prev = initial ? null : JS.readJson(file, null);
    const item = Object.assign({}, prev || {}, {
      id: job.jobId,
      jobId: job.jobId,
      createdAt: job.createdAt,
      updatedAt: new Date().toISOString(),
      title: job.title || '',
      seconds: Number(job.seconds) || 0,
      style: job.style || '',
      voice: job.voice || '',
      status: job.status || '',
      projectId: job.projectId || '',
      rerunOf: job.rerunOf || '',
      request: job.request,
      scenes: Array.isArray(prev && prev.scenes) ? prev.scenes : [],
      videoUrl: job.videoUrl || (prev && prev.videoUrl) || '',
      jobIdForVideo: job.jobIdForVideo || (prev && prev.jobIdForVideo) || '',
    }, patch || {});
    if (Array.isArray(item.scenes)) item.sceneCount = item.scenes.length;
    else item.sceneCount = Number(item.sceneCount) || 0;
    JS.writeJson(file, item);
    return item;
  } catch (err) {
    jobLog(job, '配方落盘失败: ' + (err && err.message || err));
    return null;
  }
}

function readLibrary(id) {
  if (!JS.isSafeId(String(id || ''))) return null;
  return JS.readJson(libFilePath(String(id)), null);
}

function libraryView(item, full = false) {
  const it = item || {};
  const base = {
    id: it.id || it.jobId || '',
    createdAt: it.createdAt || '',
    title: it.title || '',
    seconds: Number(it.seconds) || 0,
    sceneCount: Array.isArray(it.scenes) ? it.scenes.length : (Number(it.sceneCount) || 0),
    style: it.style || '',
    voice: it.voice || '',
    status: it.status || '',
    thumb: it.thumb || '',
    videoUrl: it.videoUrl || '',
    // 重做要按原项目复用片段缓存，列表里就带上 projectId（不必再取一次详情）
    projectId: it.projectId || '',
  };
  if (full) {
    base.request = it.request === undefined ? null : it.request;
    // 旧配方（升级前存的）里 hint 是空的：出 API 前统一回填一次，
    // 面板/插件读到的每场都有「画什么」，不会出现"有代码却一片空白"。
    base.scenes = withAutoHints(arrayOf(it.scenes));
    base.projectId = it.projectId || '';
    base.rerunOf = it.rerunOf || '';
    base.jobIdForVideo = it.jobIdForVideo || '';
    base.updatedAt = it.updatedAt || '';
  }
  return base;
}

/** 数组兜底：旧配方/坏存档里 scenes 可能是 null 或对象。 */
function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 详情/重跑时把「画什么」补齐。
 *
 * 升级前的 library 存档把 visual_hint 弄丢了（normalizeScene 的白名单里没有它），
 * 但这些条目的 request.scenes 里往往还留着用户当初填的原文。读的时候回填：
 * 面板「重做」能把上次的「画什么」显示出来，重跑也能按它判断旧代码是否过期。
 * 只补空值，不覆盖存档里已有的字段。
 */
function withRequestHints(item) {
  // 没读到这条就原样返回 null：调用方靠它走 404。以前这里兜成 {}，
  // 于是"读不存在的配方"会回 200 + 空 item（顺手修掉，和 hint 回填无关）。
  if (!item) return item;
  const it = item;
  const scenes = arrayOf(it.scenes);
  if (!scenes.length) return it;
  const reqScenes = arrayOf(it.request && it.request.scenes);
  if (!reqScenes.length) return it;
  let changed = false;
  const merged = scenes.map((s, i) => {
    const rq = reqScenes[i] || null;
    if (!s || !rq) return s;
    const patch = {};
    if (!String(s.visual_hint || '').trim() && String(rq.visual_hint || '').trim()) {
      patch.visual_hint = String(rq.visual_hint).slice(0, 600);
    }
    if (!String(s.tool || '').trim() && String(rq.tool || '').trim()) {
      patch.tool = String(rq.tool).trim().toLowerCase().slice(0, 16);
    }
    if (!patch.visual_hint && !patch.tool) return s;
    changed = true;
    return Object.assign({}, s, patch);
  });
  return changed ? Object.assign({}, it, { scenes: merged }) : it;
}

/**
 * GET /v1/jobs/:id 的 scenes 里只有引擎/状态，没有「画什么」。
 * 任务和配方用的是同一个 id，所以去配方文件里把分镜字段并进来，再对旧数据
 * （hint 空、但有 manim 代码）回填一遍 —— 插件/脚本直接读任务结果时也能看到画的是什么。
 * 轮询很频繁（1~2 秒一次），所以结果缓存在 job._libScenes 上；配方写新分镜时清掉。
 */
function jobScenesWithHints(job) {
  const list = Array.isArray(job && job.scenes) ? job.scenes : [];
  if (!list.length || !job) return list;
  let libScenes = job._libScenes;
  if (!libScenes) {
    let raw = [];
    try { raw = arrayOf((readLibrary(job.jobId) || {}).scenes); } catch { }
    libScenes = withAutoHints(raw);
    job._libScenes = libScenes;
  }
  if (!libScenes.length) return list;
  return list.map((s, i) => {
    const src = libScenes[i];
    if (!src) return s;
    return Object.assign({}, s, {
      text: String(src.text || '').slice(0, 60),
      narration: String(src.narration || '').slice(0, 200),
      seconds: Number(src.seconds) || 0,
      visual_hint: String(src.visual_hint || '').slice(0, 600),
      visualHintAuto: Boolean(src.visualHintAuto),
      // 只回"有没有代码"：把整段代码塞进每次轮询的响应里没必要。
      hasManim: Boolean(src.manim && typeof src.manim.code === 'string' && src.manim.code.trim()),
      tool: String(src.tool || ''),
      kind: String(src.kind || ''),
    });
  });
}

/** 任务对外的 JSON 形状（GET /v1/jobs 与 /v1/jobs/:id 共用）。 */
function jobView(job) {
  const created = Date.parse(job.createdAt || '') || Date.now();
  const end = job.finishedAt ? (Date.parse(job.finishedAt) || Date.now()) : Date.now();
  const queuePosition = job.status === 'queued' ? Math.max(1, JOB_QUEUE.indexOf(job.jobId) + 1) : 0;
  return {
    ok: true,
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    label: job.label,
    done: Number(job.done) || 0,
    total: Number(job.total) || 0,
    queuePosition,
    elapsedMs: Math.max(0, end - created),
    ms: Number(job.ms) || 0,
    bytes: Number(job.bytes) || 0,
    seconds: Number(job.seconds) || 0,
    reused: Number(job.reused) || 0,
    rendered: Number(job.rendered) || 0,
    videoUrl: job.videoUrl || '',
    jobIdForVideo: job.jobIdForVideo || '',
    // 字幕：路径 + 可直接下载的地址（GET /v1/video/<id>.srt）
    srt: job.srt || '',
    srtUrl: job.jobIdForVideo ? `/v1/video/${encodeURIComponent(job.jobIdForVideo)}.srt` : '',
    file: job.file || '',
    credits: Number(job.credits) || 0,
    warnings: Array.isArray(job.warnings) ? job.warnings : [],
    error: job.error || '',
    scenes: jobScenesWithHints(job),
    title: job.title || '',
    style: job.style || '',
    voice: job.voice || '',
    projectId: job.projectId || '',
    rerunOf: job.rerunOf || '',
    createdAt: job.createdAt || '',
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  };
}

/**
 * 提交一个任务：立刻落盘两份文件（jobs + library）再入队，返回 jobId。
 * 请求体原样保存 —— 这是"刷新/关闭/重启都不丢"的基础。
 */
function createJob(body, extra = {}) {
  ensureJobs();
  const request = body && typeof body === 'object' ? body : {};
  const jobId = JS.newJobId();
  const requestedMaxAi = Number(request.maxAiVideo);
  const job = {
    jobId,
    status: 'queued',
    phase: 'queued',
    label: '排队中',
    done: 0,
    total: Array.isArray(request.scenes) ? request.scenes.length : 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    ms: 0,
    bytes: 0,
    seconds: Number(request.seconds) || 0,
    videoUrl: '',
    jobIdForVideo: '',
    file: '',
    credits: 0,
    warnings: [],
    error: '',
    scenes: [],
    title: JS.deriveTitle(request),
    planTitle: '',
    style: String(request.style || ''),
    voice: request.voice == null ? '' : String(request.voice),
    maxAiVideo: Number.isFinite(requestedMaxAi) && requestedMaxAi >= 0
      ? Math.floor(requestedMaxAi)
      : Math.max(0, Number(CFG.maxAiVideo) || 0),
    request,
    projectId: String(request.projectId || request.existingProjectId || ''),
    rerunOf: String(extra.rerunOf || ''),
    scope: ['auto', 'all', 'audio'].includes(request.scope) ? request.scope : 'auto',
    cancelRequested: false,
    req: jobAuthContext(extra.req),
  };
  JOBS.set(jobId, job);
  try {
    JS.writeJson(jobFilePath(jobId), jobRecord(job));
    saveLibrary(job, { status: 'queued' }, true);
  } catch (err) {
    jobLog(job, '初始落盘失败: ' + (err && err.message || err));
  }
  JOB_QUEUE.push(jobId);
  jobLog(job, `入队（前面还有 ${Math.max(0, JOB_QUEUE.length - 1)} 个；并发上限 ${JOB_CONCURRENCY}）`);
  pumpJobs();
  return job;
}

/** 队列泵：并发没满就取下一个；完成一个立刻泵下一个。 */
function pumpJobs() {
  ensureJobs();
  while (JOB_ACTIVE.size < JOB_CONCURRENCY) {
    const jobId = JOB_QUEUE.shift();
    if (!jobId) return;
    const job = JOBS.get(jobId);
    if (!job || job.status !== 'queued') continue;
    if (job.cancelRequested) {
      failJob(job, 'CANCELLED', '已取消');
      continue;
    }
    JOB_ACTIVE.add(jobId);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.phase = 'prepare';
    job.label = '正在准备分镜';
    saveJob(job, true);
    saveLibrary(job, { status: 'running' });
    jobLog(job, '开始');
    runJob(job)
      .catch((err) => {
        // 最后一道兜底：runJob 内部已有 try/catch，这里只防"错误处理本身又抛"
        jobLog(job, '任务异常: ' + (err && err.message || err));
        failJob(job, 'JOB_CRASHED', String(err && err.message || err).slice(0, 200));
      })
      .finally(() => {
        JOB_ACTIVE.delete(jobId);
        setImmediate(() => { try { pumpJobs(); } catch { } });
      });
  }
}

function failJob(job, code, message) {
  job.status = 'failed';
  job.phase = 'failed';
  job.error = String(code || 'FAILED');
  job.label = String(message || code || '失败').slice(0, 120);
  job.finishedAt = new Date().toISOString();
  job.elapsedMs = Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.createdAt || job.finishedAt));
  job.scenes = (Array.isArray(job.scenes) ? job.scenes : []).map((s) => ({
    index: Number(s && s.index) || 0,
    engine: String((s && s.engine) || ''),
    status: s && s.status === 'ok' ? 'ok' : 'failed',
    note: String(s && s.status === 'ok' ? (s.note || '')
      : ((s.note && s.note !== '等待渲染') ? s.note : (message || code || ''))).slice(0, 300),
  }));
  saveJob(job, true);
  saveLibrary(job, { status: 'failed' });
}

/** 进度回写：每一步都更新 done/total/phase/label，前端不用自己猜。 */
function applyProgress(job, patch) {
  const p = patch || {};
  if (p.phase) job.phase = String(p.phase);
  if (p.label) job.label = String(p.label);
  if (p.total != null) job.total = Number(p.total) || job.total;
  if (p.done != null) job.done = Math.max(0, Number(p.done) || 0);
  if (p.engine) job.currentEngine = String(p.engine);
  if (p.status === 'done') { job.status = 'done'; job.phase = 'done'; }
  if (p.status === 'failed') { job.phase = 'failed'; }
  saveJob(job, false);
}

function normalizeSceneResults(list, fallback) {
  if (Array.isArray(list) && list.length) {
    return list.map((s) => ({
      index: Number(s && s.index) || 0,
      engine: String((s && s.engine) || ''),
      status: ['ok', 'degraded', 'failed'].includes(s && s.status) ? s.status : 'ok',
      note: String((s && s.note) || '').slice(0, 300),
    }));
  }
  return Array.isArray(fallback) ? fallback : [];
}

/**
 * 任务的前半段：把 prompt/script/scenes 变成"落好盘、能渲染的项目"。
 * 注意顺序：先写分镜，再渲染。分镜一写好就更新配方（library），
 * 这样即使渲染阶段崩溃，用户也能拿到"当时打算做什么"。
 */
async function prepareJob(job) {
  const body = job.request || {};
  const req = job.req;
  const reuseId = String(body.projectId || body.existingProjectId || '');
  const warnings = [];
  let title = String(body.title || '').trim();
  let project = null;
  let scenes = null;

  job.phase = 'prepare';
  job.label = '正在准备分镜';
  saveJob(job, true);

  const binding = await resolveBinding({ styleId: body.style || '' });
  const styleObj = binding.styleObject;
  if (!job.style) job.style = String((binding.style && binding.style.id) || '');
  job.voice = body.voice == null ? '' : String(body.voice);
  // fresh:true = 用户要一份新的规划，绕过两层缓存（既不读也不写，免得把"重来的结果"
  // 悄悄覆盖掉原来那份）。/v1/jobs 的请求体直接透传到这里。
  const fresh = body.fresh === true || body.fresh === 'true';
  if (fresh) jobLog(job, '收到 fresh:true —— 本次重新规划，不使用规划缓存');

  const fromScenes = Array.isArray(body.scenes) && body.scenes.length > 0;
  if (!fromScenes && reuseId) {
    // /v1/project/render 的路径：分镜已经在项目里，直接用，不要重写。
    project = P.loadProject(CFG.projectDir, reuseId);
    if (!project) throw jobError('NOT_FOUND', `项目 ${reuseId} 不存在`);
    scenes = project.scenes;
    title = title || project.title;
  } else if (fromScenes) {
    // 分镜模式：把每一场补成能渲染的场景。已经补全过的（重跑配方）直接直通，
    // 一个字段都不动 —— 连 seconds 都不重夹，缓存键才不会变。
    if (scenesLookFinal(body.scenes, styleObj)) {
      scenes = body.scenes;
      jobLog(job, '分镜已带渲染素材（manim 代码/AI prompt/文字卡），直接使用，不调用模型');
    } else {
      job.label = '正在补全分镜';
      saveJob(job, true);
      const filled = await fillScenes(body.scenes, { style: styleObj, req, maxAiVideo: job.maxAiVideo, fresh });
      if (!filled.ok) throw jobError(filled.error || 'STORYBOARD_FAILED', '分镜补全失败');
      scenes = filled.scenes;
      if (Array.isArray(filled.warnings)) warnings.push(...filled.warnings);
    }
  } else if (String(body.script || '').trim()) {
    job.label = '正在把稿子拆成分镜';
    saveJob(job, true);
    const split = await splitScript(String(body.script), {
      seconds: body.seconds, style: styleObj,
      toneLines: tonePromptLines(binding, { spoken: false }), req, fresh,
    });
    if (!split.ok) throw jobError(split.error || 'SCRIPT_SPLIT_FAILED', '稿子拆场失败');
    const filled = await fillScenes(split.scenes, { style: styleObj, req, maxAiVideo: job.maxAiVideo, fresh });
    if (!filled.ok) throw jobError(filled.error || 'STORYBOARD_FAILED', '分镜补全失败');
    scenes = filled.scenes;
    if (Array.isArray(split.warnings)) warnings.push(...split.warnings);
    if (Array.isArray(filled.warnings)) warnings.push(...filled.warnings);
  } else if (String(body.prompt || '').trim()) {
    job.label = '正在写分镜';
    saveJob(job, true);
    const two = await planTwoStage(String(body.prompt), {
      seconds: body.seconds, style: styleObj, req,
      toneLines: tonePromptLines(binding),
      stickerIds: body.stickerIds,
      maxAiVideo: job.maxAiVideo,
      fresh,
    });
    if (!two.ok) throw jobError(two.error || 'PLAN_FAILED', '写分镜失败');
    const plan = normalizePlan(two.json);
    scenes = plan.scenes;
    title = title || plan.title;
    job.planTitle = plan.title || '';
  } else {
    throw jobError('INPUT_REQUIRED', 'prompt / script / scenes 三选一');
  }

  if (!Array.isArray(scenes) || !scenes.length) throw jobError('NO_SCENES', '没有分镜');

  // 项目重跑（/v1/project/render，以及 /v1/project/patch 之后的重渲）：项目里带的是
  // **上一次生成的那份代码**。面板改标题时只改 text、代码原样带回来 —— 少了这一步，
  // 成片里写的还是旧标题（用户实测的"改了却没生效"）。只重生成戳对不上的那几场。
  // scope=audio 只重做声音，不该顺手把代码全换一遍（那会连带重渲画面）。
  if (reuseId && !fromScenes && project && job.scope !== 'audio') {
    await refreshStaleManimScenes(project, styleObj, { req, fresh, maxAiVideo: job.maxAiVideo });
  }

  // 参考图：解析成 uploads 下的绝对路径。浅拷贝一份再改，保证 library 里的 request
  // 与用户提交的一字不差（图片引用还是原来的 uploadId）。
  // 注意这里**不再**给缺戳的场次补戳：戳必须是"生成这段代码时的标题/风格"算出来的，
  // 事后补一个假的等于把过期代码钉成"有效"。缺戳一律当过期（见 manimHintMatches）。
  scenes = scenes.map((s) => Object.assign({}, s));
  attachSceneImages(scenes, warnings);
  // 落盘前普查一次表情：项目 JSON 里没有表情，渲染段再怎么修也修不出来。
  // 这一行和 renderProject 入口那一行对得上，才能断定表情"丢在落盘之前还是之后"。
  {
    const detail = scenes.map((s, i) => `S${i}:${Array.isArray(s && s.stickers) ? s.stickers.length : 0}`).join(' ');
    const total = scenes.reduce((a, s) => a + (Array.isArray(s && s.stickers) ? s.stickers.length : 0), 0);
    log(`分镜落盘：${scenes.length} 场，stickers 总数 ${total}（明细 ${detail || '无'}）`);
  }

  if (fromScenes || !reuseId) {
    // 新建或更新同一个项目。重跑时给同一个 projectId，片段缓存/旁白缓存全部复用，
    // 这就是"重跑同一配方第二次明显更快"的原因。
    const saved = saveDraftProject({
      projectId: reuseId,
      title: title || JS.deriveTitle(body),
      scenes,
      style: String(body.style || ''),
      voice: job.voice,
    });
    project = P.loadProject(CFG.projectDir, saved.id);
  }
  if (!project) throw jobError('PROJECT_MISSING', '项目没建起来');

  job.projectId = project.id;
  job.total = project.scenes.length;
  job.done = 0;
  job.title = job.title || title || JS.deriveTitle(body);
  const chars = project.scenes.reduce((a, s) => a + String(s.narration || '').length, 0);
  const planSeconds = Number(project.scenes.reduce((a, s) => a + Number(s.seconds || 0), 0).toFixed(2));
  return {
    project,
    scenes: project.scenes,
    warnings: uniq(warnings),
    credits: Math.round(chars * 0.185 * 10) / 10,
    planSeconds,
    bindingSummary: binding.summary,
    voiceName: binding.voice && binding.voice.name,
    toneLabel: binding.tone && binding.tone.label,
  };
}

/** 任务真正执行。所有分支都收敛到"要么 done、要么 failed，但已完成的片段一定保留"。 */
async function runJob(job) {
  try {
    const prepared = await prepareJob(job);
    job.projectId = prepared.project.id;
    job.total = prepared.scenes.length;
    job.done = 0;
    job.seconds = prepared.planSeconds || job.seconds;
    job.credits = prepared.credits;
    job.warnings = uniq([...job.warnings, ...prepared.warnings]);
    job.bindingSummary = prepared.bindingSummary || '';
    job.voiceName = prepared.voiceName || '';
    job.toneLabel = prepared.toneLabel || '';
    job.scenes = prepared.scenes.map((s, i) => ({
      index: i,
      engine: String((s && s.kind) || (s && s.tool) || 'text'),
      status: 'pending',
      note: '等待渲染',
    }));
    saveJob(job, true);
    saveLibrary(job, {
      scenes: prepared.scenes,
      title: job.title,
      seconds: job.seconds,
      status: 'running',
      projectId: job.projectId,
    });
    jobLog(job, `分镜就绪：${prepared.scenes.length} 场，开始渲染`);
    if (job.cancelRequested) throw jobError('CANCELLED', '已取消');

    const result = await renderProject(prepared.project, {
      voice: job.voice,
      bgm: job.request.bgm,
      style: job.request.style,
      maxAiVideo: job.maxAiVideo,
      // 项目级字幕开关（请求体 subtitles:true|false，不传则用项目/全局默认）
      subtitles: job.request.subtitles,
      // 画质档单集覆盖（high/medium/low），不传则用 config.renderQuality
      renderQuality: job.request.renderQuality,
      req: job.req,
      scope: job.scope,
      onProgress: (patch) => applyProgress(job, patch),
      shouldAbort: () => job.cancelRequested === true,
    }, job.scope);

    job.ms = Number(result.ms) || 0;
    job.reused = Number(result.reused) || 0;
    job.rendered = Number(result.rendered) || 0;
    job.warnings = uniq([...job.warnings, ...(Array.isArray(result.warnings) ? result.warnings : [])]);
    job.scenes = normalizeSceneResults(result.scenes, job.scenes);
    if (result.renderId) {
      // 成片已经产出来了：不管 ok 与否都记下位置，失败也不能丢（规则 3）。
      job.jobIdForVideo = String(result.renderId);
      job.videoUrl = `/api/studio/video?id=${encodeURIComponent(result.renderId)}`;
      job.file = String(result.file || '');
      // 字幕文件（<outDir>/<renderId>.srt）：任务结果里带上路径，取片/取字幕用同一个 id
      job.srt = String(result.srt || '');
      job.bytes = Number(result.bytes) || 0;
      job.seconds = Number(result.seconds) || job.seconds;
    }
    if (result.ok) {
      job.status = 'done';
      job.phase = 'done';
      job.label = `做好了：${job.seconds} 秒`;
      job.done = job.total;
      job.error = '';
    } else {
      job.status = 'failed';
      job.phase = 'failed';
      job.error = String(result.error || 'RENDER_FAILED');
      job.label = job.error === 'VOICE_UNAVAILABLE'
        ? '全部旁白失败（成片已保留，无声音）'
        : `渲染失败：${job.error}`;
      if (result.hint) job.warnings = uniq([...job.warnings, String(result.hint)]);
      // 把失败原因写进每一场没成功的 note 里
      const reason = String(result.error || 'failed');
      job.scenes = job.scenes.map((s) => (
        s.status === 'ok' ? s : Object.assign({}, s, { status: 'failed', note: s.note || reason })
      ));
      if (job.cancelRequested) job.error = 'CANCELLED';
    }
  } catch (err) {
    const code = String((err && err.code) || 'JOB_FAILED');
    const message = String((err && err.message) || err).slice(0, 240);
    job.status = 'failed';
    job.phase = 'failed';
    job.error = job.cancelRequested ? 'CANCELLED' : code;
    job.label = job.cancelRequested ? '已取消' : `失败：${message}`;
    // 没兜住的异常：已完成场次的 note 保留，其余写失败原因；**绝不删已渲好的 mp4**。
    job.scenes = (Array.isArray(job.scenes) ? job.scenes : []).map((s) => (
      s.status === 'ok' ? s : Object.assign({}, s, {
        status: 'failed',
        note: (s.note && s.note !== '等待渲染') ? s.note : message,
      })
    ));
    // 项目里最后一次成功的 render 也认：异常发生在返程路上时，成片其实已经存在。
    try {
      const p = job.projectId ? P.loadProject(CFG.projectDir, job.projectId) : null;
      const last = p && Array.isArray(p.renders) ? p.renders[p.renders.length - 1] : null;
      if (last && last.file && fs.existsSync(last.file)) {
        job.jobIdForVideo = job.jobIdForVideo || String(last.renderId || '');
        job.videoUrl = job.videoUrl || (job.jobIdForVideo ? `/api/studio/video?id=${encodeURIComponent(job.jobIdForVideo)}` : '');
        job.file = job.file || String(last.file);
        job.bytes = job.bytes || Number(last.bytes) || 0;
        job.seconds = job.seconds || Number(last.seconds) || 0;
      }
    } catch { }
    jobLog(job, `任务失败 ${job.error}: ${message}`);
  } finally {
    job.finishedAt = new Date().toISOString();
    job.elapsedMs = Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.createdAt || job.finishedAt));
    saveJob(job, true);
    saveLibrary(job, { status: job.status, seconds: job.seconds, videoUrl: job.videoUrl, jobIdForVideo: job.jobIdForVideo });
    jobLog(job, `结束 status=${job.status}${job.error ? ` error=${job.error}` : ''}`
      + ` done=${job.done}/${job.total} ${(job.elapsedMs / 1000).toFixed(1)}s`);
  }
}

/** 兼容旧接口（/v1/create、/v1/project/render）：等任务结束再按老形状返回。 */
function waitJob(jobId, timeoutMs = 30 * 60 * 1000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const job = getJob(jobId);
      if (!job) return resolve(null);
      if (job.status === 'done' || job.status === 'failed') return resolve(job);
      if (Date.now() - started > timeoutMs) return resolve(job);
      setTimeout(tick, 500);
    };
    tick();
  });
}

/** 取片：支持 Range，浏览器/播放器可以直接播。 */
function serveVideo(req, res, file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { return json(res, 404, { ok: false, error: 'NOT_FOUND' }); }
  const total = stat.size;
  const range = String(req.headers.range || '');
  const m = range.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': 'video/mp4',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'content-length': String(total),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  return fs.createReadStream(file).pipe(res);
}


/**
 * 调 io 的身份头。
 * 面板直连时带用户 token；插件（在 DSH 进程里，只有服务身份）调过来时没有 token，
 * 就用内部令牌 + 它传的 x-dsh-user —— 否则 make_plan/make_video 必然 E_UNAUTHORIZED。
 */
function ioAuthHeaders(req, userId) {
  const headers = { authorization: String((req && req.headers && req.headers.authorization) || '') };
  if (CFG.internalToken) {
    headers['x-dsh-internal'] = CFG.internalToken;
    const uid = Number((req && req.headers && req.headers['x-dsh-user']) || userId || 0);
    if (Number.isInteger(uid) && uid > 0) headers['x-dsh-user'] = String(uid);
  }
  return headers;
}

// ------------------------------------------------------------------ routes --

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    // ------------------------------------------------------------ 任务（job） ---
    // 一次提交 = 一个任务；服务端负责跑到出片。POST /v1/jobs 立刻返回 jobId（<1s），
    // 实际工作在后台；状态与配方都落盘（jobs/ 与 library/），重启不丢。
    if (req.method === 'POST' && p === '/v1/jobs') {
      const body = JSON.parse(await readBody(req) || '{}');
      const hasInput = Boolean(String(body.prompt || '').trim() || String(body.script || '').trim()
        || (Array.isArray(body.scenes) && body.scenes.length));
      if (!hasInput) {
        return json(res, 400, { ok: false, error: 'INPUT_REQUIRED', message: 'prompt / script / scenes 三选一' });
      }
      const job = createJob(body, { req });
      return json(res, 202, {
        ok: true,
        jobId: job.jobId,
        status: job.status,
        queuePosition: job.status === 'queued' ? Math.max(1, JOB_QUEUE.indexOf(job.jobId) + 1) : 0,
      });
    }

    // 最近 20 个任务（含进度、成片地址、每场状态）。
    if (req.method === 'GET' && p === '/v1/jobs') {
      ensureJobs();
      const jobs = [...JOBS.values()]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, 20)
        .map(jobView);
      return json(res, 200, { ok: true, jobs });
    }

    if (p.startsWith('/v1/jobs/')) {
      const rest = p.slice('/v1/jobs/'.length);
      const isCancel = rest.endsWith('/cancel');
      const id = decodeURIComponent(isCancel ? rest.slice(0, -'/cancel'.length) : rest);
      if (isCancel && req.method === 'POST') {
        const job = getJob(id);
        if (!job) return json(res, 404, { ok: false, error: 'JOB_NOT_FOUND' });
        if (job.status === 'queued') {
          const at = JOB_QUEUE.indexOf(job.jobId);
          if (at >= 0) JOB_QUEUE.splice(at, 1);
          failJob(job, 'CANCELLED', '已取消');
        } else if (job.status === 'running') {
          // 不硬杀 ffmpeg/manim：只打个标记，渲染层在下一场开始前停，已完成片段全保留。
          job.cancelRequested = true;
          job.label = '正在取消（等这一场渲完）';
          saveJob(job, true);
          jobLog(job, '收到取消请求，将在这一场结束时停止');
        }
        return json(res, 200, { ok: true, jobId: job.jobId, status: job.status });
      }
      if (!isCancel && req.method === 'GET') {
        const job = getJob(id);
        if (!job) return json(res, 404, { ok: false, error: 'JOB_NOT_FOUND' });
        return json(res, 200, jobView(job));
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    // ------------------------------------------------------------ 规划缓存（观测） ---
    // 只读统计：条目数、字节数、两层各自命中率（进程内计数，重启归零）。
    if (req.method === 'GET' && p === '/v1/plan-cache/stats') {
      return json(res, 200, planCache.stats());
    }

    // 清空两层缓存。要日志 —— 用户点"清空"之后至少能解释"为什么又变慢了"。
    if (req.method === 'DELETE' && p === '/v1/plan-cache') {
      const out = planCache.clear();
      log(`规划缓存已清空：删除 ${out.removed} 条（场级 ${out.scenes || 0}，骨架 ${out.skeletons || 0}），释放 ${out.bytes} 字节`);
      return json(res, 200, { ok: true, removed: out.removed, scenes: out.scenes || 0, skeletons: out.skeletons || 0, bytes: out.bytes });
    }

    // 直接取片：/v1/video?id=<renderId>，支持 Range（播放器能拖进度条）。
    if (req.method === 'GET' && p === '/v1/video') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return json(res, 400, { ok: false, error: 'BAD_ID' });
      const file = path.join(CFG.outDir, `${id}.mp4`);
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
      return serveVideo(req, res, file);
    }

    // 取字幕：/v1/video/<renderId>.srt（和 mp4 同一个 id，成片旁边那份 srt 直接下发）。
    // 也接受 /v1/video.srt?id=... 的形式，脚本/老面板不用改。
    if (req.method === 'GET' && /^\/v1\/video(\/|\.srt)/.test(p) && /\.srt$/i.test(p)) {
      let wantId = '';
      if (p.startsWith('/v1/video/')) wantId = decodeURIComponent(p.slice('/v1/video/'.length).replace(/\.srt$/i, ''));
      if (!wantId) wantId = String(url.searchParams.get('id') || '');
      if (!/^[0-9a-fA-F-]{8,64}$/.test(wantId)) return json(res, 400, { ok: false, error: 'BAD_ID' });
      let file = path.join(CFG.outDir, `${wantId}.srt`);
      if (!fs.existsSync(file)) {
        // 兜底：去任务记录里找当初落盘的 srt 路径（改过 outDir / 手清过目录时还能取到）
        const job = [...JOBS.values()].find((j) => j && j.srt && String(j.jobIdForVideo || '') === wantId);
        if (job && fs.existsSync(job.srt)) file = String(job.srt);
      }
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'application/x-subrip; charset=utf-8',
        'content-length': String(body.length),
        'content-disposition': `attachment; filename="${wantId}.srt"`,
        'cache-control': 'no-store',
      });
      return res.end(body);
    }

    // ------------------------------------------------------------ 配方库（library） ---
    // 每次提交的原样请求 + 最终分镜。刷新/关页面/重启服务都还在，可以一键重跑。
    if (req.method === 'GET' && p === '/v1/library') {
      ensureJobs();
      const items = JS.listRecords(LIBRARY_DIR).slice(0, 50).map((it) => libraryView(it, false));
      return json(res, 200, { ok: true, items });
    }

    if (p.startsWith('/v1/library/')) {
      const rest = p.slice('/v1/library/'.length);
      const isRerun = rest.endsWith('/rerun');
      const id = decodeURIComponent(isRerun ? rest.slice(0, -'/rerun'.length) : rest);
      if (isRerun && req.method === 'POST') {
        // 旧配方（hint 空、有代码）读出来先补齐「画什么」再提交：
        // 新任务的存档、面板重做时都能看到这一场画的是什么。
        const item = withAutoHints(withRequestHints(readLibrary(id)));
        if (!item) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
        // 用保存的 request + 最终 scenes 重新提交：场景都带着 manim 代码/video.prompt，
        // prepare 不会再问模型；projectId 沿用，片段缓存与旁白缓存全部命中。
        const request = Object.assign({}, item.request || {});
        const scenes = Array.isArray(item.scenes) ? item.scenes : [];
        if (scenes.length) request.scenes = scenes;
        if (item.projectId) request.projectId = item.projectId;
        if (item.title && !request.title) request.title = item.title;
        const job = createJob(request, { req, rerunOf: id });
        log(`配方 ${id} 重跑 -> 新任务 ${job.jobId}（项目 ${item.projectId || '(新)'}，${scenes.length} 场）`);
        return json(res, 202, { ok: true, jobId: job.jobId });
      }
      if (!isRerun && req.method === 'GET') {
        const item = withRequestHints(readLibrary(id));
        if (!item) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
        return json(res, 200, { ok: true, item: libraryView(item, true) });
      }
      if (!isRerun && req.method === 'DELETE') {
        if (!JS.isSafeId(id)) return json(res, 400, { ok: false, error: 'BAD_ID' });
        const removed = JS.removeJson(libFilePath(id));
        return json(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: 'NOT_FOUND' });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    // ---------------------------------------------------- 项目（长片） ---
    // 项目 = 分镜 + 分段缓存。AI 每次只发改动（patch），不用重发整份分镜；
    // 渲染时能复用的片段直接复用，所以"改一场"只花一场的时间。
    if (req.method === 'POST' && p === '/v1/project') {
      const body = JSON.parse(await readBody(req) || '{}');
      // 带 id 且项目存在 = 原地更新（面板反复"补全 → 改 → 渲染"时，
      // 不要每次生成一个新项目，否则项目列表里全是半成品）。
      let project = body.id ? P.loadProject(CFG.projectDir, String(body.id)) : null;
      if (project) {
        if (body.title) project.title = String(body.title).slice(0, 80);
        if (body.width) project.width = Number(body.width) || project.width;
        if (body.height) project.height = Number(body.height) || project.height;
        if (body.fps) project.fps = Number(body.fps) || project.fps;
        if (body.fade != null) project.fade = Number(body.fade);
        if (body.voice != null) project.voice = String(body.voice);
        if (body.bgm != null) project.bgm = String(body.bgm);
        if (body.style != null) project.style = String(body.style);
        if (body.scenes) project.scenes = [];
      } else {
        project = P.createProject(CFG.projectDir, {
          title: body.title || '未命名项目',
          width: Number(body.width) || CFG.width,
          height: Number(body.height) || CFG.height,
          fps: Number(body.fps) || CFG.fps,
          fade: body.fade == null ? CFG.fade : Number(body.fade),
          voice: body.voice || '',
          bgm: body.bgm || '',
          // 空字符串 = 渲染时按人设自动选；写了就是钉死这个风格
          style: body.style || '',
          textEdgeFade: body.textEdgeFade == null ? null : Number(body.textEdgeFade),
        });
      }
      if (Array.isArray(body.scenes) && body.scenes.length) {
        project.scenes = body.scenes.slice(0, CFG.maxScenes)
          .map((s, i) => P.normalizeScene(s, { label: `scene#${i}`, onDegrade: log }));
      }
      P.saveProject(CFG.projectDir, project);
      log(`project saved ${project.id} scenes=${project.scenes.length}`);
      return json(res, 200, { ok: true, project });
    }

    if (req.method === 'GET' && p === '/v1/project/list') {
      return json(res, 200, { ok: true, projects: P.listProjects(CFG.projectDir) });
    }

    if (req.method === 'GET' && p === '/v1/project') {
      const id = String(url.searchParams.get('id') || '');
      const project = P.loadProject(CFG.projectDir, id);
      if (!project) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
      return json(res, 200, { ok: true, project });
    }

    // 增量修改：patches 里每项 {op:'patch'|'insert'|'delete', index, patch|scene}
    if (req.method === 'POST' && p === '/v1/project/patch') {
      const body = JSON.parse(await readBody(req) || '{}');
      const project = P.loadProject(CFG.projectDir, String(body.id || ''));
      if (!project) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
      const touched = P.applyPatches(project, body.patches || body.patch || [], { onDegrade: log });
      if (project.scenes.length > CFG.maxScenes) project.scenes = project.scenes.slice(0, CFG.maxScenes);
      P.saveProject(CFG.projectDir, project);
      // 告诉调用方"这次会重渲几场"，让 AI 能解释为什么快/慢。
      // 风格也得算进去：换了风格，所有场的缓存键都会变。
      const st = await resolveStyleFor({ styleId: project.style });
      const preview = P.planReuse(project, styleCfg(st.style));
      log(`project ${project.id} patched touched=${touched.length} rebuild=${preview.rebuild.length}`);
      return json(res, 200, {
        ok: true,
        touched,
        scenes: project.scenes.length,
        willRebuild: preview.rebuild.map((b) => b.index),
        willReuse: preview.reuse.map((r) => r.index),
      });
    }

    if (req.method === 'POST' && p === '/v1/project/render') {
      const body = JSON.parse(await readBody(req) || '{}');
      const project = P.loadProject(CFG.projectDir, String(body.id || ''));
      if (!project) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
      // 项目文件可能被手改过、或是老版本留下的：渲染前再查一次"标了 aivideo 却没 prompt"。
      // normalizeScene 在保存时已经降级过一次，这里兜住绕过保存直接改文件的情况。
      for (let i = 0; i < project.scenes.length; i++) {
        const s = project.scenes[i];
        const wantsAi = String(s.kind || '') === 'aivideo' || String(s.tool || '') === 'aivideo';
        if (wantsAi && !isAiVideoScene(s)) log(`scene#${i} 是 aivideo 但没有 video.prompt，降级文字卡（渲染前检查）`);
      }
      const scope = ['auto', 'all', 'audio'].includes(body.scope) ? body.scope : 'auto';
      // 显式 style 会**写回项目**：调用方说"这集用 blueprint"就该记住，
      // 而不是下次渲染又悄悄变回人设的决定。
      if (body.style) {
        project.style = String(body.style);
        P.saveProject(CFG.projectDir, project);
      }
      const st = await resolveStyleFor({ styleId: project.style });
      if (scope === 'audio' && project.scenes.some((s) => !project.cache[P.sceneKey(s, styleCfg(st.style))])) {
        // 还有场次没渲过，没法只做声音 —— 明确报错，别偷偷改成全量
        return json(res, 409, { ok: false, error: 'CLIPS_MISSING', hint: '先 scope=auto 渲一次画面，再单独重做声音' });
      }
      // 内部改成走任务：接口仍然同步返回（面板/插件不用改），但执行路径是任务，
      // 中途失败会走自愈，进度/成片/失败原因都落盘。
      const job = createJob({
        existingProjectId: project.id,
        projectId: project.id,
        title: project.title,
        scope,
        style: project.style,
        voice: body.voice || project.voice,
        bgm: body.bgm || project.bgm,
      }, { req });
      log(`/v1/project/render -> job ${job.jobId}（project ${project.id} scope=${scope}）`);
      const done = await waitJob(job.jobId);
      if (!done) return json(res, 500, { ok: false, error: 'JOB_LOST' });
      const ok = done.status === 'done';
      const result = {
        ok,
        renderId: done.jobIdForVideo || '',
        jobId: done.jobId,
        file: done.file || '',
        bytes: Number(done.bytes) || 0,
        seconds: Number(done.seconds) || 0,
        reused: Number(done.reused) || 0,
        rendered: Number(done.rendered) || 0,
        ms: Number(done.ms) || 0,
        error: done.error || '',
        warnings: done.warnings || [],
        scenes: done.scenes || [],
      };
      return json(res, ok ? 200 : renderErrorStatus(result), result);
    }

    // ---------------------------------------------------------- 风格预设 ---
    // 风格 = 一份 JSON（配色/线宽/字体/节奏）。渲染时机械地套到 manim 脚本和文字卡上。
    if (req.method === 'GET' && p === '/v1/styles') {
      const idx = S.loadStyles(STYLE_DIR);
      return json(res, 200, {
        ok: true,
        styles: idx.list.map((s) => ({
          id: s.id, name: s.name, bg: s.bg, fg: s.fg, accent: s.accent,
          muted: s.muted, accent2: s.accent2, line_width: s.line_width,
          font: s.font, motion: s.motion, camera: s.camera, glow: s.glow,
          notes: s.notes, source: s.source,
        })),
        errors: idx.errors,
      });
    }
    if (req.method === 'GET' && p.startsWith('/v1/styles/')) {
      const id = decodeURIComponent(p.slice('/v1/styles/'.length));
      const s = S.getStyle(STYLE_DIR, id);
      if (!s) return json(res, 404, { ok: false, error: 'STYLE_NOT_FOUND', id });
      return json(res, 200, { ok: true, style: s });
    }
    // 当前生效风格 + 为什么是它（人设关键词 / 显式指定 / 默认）
    if (req.method === 'GET' && p === '/v1/style') {
      const info = await resolveStyleFor({ styleId: url.searchParams.get('style') || '' });
      return json(res, 200, {
        ok: true,
        id: info.id,
        name: info.style.name,
        reason: info.reason,
        source: info.source,
        personaVersion: info.personaVersion || 0,
        stale: Boolean(info.stale),
        style: info.style,
      });
    }

    // -------------------------------------------------- 人设联动（绑定） ---
    // 面板上那行"当前：大肥鱼（迷糊版）· 白板讲解 · 温柔口语"就是它。
    // 音色由 speak 决定、风格由人设关键词映射、语气由人设正文抽 —— 三处各有来源，
    // 这里合成一个解释，用户才知道"为什么这集是这个声音和样子"。
    if (req.method === 'GET' && p === '/v1/persona-binding') {
      const binding = await resolveBinding({ styleId: url.searchParams.get('style') || '' });
      return json(res, 200, {
        ok: true,
        persona: binding.persona,
        voice: binding.voice,
        style: binding.style,
        tone: binding.tone,
        summary: binding.summary,
      });
    }

    // 渲染进度：长请求的旁路信息，面板每 1~2 秒问一次。
    if (req.method === 'GET' && p === '/v1/project/progress') {
      const id = String(url.searchParams.get('id') || '');
      if (!id) return json(res, 400, { ok: false, error: 'ID_REQUIRED' });
      const rec = progressGet(id);
      if (!rec) return json(res, 200, { ok: true, id, status: 'idle' });
      return json(res, 200, Object.assign({ ok: true }, rec));
    }

    // ------------------------------------------------ 创作入口 A：写稿 ---
    // 稿子 → 分镜。只拆场，不渲染、不写 manim 代码：用户下一步要改标题和秒数，
    // 先花几十秒写代码是浪费。
    if (req.method === 'POST' && p === '/v1/storyboard/from-script') {
      const body = JSON.parse(await readBody(req) || '{}');
      const script = String(body.script || '').trim();
      if (!script) return json(res, 400, { ok: false, error: 'SCRIPT_REQUIRED' });
      const binding = await resolveBinding({ styleId: body.style || '' });
      const r = await splitScript(script, {
        seconds: body.seconds,
        style: binding.styleObject,
        toneLines: tonePromptLines(binding, { spoken: false }),
        req,
        // fresh:true = 重新拆一遍，不吃骨架缓存（用户嫌上一版拆得不好时用）
        fresh: body.fresh === true || body.fresh === 'true',
      });
      if (!r.ok) return json(res, 200, { ok: false, step: 'storyboard', error: r.error, raw: r.raw });
      const saved = saveDraftProject({
        projectId: body.projectId,
        title: r.title,
        // 全量存：visual_hint / tool 也要落进项目，否则重做时「画什么」是空的
        scenes: r.scenes.map((s) => ({
          text: s.text, narration: s.narration, seconds: s.seconds,
          visual_hint: s.visual_hint || '', tool: s.tool || '',
        })),
        style: body.style || '',
        voice: body.voice || '',
      });
      log(`from-script ok：${r.scenes.length} 场，项目 ${saved.id}`);
      return json(res, 200, {
        ok: true,
        project: saved,
        title: r.title,
        scenes: r.scenes,
        warnings: r.warnings,
        estimate: estimateRender(r.scenes),
        style: binding.style,
        voice: binding.voice,
        tone: binding.tone,
        bindingSummary: binding.summary,
      });
    }

    // ------------------------------------------------ 创作入口 B：分镜 ---
    // 用户自己填的每一场 → 补引擎与 manim 代码。visual_hint 是这一轮的主角：
    // 它被当成"最高优先级的画面要求"喂给写脚本的模型。
    if (req.method === 'POST' && p === '/v1/storyboard/from-scenes') {
      const body = JSON.parse(await readBody(req) || '{}');
      const list = Array.isArray(body.scenes) ? body.scenes.slice(0, CFG.maxScenes) : [];
      if (!list.length) return json(res, 400, { ok: false, error: 'SCENES_REQUIRED' });
      const binding = await resolveBinding({ styleId: body.style || '' });
      const r = await fillScenes(list, {
        style: binding.styleObject,
        req,
        fresh: body.fresh === true || body.fresh === 'true',
      });
      if (!r.ok) return json(res, 200, { ok: false, step: 'storyboard', error: r.error, raw: r.raw });
      const title = String(body.title || (list.find((s) => s && s.text) || {}).text || '未命名').slice(0, 60);
      const saved = saveDraftProject({
        projectId: body.projectId,
        title,
        // 分镜补全的结果整份落盘（visual_hint / stickers / image / tool / kind / manim
        // 一个都不许在“存项目”这一步悄悄丢掉 —— 重做时全靠它们还原上次的画面）。
        scenes: r.scenes,
        style: body.style || '',
        voice: body.voice || '',
      });
      log(`from-scenes ok：${r.scenes.length} 场，manim ${r.stats.manim} 场，项目 ${saved.id}`);
      return json(res, 200, {
        ok: true,
        project: saved,
        title,
        scenes: r.scenes,
        stats: r.stats,
        warnings: r.warnings,
        estimate: estimateRender(r.scenes),
        style: binding.style,
        voice: binding.voice,
        tone: binding.tone,
        bindingSummary: binding.summary,
      });
    }

    // ---------------------------------------------------- 一次性渲染 ---
    if (req.method === 'GET' && p === '/v1/health') {
      // 注意：健康检查不查人设/不跑 manim —— 面板会高频轮询，这里必须便宜。
      let styleCount = 0;
      try { styleCount = S.loadStyles(STYLE_DIR).list.length; } catch { }
      return json(res, 200, {
        ok: true,
        width: CFG.width,
        height: CFG.height,
        fps: CFG.fps,
        ffmpeg: fs.existsSync(CFG.ffmpeg),
        font: fs.existsSync(CFG.font),
        manim: Boolean(Manim) && fs.existsSync(CFG.python),
        styles: styleCount,
        defaultStyle: CFG.defaultStyle,
        textEdgeFade: CFG.textEdgeFade,
        maxScenes: CFG.maxScenes,
        maxTotalSeconds: CFG.maxTotalSeconds,
        // AI 画面：模块在不在、密钥有没有（只说"有没有"，绝不回显密钥）、一集上限
        wan: Boolean(Wan),
        wanKey: Boolean(wanKeyInfo().key),
        maxAiVideo: Math.max(0, Number(CFG.maxAiVideo) || 0),
      });
    }

    // ------------------------------------------- 独立生成一段 AI 视频 ---
    // 插件 gen_video 走这里：给一句画面描述，等 ~100 秒，拿回一个 mp4。
    // 不走分镜、不建项目，就是"给我一段画面"。
    // 密钥由 studio 从 secrets 读（插件运行在 DSH 进程里，不碰 key、也不该知道在哪）。
    if (req.method === 'POST' && p === '/v1/aivideo') {
      const body = JSON.parse(await readBody(req) || '{}');
      const prompt = normalizeAiPrompt(body.prompt);
      if (!prompt) return json(res, 400, { ok: false, error: 'PROMPT_REQUIRED' });
      if (!Wan) return json(res, 503, { ok: false, error: 'WAN_MODULE_MISSING' });
      const keyInfo = wanKeyInfo();
      if (!keyInfo.key) {
        return json(res, 503, {
          ok: false, error: 'WAN_KEY_MISSING',
          hint: '把 key 放到 config.wanKeyPath 指的文件（默认 secrets\\wan.key），或沿用 secrets\\qwen.key / video\\secrets.json',
        });
      }
      const id = crypto.randomUUID().slice(0, 8);
      const aiDir = path.join(CFG.outDir, 'aivideo');
      const work = path.join(aiDir, `w-${id}`);
      fs.mkdirSync(aiDir, { recursive: true });
      log(`/v1/aivideo 开始：prompt=${prompt.slice(0, 60)}…（密钥来自 ${path.basename(keyInfo.source)}）`);
      const clip = await Wan.generateClip({
        key: keyInfo.key,
        prompt,
        seconds: body.seconds,
        size: body.size,
        work,
        index: id,
        timeoutMs: CFG.wanTimeoutMs,
        ffmpeg: CFG.ffmpeg,
      });
      if (!clip.ok) {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { }
        log(`/v1/aivideo 失败：${String(clip.error).slice(0, 240)}`);
        return json(res, 502, { ok: false, error: clip.error, taskId: clip.taskId || '', ms: clip.ms || 0 });
      }
      const outFile = path.join(aiDir, `ai-${id}.mp4`);
      try {
        fs.copyFileSync(clip.file, outFile);
      } catch (err) {
        log(`/v1/aivideo 落盘失败：${err && err.message || err}`);
        return json(res, 500, { ok: false, error: `COPY_FAILED: ${err && err.message || err}` });
      }
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { }
      let bytes = clip.bytes;
      try { bytes = fs.statSync(outFile).size; } catch { }
      log(`/v1/aivideo ok ${Math.round(bytes / 1024)}KB ${clip.ms}ms task=${clip.taskId}（${clip.width}x${clip.height} ${clip.duration}s）`);
      return json(res, 200, {
        ok: true,
        path: outFile,
        file: outFile,
        taskId: clip.taskId,
        ms: clip.ms,
        bytes,
        seconds: clip.duration,
        width: clip.width,
        height: clip.height,
        prompt,
        size: clip.size,
      });
    }

    // 只出分镜，不渲染（方便先看分镜再决定渲不渲）
    if (req.method === 'POST' && p === '/v1/plan') {
      const body = JSON.parse(await readBody(req) || '{}');
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'PROMPT_REQUIRED' });
      // 人设决定风格，也决定旁白的口气；一次拿齐，避免风格与语气来自两次不同的人设读
      const binding = await resolveBinding({ styleId: body.style || '' });
      const styleInfo = binding.styleInfo;
      const two = await planTwoStage(prompt, {
        seconds: body.seconds, req, style: styleInfo.style,
        toneLines: tonePromptLines(binding),
        stickerIds: Array.isArray(body.stickerIds) ? body.stickerIds : undefined,
        fresh: body.fresh === true || body.fresh === 'true',
      });
      if (!two.ok) return json(res, 200, { ok: false, step: 'plan', error: two.error, raw: two.raw });
      const plan = normalizePlan(two.json);
      return json(res, 200, {
        ok: true, plan, visuals: two.visuals, manimRatio: two.manimRatio,
        estimate: estimateRender(plan.scenes),
        style: { id: styleInfo.id, name: styleInfo.style.name, reason: styleInfo.reason, source: styleInfo.source },
        voice: binding.voice,
        tone: binding.tone,
        bindingSummary: binding.summary,
      });
    }

    if (req.method === 'POST' && p === '/v1/render') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.plan || !Array.isArray(body.plan.scenes)) return json(res, 400, { ok: false, error: 'PLAN_REQUIRED' });
      const plan = normalizePlan(body.plan);
      const result = await renderPlan(plan, { voice: body.voice, bgm: body.bgm, style: body.style || '' });
      log(`render ok=${result.ok} ${result.ok ? `bytes=${result.bytes} ms=${result.ms}` : result.error}`);
      return json(res, result.ok ? 200 : renderErrorStatus(result), Object.assign({ plan }, result));
    }

    // 一步到底：写分镜 + 渲染。规划统一走两段式（和 /v1/plan 同一套提示词），
    // 否则"两条路各有一套提示词"迟早会走偏 —— 之前那条 rich/draw 的路就是这么来的。
    if (req.method === 'POST' && p === '/v1/create') {
      const body = JSON.parse(await readBody(req) || '{}');
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'PROMPT_REQUIRED' });
      // 内部走任务（和 POST /v1/jobs 同一条管道），但保持旧的同步返回形状：
      // 插件 make_video 和面板都还在按老契约读 jobId/plan/bytes。
      const job = createJob({
        prompt,
        seconds: body.seconds,
        style: body.style || '',
        voice: body.voice,
        bgm: body.bgm,
        fresh: body.fresh === true || body.fresh === 'true',
        stickerIds: withPlanHints(body, await stickerHints()).stickerIds,
      }, { req });
      log(`/v1/create -> job ${job.jobId}（prompt=${prompt.slice(0, 40)}）`);
      const done = await waitJob(job.jobId);
      if (!done) return json(res, 500, { ok: false, error: 'JOB_LOST' });
      const project = done.projectId ? P.loadProject(CFG.projectDir, done.projectId) : null;
      const scenes = project ? project.scenes : [];
      const plan = {
        title: done.title || (project && project.title) || '',
        scenes,
        totalSeconds: Number(done.seconds) || 0,
      };
      const binding = await resolveBinding({ styleId: done.style || body.style || '' });
      const ok = done.status === 'done';
      const result = {
        ok,
        file: done.file || '',
        jobId: done.jobIdForVideo || '',
        taskJobId: done.jobId,
        bytes: Number(done.bytes) || 0,
        seconds: Number(done.seconds) || 0,
        ms: Number(done.ms) || 0,
        narrationCount: scenes.filter((s) => s && s.narration).length,
        warnings: done.warnings || [],
        scenes: done.scenes || [],
        error: done.error || '',
        plan,
        estimate: estimateRender(scenes),
      };
      log(`create ok=${ok} scenes=${scenes.length} style=${done.style} ${ok ? `bytes=${result.bytes} ms=${result.ms}` : result.error}`);
      return json(res, ok ? 200 : renderErrorStatus(result), Object.assign({
        voice: binding.voice,
        tone: binding.tone,
        bindingSummary: binding.summary,
        style: done.style ? { id: done.style } : undefined,
      }, result));
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

/**
 * 启动服务。抽成函数是为了让 require('./server.js') 不产生副作用
 * （测试脚本要 import planWithNarration，不能在 import 时就把 8772 占了）。
 * 直接 `node server.js` 时 require.main === module，照旧起服务，启动命令不用改。
 */
function start() {
  try { fs.mkdirSync(CFG.bgmDir, { recursive: true }); } catch (err) { log('bgmDir 创建失败: ' + (err && err.message || err)); }
  // 任务恢复必须赶在 listen 之前：先把上次残留的 running 标 failed，
  // 再开始接新请求，避免外面轮询到永远跑不完的旧任务。
  ensureJobs();
  server.listen(CFG.port, HOST, () => {
    log(`studio on http://${HOST}:${CFG.port}  ${CFG.width}x${CFG.height}@${CFG.fps}  ffmpeg=${fs.existsSync(CFG.ffmpeg)}  bgmDir=${CFG.bgmDir}`);
  });
}

if (require.main === module) start();

// 只导出纯逻辑与被复用的实现，供本地验证脚本直接调用
module.exports = {
  planWithNarration, wavDurationMs, parseWav, measureAudioMs, padWavToSeconds, guardAudioTail,
  normalizePlan, renderPlan, renderProject, start, server, CFG, P, S, JS,
  sceneEngines, resolveStyleFor, styleCfg,
  buildSkeletonPrompt, buildVisualPrompt, buildScriptSplitPrompt, buildAiVideoPrompt,
  // AI 画面（wan3.0-video）：配额是纯函数，单测直接调；wanKeyInfo 只回来源不回密钥
  planAiVideoQuota, isAiVideoScene, normalizeAiPrompt, wanKeyInfo, fitAiVideoClip,
  // 三种创作入口 / 人设绑定（测试脚本直接调，不必起服务）
  splitScript, fillScenes, decideTool, estimateRender, saveDraftProject,
  // 「画什么」回填：代码摘要 / 标题摘要 / 旧数据补齐（单测直接调）
  manimCodeSummary, titleNarrationSummary, fillAutoHint, withAutoHints, jobScenesWithHints,
  HINT_AUTO_SUFFIX, MANIM_ELEMENT_WORDS,
  resolveBinding, fetchPersona, fetchVoiceBinding, tonePromptLines,
  progressGet, progressStart, progressUpdate, parseSpeakFailure,
  // 任务化 + 配方库：状态机、落盘、重跑
  JOBS_DIR, LIBRARY_DIR, createJob, getJob, jobView, waitJob, ensureJobs, failJob,
  readLibrary, libraryView, repairManimScene,
  // 参考图（上传）：解析 uploadId / 绝对路径、注入 manim、data URL
  resolveSceneImage, attachSceneImages, ensureManimImage, imageAsDataUrl,
  // 规划缓存：实例（统计/清空/测试里改目录）+ 两层键与单场包装
  planCache, PlanCacheLib, styleCacheKey, sceneCacheText, sceneCacheable, planSceneCode,
  // 代码戳：sha1(画什么 | 标题 | 风格 | 引擎)，和场级缓存键同一个函数（单测直接调）
  sceneCodeMaterials, manimStampOf, manimHintMatches, refreshStaleManimScenes, MANIM_STAMP_PREFIX,
  // 主题模式的完整规划（骨架 + 逐场），测试脚本直接调，不必起服务
  planTwoStage,
};
