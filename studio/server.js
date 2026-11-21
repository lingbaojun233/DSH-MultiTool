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
// 风格预设：配色/线宽/字体/节奏。渲染时机械地套到 manim 代码与文字卡上。
const S = require('./lib/styles.js');
// 人设 → 语气。旁白要像"她"在讲，而不是播音腔；见 lib/persona-binding.js。
const PB = require('./lib/persona-binding.js');
const STYLE_DIR = path.join(__dirname, 'styles');

// 讲解画面（HTML/SVG → 无头浏览器截图）与表情叠加是后加的能力。
// 用可选 require：模块还没落地时整套渲染照旧工作，不会因为缺文件起不来。
let HTMLScene = null;
let Overlay = null;
let GdiScene = null;
let Pyplot = null;
let Manim = null;
let Wan = null;
try { HTMLScene = require('./lib/html-scene.js'); } catch { HTMLScene = null; }
try { Overlay = require('./lib/overlay.js'); } catch { Overlay = null; }
try { GdiScene = require('./lib/gdi-scene.js'); } catch { GdiScene = null; }
try { Pyplot = require('./lib/pyplot.js'); } catch { Pyplot = null; }
try { Manim = require('./lib/manim.js'); } catch { Manim = null; }
// AI 视频（wan3.0-video）：可选依赖，模块缺失时 aivideo 场自动降级文字卡，不影响整体启动
try { Wan = require('./lib/wanvideo.js'); } catch { Wan = null; }

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
  renderTimeoutMs: 600000,
  // 人设服务（panel）：默认风格由它决定，见 resolveStyleFor()
  personaUrl: 'http://127.0.0.1:8767',
  personaTimeoutMs: 6000,
  // 人设读不到时的兜底风格（styles/<id>.json）
  defaultStyle: 'whiteboard',
  // 文字卡标题的入场/出场淡化（秒）。0 关闭。
  // 为什么要它：xfade 是 0.4 秒重叠，两张文字卡在这个窗口里同时全亮 → 标题叠字。
  textEdgeFade: 0.15,
  // AI 生成画面（wan3.0-video）的成本护栏：一集最多几条。
  // 每条 5 秒、要等约 100 秒、还占网关额度 —— 不设上限，模型一口气写 8 场就能把额度烧光。
  // 超出的场次在渲染时降级成文字卡并记日志（见 renderProject 的 planAiVideoQuota）。
  maxAiVideo: 4,
  // 一条 AI 视频的总超时（提交 + 轮询 + 下载）。实测 100 秒出片，留到 8 分钟。
  wanTimeoutMs: 480000,
}, readJson(path.join(DIR, 'config.json'), {}));

// 把静帧模式交给渲染层（在 require 之后、任何 sceneClip 之前）
R.setStillMotion(CFG.stillMotion);

if (!CFG.projectDir) CFG.projectDir = path.join(CFG.outDir, 'projects');
// 内部服务令牌：插件替模型调 io 时用（插件没有用户 token）
if (!CFG.internalToken) CFG.internalToken = process.env.DSH_INTERNAL_TOKEN || '';

// 图片素材目录：分镜里 image 只是文件名时，render.js 要去某个目录下找图。
// 必须放在 CFG 合并之后补默认值 —— 默认值依赖 CFG.outDir，而 config.json 可能改了 outDir。
if (!CFG.imageDir) CFG.imageDir = path.join(CFG.outDir, 'images');
// 人设→风格的缓存：跟成片放一起（data/studio/persona-style.json），
// 按 persona.version 失效，见 lib/styles.js 的 resolvePersonaStyle。
if (!CFG.styleCacheFile) CFG.styleCacheFile = path.join(CFG.outDir, 'persona-style.json');

// AI 视频的密钥：**不写进代码、不进日志**，只从 secrets 读。
// 优先 config.wanKeyPath（服务器上是 C:\Apps\DSH-MultiTool\secrets\wan.key），
// 再退到同目录的 qwen.key，最后退到老 video 模块的 secrets.json（同一个 key）。
// 这样"新装一个 wan.key"和"沿用旧 key"都能跑，不用改配置。
if (!CFG.wanKeyPath) CFG.wanKeyPath = path.join(DIR, '..', 'secrets', 'wan.key');
if (!CFG.wanKeyJson) CFG.wanKeyJson = path.join(DIR, '..', 'video', 'secrets.json');

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
 * 取几个表情给模型挑。优先收藏的（那是它自己"满意的"），不够再补普通的。
 * 只给 10 个：给太多它会挑花眼，而且提示词会变长。
 */
