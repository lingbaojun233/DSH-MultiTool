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

const DIR = __dirname;
const HOST = '127.0.0.1';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
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
  planTimeoutMs: 180000,
  renderTimeoutMs: 600000,
}, readJson(path.join(DIR, 'config.json'), {}));

if (!CFG.projectDir) CFG.projectDir = path.join(CFG.outDir, 'projects');

// 图片素材目录：分镜里 image 只是文件名时，render.js 要去某个目录下找图。
// 必须放在 CFG 合并之后补默认值 —— 默认值依赖 CFG.outDir，而 config.json 可能改了 outDir。
if (!CFG.imageDir) CFG.imageDir = path.join(CFG.outDir, 'images');

// ---- 旁白驱动时长的三个常量（秒）----
// NARRATION_PAD：旁白念完之后留的余量。0.6 秒够一次换气，再短听着像被掐断。
const NARRATION_PAD = 0.6;
// NARRATION_FLOOR_PAD：总时长封顶时的绝对下限。宁可成片超一点总时长，也不能把一句话切两半。
const NARRATION_FLOOR_PAD = 0.3;
// MAX_SCENE_SECONDS：单场软上限。一张固定画面撑到 6 秒以上观众会走神；
// 但旁白本身超过 5.4 秒时这个上限让位给"不截断"（见 planWithNarration）。
const MAX_SCENE_SECONDS = 6;

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

/** 让 DSH 写分镜。只给"怎么写分镜"的约束，不给它画图的机会。 */
function buildPlanPrompt(prompt, opts) {
  const total = Number(opts.seconds) || 12;
  return [
    `我要做一段横屏短视频，主题：${prompt}`,
    `总时长大约 ${total} 秒，画面上的文字要短。`,
    '',
    '你只需要写分镜，不要写代码、不要画图、不要描述滤镜参数。画面由程序渲染。',
    '只输出 JSON，不要代码块、不要解释：',
    '{"title":"一句话标题","scenes":[',
    '  {"text":"画面上的大字，不超过 12 个字","narration":"这一场的旁白，可空，不超过 30 个字","seconds":3,"bg":{"c0":"#0b1a3a","c1":"#ff7a3d"}}',
    ']}',
    '',
    '要求：',
    `1. 场数 3~${CFG.maxScenes} 场，每场 2~5 秒，加起来接近 ${total} 秒。`,
    '2. text 要像短视频字幕那样短，不要整句复述旁白。',
    '3. narration 是给人听的，用口语、一句一个意思；第二场之后可以和上一场衔接。',
    '4. bg.c0 / bg.c1 必须是十六进制颜色（如 #0b1a3a），两色要能表达这一场的情绪。',
    '5. 不要出现 markdown、不要解释。',
  ].join('\n');
}

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
    const seconds = Math.min(MAX_SCENE_SECONDS, Math.max(CFG.minSceneSeconds, Number(s.seconds) || 3));
    const bg = s.bg || {};
    const motion = optStr(s.motion);
    return {
      text: String(s.text || '').slice(0, 40),
      narration: String(s.narration || '').slice(0, 80),
      seconds,
      bg: { c0: hex(bg.c0, '#101a33'), c1: hex(bg.c1, '#3a2a5a') },
      textSize: Number(s.textSize) || null,
      // 图片名（或绝对路径）：渲染层据此找素材；没有就是纯渐变+文字
      image: optStr(s.image),
      // 运镜：认识的四个值统一小写，不认识的原样透传
      motion: motion ? (MOTIONS.includes(motion.toLowerCase()) ? motion.toLowerCase() : motion) : null,
      // 先占位：正常是 0，等 TTS 量出真实长度后由 planWithNarration 覆盖。
      // 提前放进对象是为了让 /v1/plan 的返回结构和 /v1/render 一致，面板不用判空。
      narrationMs: 0,
      actualSeconds: seconds,
    };
  });
  if (!scenes.length) scenes.push({ text: String(plan.title || '短视频'), narration: '', seconds: 3, bg: { c0: '#101a33', c1: '#3a2a5a' }, textSize: null, image: null, motion: null, narrationMs: 0, actualSeconds: 3 });

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

/** speak 返回的是 wav 字节，不能走 postJson（它会当文本读）。单独实现。 */
async function fetchSpeech(text, voice, outFile) {
  if (!text) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`${CFG.speakUrl}/v1/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text, voice }),
      signal: ctrl.signal,
    });
    const ct = String(res.headers.get('content-type') || '');
    if (!res.ok || !ct.startsWith('audio/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return null;
    fs.writeFileSync(outFile, buf);
    return outFile;
  } catch (err) {
    log('speak failed: ' + (err && err.message || err));
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  };
}

// ------------------------------------------------------- 项目渲染（增量） --

/**
 * 拿一段旁白：命中缓存直接返回，否则合成并写进缓存。
 * 缓存键是 (文本, 音色)，所以"只改台词"时只有改到的那几场需要重新合成。
 */
async function getSpeechCached(project, scene, voice, cdir) {
  const text = String(scene.narration || '');
  if (!text) return null;
  const key = P.audioKey(text, voice);
  const hit = project.audioCache[key];
  if (hit && fs.existsSync(hit.wav)) return { wav: hit.wav, ms: hit.ms, key, cached: true };

  const wav = path.join(cdir, `tts-${key}.wav`);
  const got = await fetchSpeech(text, voice, wav);
  if (!got) return null;
  const ms = await measureAudioMs(got);
  project.audioCache[key] = { wav, ms, at: new Date().toISOString() };
  return { wav: got, ms, key, cached: false };
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

    // ---- 1) 旁白 ----
    const speeches = [];
    const narrationMs = project.scenes.map(() => 0);
    for (let i = 0; i < project.scenes.length; i++) {
      const s = project.scenes[i];
      if (!s.narration) { speeches.push(null); continue; }
      const got = await getSpeechCached(project, s, voice, cdir);
      speeches.push(got);
      narrationMs[i] = got ? got.ms : 0;
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

    // ---- 3) 画面片段：能复用就复用 ----
    const clips = [];
    const durations = [];
    let reused = 0;
    let rendered = 0;
    for (let i = 0; i < finalPlan.scenes.length; i++) {
      const s = finalPlan.scenes[i];
      const key = P.sceneKey(s, CFG);
      const hit = project.cache[key];
      const hasClip = hit && fs.existsSync(hit.clip);
      const canReuse = scope !== 'all' && hasClip;
      if (canReuse) {
        clips.push(hit.clip);
        reused += 1;
      } else {
        const still = await R.sceneStill({
          ffmpeg: CFG.ffmpeg, work, index: i, scene: s,
          w: CFG.width, h: CFG.height, font: CFG.font,
          imageDir: CFG.imageDir, image: s.image || undefined, motion: s.motion || undefined,
        });
        if (!still.ok) return { ok: false, error: `SCENE_STILL_FAILED#${i}: ${(still.error || '').slice(0, 300)}` };
        const clip = await R.sceneClip({
          ffmpeg: CFG.ffmpeg, work, index: i, stillPng: still.png,
          seconds: s.seconds, w: CFG.width, h: CFG.height, fps: CFG.fps,
          image: s.image || undefined, motion: s.motion || undefined,
        });
        if (!clip.ok) return { ok: false, error: `SCENE_CLIP_FAILED#${i}: ${(clip.error || '').slice(0, 300)}` };
        const dest = path.join(cdir, `clip-${key}.mp4`);
        fs.copyFileSync(clip.file, dest);
        project.cache[key] = { clip: dest, at: new Date().toISOString() };
        clips.push(dest);
        rendered += 1;
      }
      durations.push(s.seconds);
    }

    // ---- 4) 拼接（可缓存：画面没变就不用重拼）----
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
    };
    project.renders = (project.renders || []).concat([record]).slice(-10);
    P.saveProject(CFG.projectDir, project);
    log(`project ${project.id} render scope=${scope} reused=${reused} rendered=${rendered} ${Math.round(stat.size / 1024)}KB ${Date.now() - started}ms`);

    return {
      ok: true, ...record,
      plan: finalPlan,
      narrationCount: narrations.length,
      overBudget: finalPlan.overBudget || false,
    };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { }
  }
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
      const project = P.createProject(CFG.projectDir, {
        title: body.title || '未命名项目',
        width: Number(body.width) || CFG.width,
        height: Number(body.height) || CFG.height,
        fps: Number(body.fps) || CFG.fps,
        fade: body.fade == null ? CFG.fade : Number(body.fade),
        voice: body.voice || '',
        bgm: body.bgm || '',
      });
      if (Array.isArray(body.scenes) && body.scenes.length) {
        project.scenes = body.scenes.slice(0, CFG.maxScenes).map((s) => P.normalizeScene(s));
        P.saveProject(CFG.projectDir, project);
      }
      log(`project created ${project.id} scenes=${project.scenes.length}`);
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
      // 告诉调用方"这次会重渲几场"，让 AI 能解释为什么快/慢
      const preview = P.planReuse(project, CFG);
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
      if (scope === 'audio' && project.scenes.some((s) => !project.cache[P.sceneKey(s, CFG)])) {
        // 还有场次没渲过，没法只做声音 —— 明确报错，别偷偷改成全量
        return json(res, 409, { ok: false, error: 'CLIPS_MISSING', hint: '先 scope=auto 渲一次画面，再单独重做声音' });
      }
      const result = await renderProject(project, { voice: body.voice || project.voice, bgm: body.bgm || project.bgm }, scope);
      return json(res, 200, result);
    }

    // ---------------------------------------------------- 一次性渲染 ---
    if (req.method === 'GET' && p === '/v1/health') {
      return json(res, 200, {
        ok: true,
        width: CFG.width,
        height: CFG.height,
        fps: CFG.fps,
        ffmpeg: fs.existsSync(CFG.ffmpeg),
        font: fs.existsSync(CFG.font),
        maxScenes: CFG.maxScenes,
        maxTotalSeconds: CFG.maxTotalSeconds,
      });
    }

    // 只出分镜，不渲染（方便先看分镜再决定渲不渲）
    if (req.method === 'POST' && p === '/v1/plan') {
      const body = JSON.parse(await readBody(req) || '{}');
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'PROMPT_REQUIRED' });
      const io = await postJson(`${CFG.ioUrl}/v1/input`,
        { text: buildPlanPrompt(prompt, body), sessionId: 'studio-plan' },
        { authorization: String(req.headers.authorization || '') },
        CFG.planTimeoutMs);
      if (!io.data || !io.data.ok) {
        return json(res, 200, { ok: false, step: 'plan', error: (io.data && (io.data.error || io.data.code)) || `io HTTP ${io.status}` });
      }
      const parsed = parsePlan(io.data.answer);
      if (!parsed) return json(res, 200, { ok: false, step: 'plan', error: 'PLAN_NOT_JSON', raw: String(io.data.answer || '').slice(0, 800) });
      return json(res, 200, { ok: true, plan: normalizePlan(parsed) });
    }

    if (req.method === 'POST' && p === '/v1/render') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.plan || !Array.isArray(body.plan.scenes)) return json(res, 400, { ok: false, error: 'PLAN_REQUIRED' });
      const plan = normalizePlan(body.plan);
      const result = await renderPlan(plan, { voice: body.voice, bgm: body.bgm });
      log(`render ok=${result.ok} ${result.ok ? `bytes=${result.bytes} ms=${result.ms}` : result.error}`);
      return json(res, 200, Object.assign({ plan }, result));
    }

    // 一步到底：写分镜 + 渲染
    if (req.method === 'POST' && p === '/v1/create') {
      const body = JSON.parse(await readBody(req) || '{}');
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'PROMPT_REQUIRED' });
      const io = await postJson(`${CFG.ioUrl}/v1/input`,
        { text: buildPlanPrompt(prompt, body), sessionId: 'studio-plan' },
        { authorization: String(req.headers.authorization || '') },
        CFG.planTimeoutMs);
      if (!io.data || !io.data.ok) {
        return json(res, 200, { ok: false, step: 'plan', error: (io.data && (io.data.error || io.data.code)) || `io HTTP ${io.status}` });
      }
      const parsed = parsePlan(io.data.answer);
      if (!parsed) return json(res, 200, { ok: false, step: 'plan', error: 'PLAN_NOT_JSON', raw: String(io.data.answer || '').slice(0, 800) });

      const plan = normalizePlan(parsed);
      const result = await renderPlan(plan, { voice: body.voice, bgm: body.bgm });
      log(`create ok=${result.ok} scenes=${plan.scenes.length} ${result.ok ? `bytes=${result.bytes} ms=${result.ms}` : result.error}`);
      return json(res, 200, Object.assign({ plan }, result));
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
  normalizePlan, renderPlan, renderProject, start, server, CFG, P,
};