async function stickerHints(limit = 10) {
  const grab = async (query) => {
    try {
      const res = await fetch(`${CFG.stickerUrl}/v1/list?${query}`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json().catch(() => null);
      return data && data.ok && Array.isArray(data.items) ? data.items : [];
    } catch { return []; }
  };
  const fav = await grab(`favorite=1&limit=${limit}`);
  const all = fav.length >= 4 ? [] : await grab(`limit=${limit}`);
  const seen = new Set();
  const out = [];
  for (const it of [...fav, ...all]) {
    if (out.length >= limit) break;
    if (!it || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push({ id: String(it.id), name: String(it.mood || it.name || it.id).slice(0, 16) });
  }
  return out;
}

/** 把表情提示并进写分镜的参数（body 里显式给了就不覆盖）。 */
function withPlanHints(body, hints) {
  const opts = Object.assign({}, body || {});
  if (!Array.isArray(opts.stickerIds) && hints && hints.length) opts.stickerIds = hints;
  return opts;
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
    '- text：纯文字卡（渐变底 + 一行大字），只用于开场、转场、下结论；一集最多 1~2 场。',
    '- 不要写 plot / draw / rich：这两条旧路子已停用（写了也会被当成 text，白占一场）。',
    '- 讲"变化过程 / 运动 / 逐渐逼近"的场次必须用 manim，不要拿一张静止的图糊过去。',
    '',
    '## aivideo 场的 video.prompt（生成画面的唯一依据）',
    '- 必须英文：说清主体 + 动作 + 风格 + 镜头，例如 "anime style, cel shading, wide shot, a girl flying over a snowy plain, wind blowing"。',
    '- **≤120 字符**，只写一句，不要引号、不要中文、不要换行；不要把公式/坐标轴/文字写进去（那些用 manim）。',
    '- size 固定写 "1280*720"；seconds 写 5（生成片段就是 5 秒，长了会自动截断）。',
    '',
    `- 场数 3~${CFG.maxScenes}；每场 3~8 秒；加起来接近 ${total} 秒。`,
    '- narration 是给人听的：口语、一句一个意思，下一场接上一场。',
    '- 不要出现 markdown、不要解释你的做法。',
  ];
  if (style) lines.push('', `视觉风格：${style.name}（配色与节奏由后续每场的脚本落实，骨架阶段不用管）`);
  if (toneLines.length) lines.push('', ...toneLines);
  if (stickerIds.length) {
    lines.push(
      '',
      '## 表情包（可选，用来加"大肥鱼"的在场感）',
      '- 给某个场景加 stickers：{"id":"<下面列表里的 id>","at":1.2,"duration":1.6,"x":0.82,"y":0.2,"scale":0.22}',
      '- x/y 是中心点相对位置（0~1），常用右上 0.82/0.2、左下 0.18/0.78；别挡住图和公式。',
      '- 全片用 2~4 次就够，放在惊讶、吐槽、结论这种情绪点上。',
      `- 可用表情：${stickerIds.map((s) => `${s.id}=${s.name}`).join('，')}`,
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
  const minScenes = Math.max(4, Math.min(10, Math.round(total / 15)));
  const maxScenes = Math.min(10, Math.max(minScenes + 2, Math.round(total / 8)));
  const lines = [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `把下面这份稿子拆成分镜。总时长约 ${total} 秒，拆 ${minScenes}~${maxScenes} 场，每场 3~10 秒。`,
    '{"title":"标题","scenes":[{"text":"这一场的标题（≤14字）","narration":"这一场念的旁白（稿子原话截取，≤40字）","seconds":8,"visual_hint":"这一场画面画什么（一句话，具体到图形/公式/动作）","tool":"manim"}]}',
    '',
    '## 原话优先（最重要）',
    '- narration 必须是稿子里**出现过的话**：可以删字、可以截断、可以调顺序，但不要换说法、不要润色、不要改写成书面语。',
    '- text 是从这句原话里抽出来的短标题，≤14 字，不要另起一句。',
    '- 稿子里如果本来就是书面语，旁白照抄；不要为了"口语"把它改写掉。',
    '',
    '## 拆场',
    '- 一场只讲一个意思：转折、举例、公式、结论各成一场。',
    '- visual_hint 要写成"别人照着就能画"的一句话：画什么图形、标什么量、做什么动作。',
    '- tool 只能是 manim 或 text；**至少 80% 的场次用 manim**，text 只给开场/转场/一句结论。',
    '- 讲到公式、坐标轴、曲线、变化过程、对比大小的场次必须 manim。',
    '- 场数不超过 10；加起来接近 ' + total + ' 秒。',
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
      '',
    );
  }
  // AI 生成画面：这里不问 manim 脚本，只要一条英文 prompt（生成模型只认这个）
  if (String(kind || '').toLowerCase() === 'aivideo') {
    return buildAiVideoPrompt(scene, hint).join('\n');
  }
  const body = [
    '{"manim":{"scene":"TangentAnim","code":"from manim import *\\nclass TangentAnim(Scene):\\n    def construct(self):\\n        ..."}}',
    '',
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
    '- 文字：Text（中文必须 Text("…", font="Microsoft YaHei")）；公式：MathTex（LaTeX 已装，直接写 r"$\\frac{dy}{dx}$" 这种，不需要 usepackage）',
    '- 图形：Axes、NumberPlane、Line、Arrow、Dot、Circle、Rectangle、Square、Polygon、SurroundingRectangle、VGroup、NumberLine、axes.plot',
    '- 动作：Write、Create、FadeIn、FadeOut、Transform、ReplacementTransform、GrowArrow、Rotate、Indicate、.animate、VGroup.arrange、self.wait',
    '- 排版：self.play(..., run_time=1.2) 控制节奏；标题用 .to_edge(UP, buff=0.5)',
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

async function planTwoStage(prompt, opts = {}) {
  const total = Number(opts.seconds) || 12;
  const style = opts.style || null;
  const skel = await askJson(buildSkeletonPrompt(prompt, total, { style, stickerIds: opts.stickerIds, toneLines: opts.toneLines }), opts);
  if (!skel.ok) return skel;
  const scenes = Array.isArray(skel.json.scenes) ? skel.json.scenes.slice(0, CFG.maxScenes) : [];
  if (!scenes.length) return { ok: false, error: 'NO_SCENES' };

  let visuals = 0;
  let textCards = 0;
  let aiVideos = 0;
  const aiLimit = Math.max(0, Number(CFG.maxAiVideo) || 0);
  for (const s of scenes) {
    // 三种取值：manim / aivideo / text。plot、draw 这两条旧路子已经停用，
    // 模型写了也会被当成 text（白占一场），所以提示词里连提都不提它们。
    const visual = String(s.visual || '').trim().toLowerCase();
    if (visual === 'aivideo' || (s.video && s.video.prompt)) {
      // 护栏在规划阶段先拦一次：省得模型一口气写 8 场 aivideo，渲染时才逐场降级
      if (aiVideos >= aiLimit) {
        log(`场「${s.text}」超出本集 aivideo 上限 ${aiLimit} 场，规划阶段降级文字卡`);
        textCards += 1;
        continue;
      }
      const aiPrompt = normalizeAiPrompt(s.video && s.video.prompt);
      if (!aiPrompt) {
        log(`场「${s.text}」标了 aivideo 但没给 video.prompt，降级文字卡`);
        textCards += 1;
        continue;
      }
      s.video = { prompt: aiPrompt, size: (s.video && s.video.size) || '1280*720' };
      s.kind = 'aivideo';
      aiVideos += 1;
      continue;
    }
    const kind = visual === 'manim' ? 'manim' : 'text';
    if (kind === 'text') { textCards += 1; continue; }
    const r = await askJson(buildVisualPrompt(s, kind, style), { ...opts, sessionId: 'studio-visual' });
    if (!r.ok) { log(`场「${s.text}」视觉生成失败，降级文字卡`); textCards += 1; continue; }
    const code = r.json && r.json.manim && typeof r.json.manim.code === 'string' ? r.json.manim.code : '';
    if (!code.trim()) { log(`场「${s.text}」没给 manim.code，降级文字卡`); textCards += 1; continue; }
    // 先清洗常见的 Markdown/LaTeX 写法问题，再过安全闸门（否则白等一次 manim）
    const clean = stripMathDelims(code);
    // 安全过滤与 LaTeX 闸门在规划阶段就做一次：命中当场降级，
    // 不必等到渲染时才发现这段代码不能用（那要白等一次 manim）。
    const unsafe = Manim ? Manim.checkCode(clean) : 'manim 模块不可用';
    const noLat = Manim ? Manim.checkNoLatex(clean) : null;
    if (unsafe) {
      log(`场「${s.text}」manim 代码被拒（${unsafe}），降级`);
      textCards += 1;
    } else if (noLat) {
      log(`场「${s.text}」manim 代码含 LaTeX 组件（${noLat}），降级`);
      textCards += 1;
    } else {
      s.manim = { code: clean.slice(0, 8000), scene: r.json.manim.scene || null };
      s.kind = 'manim';
      visuals += 1;
    }
  }
  const ratio = scenes.length ? Math.round((visuals / scenes.length) * 100) : 0;
  log(`两段式规划：${scenes.length} 场，manim ${visuals} 场（${ratio}%），aivideo ${aiVideos} 场，文字卡 ${textCards} 场`);
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
  const prompt = buildScriptSplitPrompt(script, total, { style, toneLines: opts.toneLines });
  const r = await askJson(prompt, { ...opts, sessionId: 'studio-script' });
  if (!r.ok) return r;

  const rawScenes = Array.isArray(r.json.scenes) ? r.json.scenes.slice(0, 10) : [];
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
  // 场数不足 4 时补一句提示，不强行拆 —— 稿子本来就短的时候硬拆会变成一句一场。
  const warnings = [];
  if (scenes.length < 4) warnings.push(`只拆出 ${scenes.length} 场（要求 4~10 场），稿子可能太短；可以手加几场。`);
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
  const scenes = [];
  const warnings = [];
  let manimCount = 0;
  let textCount = 0;
  let aiVideoCount = 0;
  let fallbackCount = 0;
  const aiLimit = Math.max(0, Number(CFG.maxAiVideo) || 0);

  for (let i = 0; i < inputScenes.length; i++) {
    const src = inputScenes[i] || {};
    const base = {
      index: i,
      text: String(src.text || '').slice(0, 60),
      narration: String(src.narration || '').slice(0, 200),
      seconds: clampSceneSeconds(src.seconds),
      visual_hint: String(src.visual_hint || '').slice(0, 600),
      tool: String(src.tool || '').trim().toLowerCase(),
      kind: 'text',
      manim: null,
      video: null,
      status: 'text',
      note: '',
    };
    const decided = decideTool(src);
    base.tool = decided.tool;
    base.tool_reason = decided.reason;
    if (decided.tool === 'text') {
      textCount += 1;
      base.status = 'text';
      scenes.push(base);
      continue;
    }

    // ---- AI 画面：不要 manim 脚本，只要一条英文 prompt ----
    if (decided.tool === 'aivideo') {
      if (aiVideoCount >= aiLimit) {
        base.status = 'fallback';
        base.note = `本集 aivideo 已到上限（${aiLimit} 场），这一场出文字卡`;
        warnings.push(`第 ${i + 1} 场：${base.note}`);
        fallbackCount += 1;
        textCount += 1;
        scenes.push(base);
        continue;
      }
      // 用户已经写了 video.prompt 就直接用；只写了中文「画什么」才让模型翻英文
      let aiPrompt = normalizeAiPrompt(src.video && src.video.prompt);
      let aiSize = (src.video && src.video.size) || '1280*720';
      if (!aiPrompt) {
        const r = await askJson(buildVisualPrompt(base, 'aivideo', style), { ...opts, sessionId: 'studio-aivideo' });
        const got = r.ok && r.json && r.json.video && typeof r.json.video === 'object' ? r.json.video : null;
        aiPrompt = normalizeAiPrompt(got && got.prompt);
        if (got && got.size) aiSize = got.size;
        if (!aiPrompt) {
          base.status = 'fallback';
          base.note = r.ok ? '模型没给出 video.prompt，这一场出文字卡' : `画面描述生成失败（${r.error}），这一场出文字卡`;
          warnings.push(`第 ${i + 1} 场：${base.note}`);
          fallbackCount += 1;
          textCount += 1;
          scenes.push(base);
          continue;
        }
      }
      base.kind = 'aivideo';
      base.video = { prompt: aiPrompt, size: /^\d{2,5}\*\d{2,5}$/.test(String(aiSize)) ? String(aiSize) : '1280*720' };
      base.status = 'aivideo';
      aiVideoCount += 1;
      scenes.push(base);
      continue;
    }

    const prompt = buildVisualPrompt(base, 'manim', style);
    const r = await askJson(prompt, { ...opts, sessionId: 'studio-scene' });
    if (!r.ok) {
      base.status = 'fallback';
      base.note = `动画生成失败（${r.error}），这一场会出文字卡`;
      warnings.push(`第 ${i + 1} 场：${base.note}`);
      fallbackCount += 1;
      textCount += 1;
      scenes.push(base);
      continue;
    }
    const manimObj = r.json && r.json.manim && typeof r.json.manim === 'object' ? r.json.manim : null;
    const code = manimObj && typeof manimObj.code === 'string' ? manimObj.code.trim() : '';
    if (!code) {
      base.status = 'fallback';
      base.note = '模型没给出 manim.code，这一场会出文字卡';
      warnings.push(`第 ${i + 1} 场：${base.note}`);
      fallbackCount += 1;
      textCount += 1;
      scenes.push(base);
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
      warnings.push(`第 ${i + 1} 场：${base.note}`);
      fallbackCount += 1;
      textCount += 1;
      scenes.push(base);
      continue;
    }
    base.kind = 'manim';
    base.manim = { code: clean.slice(0, 8000), scene: (manimObj && manimObj.scene) || null };
    base.status = 'manim';
    manimCount += 1;
    scenes.push(base);
  }

  const ratio = scenes.length ? Math.round((manimCount / scenes.length) * 100) : 0;
  log(`分镜补全：${scenes.length} 场，manim ${manimCount} 场（${ratio}%），aivideo ${aiVideoCount} 场，文字卡 ${textCount} 场，降级 ${fallbackCount} 场`);
  return {
    ok: true,
    scenes,
    stats: { total: scenes.length, manim: manimCount, aivideo: aiVideoCount, text: textCount, fallback: fallbackCount, manimRatio: ratio },
    warnings,
  };
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
  project.scenes = scenes.map((s) => P.normalizeScene(s));
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
  const scenes = (plan.scenes || []).slice(0, CFG.maxScenes).map((s) => {
    // 统一交给 project.js 的 normalizeScene：字段白名单只该有一份。
    // 之前这里手写了一份，结果 kind/html/steps/stickers 全被丢掉 —— 讲解画面永远出不来。
    const normalized = P.normalizeScene(s);
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
  return padWavToSeconds(last.n.file, totalSeconds - (Number(last.n.at) || 0));
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
async function fitAiVideoClip({ inFile, work, index, seconds, w, h, fps }) {
  const out = path.join(work, `wan-${index}-norm.mp4`);
  if (Manim && typeof Manim.normalizeClip === 'function') {
    const norm = await Manim.normalizeClip({ ffmpeg: CFG.ffmpeg, inFile, outFile: out, w, h, fps, seconds });
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
async function renderSceneEngine({ eng, s, index, style, work }) {
  const w = CFG.width;
  const h = CFG.height;
  const fps = CFG.fps;
  if (eng === 'manim') {
    if (!Manim) return { ok: false, error: 'MANIM_MODULE_MISSING' };
    if (!fs.existsSync(CFG.python)) return { ok: false, error: 'NO_PYTHON' };
    // 风格注入在这里做：颜色/背景/线宽/字体都改成风格值，模型写 BLUE 也会被换掉。
    const styled = S.applyToManimCode(s.manim.code, style);
    const mm = await Manim.renderManim({
      python: CFG.python, work, index, code: styled.code, sceneName: s.manim.scene,
      quality: CFG.manimQuality || '-qm', seconds: s.seconds,
      w, h, fps, ffmpeg: CFG.ffmpeg,
      timeoutBaseMs: CFG.manimTimeoutBaseMs, timeoutPerSecondMs: CFG.manimTimeoutPerSecondMs,
    });
    if (!mm.ok) {
      // UNSAFE_CODE / NO_LATEX 是策略性拒收，带上 detail 方便排查是哪一行
      return { ok: false, error: `${mm.error}${mm.detail ? `(${mm.detail})` : ''}` };
    }
    log(`scene#${index} manim 渲完 ${mm.ms}ms（${mm.reencoded ? `已统一到 ${w}x${h}` : '原始规格'}）` +
      ` 风格=${styled.style.id} 换色=${styled.applied.colors} 背景=${styled.applied.background} 线宽=${styled.applied.stroke} 字体=${styled.applied.font}` +
      `${mm.partialFreed ? ` 清缓存 ${Math.round(mm.partialFreed / 1048576)}MB` : ''}`);
    return { ok: true, file: mm.file, applied: styled.applied };
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
    // 密钥来源只打路径，密钥本身永远不进日志
    log(`scene#${index} ai 画面生成中（prompt=${String(s.video.prompt).slice(0, 60)}… 密钥来自 ${path.basename(keyInfo.source)}）`);
    const clip = await Wan.generateClip({
      key: keyInfo.key,
      prompt: s.video.prompt,
      seconds: s.seconds,
      size: s.video.size,
      work, index,
      timeoutMs: CFG.wanTimeoutMs,
      ffmpeg: CFG.ffmpeg,
    });
    if (!clip.ok) {
      return { ok: false, error: clip.error, taskId: clip.taskId, ms: clip.ms };
    }
    // 5/10 秒的产物对到本场秒数：短的克隆末帧补足、长的截断，规格统一到项目宽高
    const norm = await fitAiVideoClip({ inFile: clip.file, work, index, seconds: s.seconds, w, h, fps });
    if (!norm.ok) return { ok: false, error: norm.error };
    log(`scene#${index} ai 画面完成 ${clip.ms}ms（task=${clip.taskId} ${clip.width}x${clip.height} ${clip.duration}s ${Math.round(clip.bytes / 1024)}KB）` +
      `${norm.reencoded ? ' → 已对齐项目规格' : ''}`);
    return { ok: true, file: norm.file, taskId: clip.taskId, ms: clip.ms };
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
      : await R.concatClips({ ffmpeg: CFG.ffmpeg, clips: stills.pngs, out: path.join(work, `slides-${index}.mp4`) });
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
  project.scenes = norm.scenes.map((s) => P.normalizeScene(s));
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
 * 上层拿到失败必须整体中止（VOICE_UNAVAILABLE），不能跳过这一句。
 */
async function getSpeechCached(project, scene, voice, cdir) {
  const text = String(scene.narration || '');
  if (!text) return null;
  const key = P.audioKey(text, voice);
  const hit = project.audioCache[key];
  if (hit && fs.existsSync(hit.wav)) return { wav: hit.wav, ms: hit.ms, key, cached: true };

  const wav = path.join(cdir, `tts-${key}.wav`);
  const got = await fetchSpeech(text, voice, wav);
  if (!got || !got.ok) {
    return {
      error: (got && got.error) || 'SPEAK_FAILED',
      status: (got && got.status) || 0,
      speakError: (got && got.speakError) || '',
      attempts: (got && got.attempts) || 0,
      retries: (got && got.retries) || 0,
      detail: (got && got.detail) || '',
      key,
    };
  }
  const ms = await measureAudioMs(got.file);
  project.audioCache[key] = { wav: got.file, ms, at: new Date().toISOString() };
  return { wav: got.file, ms, key, cached: false };
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
 * 渲染一个项目。
 *   scope='auto'  内容优先：旁白决定每场时长，只有受影响的场需要重画（默认）
 *   scope='all'   全部重画（换了分辨率/字体/需要绝对一致时用）
 *   scope='audio' 画面优先：所有片段必须已存在，只重做旁白与混音 —— 秒级完成
 *
 * 返回里带 reuse/rendered 两个计数，调用方一眼能看出"这次省了多少"。
 */
async function renderProject(project, opts = {}, scope = 'auto') {
  const started = Date.now();
  const voice = opts.voice || project.voice || '';
  const cdir = P.cacheDir(CFG.projectDir, project.id);
  const odir = P.outDir(CFG.projectDir, project.id);
  fs.mkdirSync(cdir, { recursive: true });
  fs.mkdirSync(odir, { recursive: true });

  const work = path.join(os.tmpdir(), `studio-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(work, { recursive: true });

  try {
    if (!project.scenes.length) return { ok: false, error: 'NO_SCENES' };
    const sceneTotal = project.scenes.length;
    progressStart(project.id, sceneTotal);

    // ---- 0) 风格：项目钉死的 > 请求里的 > 人设决定的 ----
    const styleInfo = await resolveStyleFor({ styleId: opts.style || project.style });
    const style = styleInfo.style;
    // 文字卡淡化：项目可以覆盖（0 = 关掉），默认用全局配置
    const edgeFade = project.textEdgeFade == null ? (Number(CFG.textEdgeFade) || 0) : Math.max(0, Number(project.textEdgeFade) || 0);
    const sceneCfg = Object.assign(styleCfg(style), { textEdgeFade: edgeFade });
    const pal = S.textPalette(style);
    log(`风格 ${style.id}（${styleInfo.source}）：${styleInfo.reason}`);

    // ---- 1) 旁白：**先全部拿到**，缺一条就整片失败 ----
    // 以前这里失败就默默跳过，成片于是"一半真一半假"：某几句没声音、
    // 或者 speak 回退了别的音色，事后根本查不出是哪一句。现在整体失败。
    const speeches = [];
    const narrationMs = project.scenes.map(() => 0);
    const missing = [];
    for (let i = 0; i < project.scenes.length; i++) {
      const s = project.scenes[i];
      if (!s.narration) { speeches.push(null); continue; }
      progressUpdate(project.id, {
        phase: 'voice', current: i, done: i, total: sceneTotal,
        label: `正在合成第 ${i + 1}/${sceneTotal} 句旁白`,
      });
      const got = await getSpeechCached(project, s, voice, cdir);
      if (!got || !got.wav) {
        missing.push({
          index: i,
          text: String(s.narration).slice(0, 40),
          error: (got && got.error) || 'SPEAK_FAILED',
          status: (got && got.status) || 0,
          speakError: (got && got.speakError) || '',
          attempts: (got && got.attempts) || 0,
          retries: (got && got.retries) || 0,
          detail: (got && got.detail) || '',
        });
        speeches.push(null);
        continue;
      }
      speeches.push(got);
      narrationMs[i] = got.ms;
    }
    if (missing.length) {
      log(`渲染中止 VOICE_UNAVAILABLE：${missing.length}/${project.scenes.length} 条旁白没拿到（scene#${missing.map((m) => m.index).join(',')}）`);
      // 说话失败最多重试了几次：面板要能说"已重试 4 次"，而不是只说"失败"。
      const maxAttempts = missing.reduce((a, m) => Math.max(a, Number(m.attempts) || 0), 0);
      const speakError = missing.find((m) => m.speakError) ? missing.find((m) => m.speakError).speakError : '';
      progressUpdate(project.id, {
        status: 'failed', phase: 'failed',
        label: speakError === 'QUEUE_TIMEOUT' ? '配音排队超时' : '配音服务不可用',
        error: 'VOICE_UNAVAILABLE', detail: speakError || missing[0].error,
        attempts: maxAttempts, total: sceneTotal,
      });
      return {
        ok: false,
        error: 'VOICE_UNAVAILABLE',
        speakError,
        attempts: maxAttempts,
        scenes: missing,
        hint: '有旁白没合成出来（speak strict 模式）。整片不渲染，避免产出"半真半假"的成片；修好音色后重试即可。',
        ms: Date.now() - started,
      };
    }


    // ---- 2) 时长 ----
    let finalPlan;
    if (scope === 'audio') {
      // 画面优先：沿用分镜里已有的 seconds，不让旁白改节奏
      const total = project.scenes.reduce((a, s) => a + s.seconds, 0) - CFG.fade * (project.scenes.length - 1);
      finalPlan = { scenes: project.scenes.map((s) => Object.assign({}, s, { actualSeconds: s.seconds })), totalSeconds: Number(Math.max(0.5, total).toFixed(2)) };
    } else {
      finalPlan = planWithNarration({ scenes: project.scenes }, narrationMs);
      // 把重算后的时长写回项目：下次 audio-only 才有据可依
      for (let i = 0; i < project.scenes.length; i++) {
        project.scenes[i].seconds = finalPlan.scenes[i].seconds;
        project.scenes[i].actualSeconds = finalPlan.scenes[i].actualSeconds;
        project.scenes[i].narrationMs = finalPlan.scenes[i].narrationMs;
      }
    }

    // ---- 2.5) AI 画面配额：一集最多 maxAiVideo 条 ----
    // 每条要等 ~100 秒、还占网关额度。超出的场次在这里就定死降级，
    // 渲染循环里直接跳过 aivideo 引擎 —— 而不是"渲到一半才发现超预算"。
    const aiQuota = planAiVideoQuota(finalPlan.scenes, CFG.maxAiVideo);
    if (aiQuota.total > aiQuota.allowed.size) {
      log(`成本护栏：本集 aivideo ${aiQuota.total} 场，上限 ${aiQuota.max} 场；`
        + `第 ${aiQuota.degraded.map((i) => i + 1).join('、')} 场降级为文字卡（省额度/时间）`);
    }

    // ---- 3) 画面片段：能复用就复用 ----
    const clips = [];
    const durations = [];
    let reused = 0;
    let rendered = 0;
    const totalScenes = finalPlan.scenes.length;
    for (let i = 0; i < finalPlan.scenes.length; i++) {
      const s = finalPlan.scenes[i];
      const key = P.sceneKey(s, sceneCfg);
      const hit = project.cache[key];
      const hasClip = hit && fs.existsSync(hit.clip);
      const canReuse = scope !== 'all' && hasClip;
      if (canReuse) {
        clips.push(hit.clip);
        reused += 1;
        progressUpdate(project.id, {
          phase: 'scenes', current: i, done: i + 1, total: totalScenes,
          engine: 'cache', label: `第 ${i + 1}/${totalScenes} 场复用缓存`
        });
      } else {
        // 按"手里有什么素材"排引擎链（sceneEngines），逐个试，谁先成用谁。
        // 有 draw 就一定会被轮到 —— 不会再出现"有 draw 却被 manim 分支吞掉"。
        let chain = sceneEngines(s);
        // 成本护栏之外的场次不许再调生成接口：直接把它从链条里摘掉，
        // 后面的 manim/plot/draw/html 照常有机会，最后落到文字卡。
        if (chain.includes('aivideo') && !aiQuota.allowed.has(i)) {
          chain = chain.filter((e) => e !== 'aivideo');
        }
        const firstEng = chain[0] || 'text';
        progressUpdate(project.id, {
          phase: 'scenes', current: i, done: i, total: totalScenes,
          engine: firstEng, label: `第 ${i + 1}/${totalScenes} 场 ${engineLabel(firstEng)} 渲染中…`,
        });
        let clipFile = null;
        let engine = 'text';
        for (const eng of chain) {
          if (eng === 'text') break;
          try {
            const got = await renderSceneEngine({ eng, s, index: i, style, work });
            if (got && got.ok) {
              clipFile = got.file;
              engine = eng;
              if (chain.indexOf(eng) > 0) log(`scene#${i} 退回 ${eng} 成功（前一个引擎失败）`);
              break;
            }
            log(`scene#${i} ${eng} 失败：${String((got && got.error) || 'unknown').slice(0, 200)}`);
          } catch (err) {
            log(`scene#${i} ${eng} 异常：${err && err.message || err}`);
          }
        }
        if (!clipFile) {
          // 文字卡：渐变底 + 一行大字，配色来自风格；标题入场/出场各 textEdgeFade 秒，
          // 这样 xfade 的 0.4 秒重叠期里两个标题不会同时全亮。
          engine = 'text';
          const stillScene = Object.assign({}, s, { bg: pal.bg, textColor: pal.textColor });
          const still = await R.sceneStill({
            ffmpeg: CFG.ffmpeg, work, index: i, scene: stillScene,
            w: CFG.width, h: CFG.height, font: CFG.font,
            imageDir: CFG.imageDir, image: s.image || undefined, motion: s.motion || undefined,
          });
          if (!still.ok) return { ok: false, error: `SCENE_STILL_FAILED#${i}: ${(still.error || '').slice(0, 300)}` };
          const clip = await R.sceneClip({
            ffmpeg: CFG.ffmpeg, work, index: i, stillPng: still.png,
            seconds: s.seconds, w: CFG.width, h: CFG.height, fps: CFG.fps,
            image: s.image || undefined, motion: s.motion || undefined,
            edgeFade: s.image ? 0 : edgeFade,
            // 转场重叠时长传下去：文字卡的淡化要跨过 xfade 的中点，两张卡的标题才不会重影
            edgeLead: Number(CFG.fade) || 0,
            // 淡到风格底色而不是黑：白板这类浅色风格淡到黑会变成一下黑屏闪烁
            edgeColor: pal.bg.c0,
          });
          if (!clip.ok) return { ok: false, error: `SCENE_CLIP_FAILED#${i}: ${(clip.error || '').slice(0, 300)}` };
          clipFile = clip.file;
        }

        // 表情叠加：加"大肥鱼"的在场感。失败不致命 —— 画面对了比表情重要。
        if (Array.isArray(s.stickers) && s.stickers.length && Overlay) {
          try {
            const ov = await Overlay.overlayStickers({
              ffmpeg: CFG.ffmpeg, stickerDir: CFG.stickerDir, work, index: i,
              videoIn: clipFile, out: path.join(work, `ov-${i}.mp4`),
              w: CFG.width, h: CFG.height, stickers: s.stickers,
            });
            if (ov && ov.ok && ov.applied > 0) clipFile = ov.file;
            else log(`scene#${i} 表情叠加跳过: ${(ov && (ov.warning || ov.error) || '').slice(0, 160)}`);
          } catch (err) {
            log(`scene#${i} 表情叠加异常: ${err && err.message || err}`);
          }
        }

        const dest = path.join(cdir, `clip-${key}.mp4`);
        fs.copyFileSync(clipFile, dest);
        // engine 记下来：排查"这场的坐标轴为什么没了"时一眼看出是哪个引擎出的片
        project.cache[key] = { clip: dest, engine, style: style.id, at: new Date().toISOString() };
        clips.push(dest);
        rendered += 1;
      }
      durations.push(s.seconds);
      progressUpdate(project.id, { phase: 'scenes', done: i + 1, total: totalScenes });
    }

    // ---- 4) 拼接（可缓存：画面没变就不用重拼）----
    progressUpdate(project.id, { phase: 'concat', label: '正在拼接画面' });
    // 只换声音时最值钱的一步：拼接要跑一次全片编码，几十秒的片子就是 1~3 秒白花。
    const joinedKey = P.sha1(JSON.stringify({ clips: clips.map((c) => path.basename(c)), durations, fade: CFG.fade, w: CFG.width, h: CFG.height, fps: CFG.fps }));
    let joined = null;
    if (project.joined && project.joined.key === joinedKey && fs.existsSync(project.joined.file) && scope !== 'all') {
      joined = project.joined.file;
      log(`复用拼接结果 ${path.basename(joined)}`);
    } else {
      joined = path.join(cdir, `joined-${joinedKey}.mp4`);
      const cat = await R.concatClips({ ffmpeg: CFG.ffmpeg, clips, durations, out: joined, fade: CFG.fade });
      if (!cat.ok) return { ok: false, error: `CONCAT_FAILED: ${(cat.error || '').slice(0, 300)}` };
      project.joined = { key: joinedKey, file: joined, at: new Date().toISOString() };
    }

    // ---- 5) 旁白排位 ----
    const narrations = [];
    let at = 0;
    for (let i = 0; i < finalPlan.scenes.length; i++) {
      const sp = speeches[i];
      if (sp) {
        let wav = sp.wav;
        let ms = sp.ms;
        if (scope === 'audio') {
          // 只重做声音时，画面长度是既定的，旁白要自己塞进去
          const fitted = await fitNarration(wav, ms, finalPlan.scenes[i].seconds, work, i);
          wav = fitted.wav; ms = fitted.ms;
        }
        narrations.push({ file: wav, at: Math.max(0, at), ms });
      }
      at += finalPlan.scenes[i].seconds - CFG.fade;
    }
    guardAudioTail(narrations, finalPlan.totalSeconds);

    // 成片落在 outDir 根下（面板按 jobId 直接取 /api/studio/video?id=），
    // 项目目录里只留缓存与记录，避免两处路径含义不一致。
    const renderId = crypto.randomUUID();
    const outFile = path.join(CFG.outDir, `${renderId}.mp4`);
    progressUpdate(project.id, { phase: 'mix', label: '正在混音' });
    const mixed = await R.mixAudio({
      ffmpeg: CFG.ffmpeg, videoIn: joined, narrations,
      bgm: pickBgm(opts.bgm || project.bgm), totalSeconds: finalPlan.totalSeconds, out: outFile,
    });
    if (!mixed.ok) return { ok: false, error: `AUDIO_FAILED: ${(mixed.error || '').slice(0, 300)}` };

    const stat = fs.statSync(outFile);
    const record = {
      renderId, file: outFile, bytes: stat.size,
      seconds: finalPlan.totalSeconds, at: new Date().toISOString(),
      scope, reused, rendered, ms: Date.now() - started,
      style: style.id,
    };
    project.renders = (project.renders || []).concat([record]).slice(-10);
    P.saveProject(CFG.projectDir, project);
    log(`project ${project.id} render scope=${scope} reused=${reused} rendered=${rendered} style=${style.id} ${Math.round(stat.size / 1024)}KB ${Date.now() - started}ms`);
    progressUpdate(project.id, {
      status: 'done', phase: 'done', done: totalScenes, total: totalScenes,
      label: `做好了：${finalPlan.totalSeconds} 秒`,
      renderId, file: outFile, seconds: finalPlan.totalSeconds, bytes: stat.size, ms: Date.now() - started,
    });

    return {
      ok: true, ...record,
      plan: finalPlan,
      narrationCount: narrations.length,
      overBudget: finalPlan.overBudget || false,
      style: { id: style.id, name: style.name, source: styleInfo.source, reason: styleInfo.reason, personaVersion: styleInfo.personaVersion || 0 },
    };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { }
  }
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
        project.scenes = body.scenes.slice(0, CFG.maxScenes).map((s) => P.normalizeScene(s));
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
      const touched = P.applyPatches(project, body.patches || body.patch || []);
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
      let result;
      try {
        result = await renderProject(project, { voice: body.voice || project.voice, bgm: body.bgm || project.bgm, style: project.style }, scope);
      } catch (err) {
        progressUpdate(project.id, {
          status: 'failed', phase: 'failed', label: '渲染异常',
          error: 'RENDER_FAILED', detail: String((err && err.message) || err).slice(0, 300),
        });
        throw err;
      }
      if (!result.ok) {
        // 只在还没被标成 failed 时补一笔（VOICE_UNAVAILABLE 已经自己写过了）
        const rec = progressGet(project.id);
        if (!rec || rec.status !== 'failed') {
          progressUpdate(project.id, {
            status: 'failed', phase: 'failed', label: '渲染失败',
            error: result.error || '', detail: String(result.hint || result.detail || '').slice(0, 300),
          });
        }
      }
      return json(res, result.ok ? 200 : renderErrorStatus(result), result);
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
      });
      if (!r.ok) return json(res, 200, { ok: false, step: 'storyboard', error: r.error, raw: r.raw });
      const saved = saveDraftProject({
        projectId: body.projectId,
        title: r.title,
        scenes: r.scenes.map((s) => ({ text: s.text, narration: s.narration, seconds: s.seconds })),
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
      const r = await fillScenes(list, { style: binding.styleObject, req });
      if (!r.ok) return json(res, 200, { ok: false, step: 'storyboard', error: r.error, raw: r.raw });
      const title = String(body.title || (list.find((s) => s && s.text) || {}).text || '未命名').slice(0, 60);
      const saved = saveDraftProject({
        projectId: body.projectId,
        title,
        scenes: r.scenes.map((s) => ({
          text: s.text, narration: s.narration, seconds: s.seconds,
          kind: s.kind, manim: s.manim || null, video: s.video || null,
        })),
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
      const binding = await resolveBinding({ styleId: body.style || '' });
      const styleInfo = binding.styleInfo;
      const two = await planTwoStage(prompt, {
        seconds: body.seconds, req, style: styleInfo.style,
        toneLines: tonePromptLines(binding),
        stickerIds: withPlanHints(body, await stickerHints()).stickerIds,
      });
      if (!two.ok) return json(res, 200, { ok: false, step: 'plan', error: two.error, raw: two.raw });
      const plan = normalizePlan(two.json);
      const result = await renderPlan(plan, { voice: body.voice, bgm: body.bgm, style: styleInfo.id });
      log(`create ok=${result.ok} scenes=${plan.scenes.length} style=${styleInfo.id} ${result.ok ? `bytes=${result.bytes} ms=${result.ms}` : result.error}`);
      return json(res, result.ok ? 200 : renderErrorStatus(result), Object.assign({
        plan,
        estimate: estimateRender(plan.scenes),
        voice: binding.voice,
        tone: binding.tone,
        bindingSummary: binding.summary,
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
  server.listen(CFG.port, HOST, () => {
    log(`studio on http://${HOST}:${CFG.port}  ${CFG.width}x${CFG.height}@${CFG.fps}  ffmpeg=${fs.existsSync(CFG.ffmpeg)}  bgmDir=${CFG.bgmDir}`);
  });
}

if (require.main === module) start();

// 只导出纯逻辑与被复用的实现，供本地验证脚本直接调用
module.exports = {
  planWithNarration, wavDurationMs, parseWav, measureAudioMs, padWavToSeconds, guardAudioTail,
  normalizePlan, renderPlan, renderProject, start, server, CFG, P, S,
  sceneEngines, resolveStyleFor, styleCfg,
  buildSkeletonPrompt, buildVisualPrompt, buildScriptSplitPrompt, buildAiVideoPrompt,
  // AI 画面（wan3.0-video）：配额是纯函数，单测直接调；wanKeyInfo 只回来源不回密钥
  planAiVideoQuota, isAiVideoScene, normalizeAiPrompt, wanKeyInfo, fitAiVideoClip,
  // 三种创作入口 / 人设绑定（测试脚本直接调，不必起服务）
  splitScript, fillScenes, decideTool, estimateRender, saveDraftProject,
  resolveBinding, fetchPersona, fetchVoiceBinding, tonePromptLines,
  progressGet, progressStart, progressUpdate, parseSpeakFailure,
};
