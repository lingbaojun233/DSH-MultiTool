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
  maxScenes: 8,
  minSceneSeconds: 2,
  maxTotalSeconds: 60,
  ffmpeg: 'C:\\Apps\\DSH-MultiTool\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  font: 'C:\\Windows\\Fonts\\msyh.ttc',
  ioUrl: 'http://127.0.0.1:8765',
  speakUrl: 'http://127.0.0.1:8770',
  outDir: 'C:\\Apps\\DSH-MultiTool\\data\\studio',
  bgmDir: 'C:\\Apps\\DSH-MultiTool\\data\\studio\\bgm',
  planTimeoutMs: 180000,
  renderTimeoutMs: 600000,
}, readJson(path.join(DIR, 'config.json'), {}));

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
  const scenes = (plan.scenes || []).slice(0, CFG.maxScenes).map((s) => {
    const seconds = Math.min(6, Math.max(CFG.minSceneSeconds, Number(s.seconds) || 3));
    const bg = s.bg || {};
    return {
      text: String(s.text || '').slice(0, 40),
      narration: String(s.narration || '').slice(0, 80),
      seconds,
      bg: { c0: hex(bg.c0, '#101a33'), c1: hex(bg.c1, '#3a2a5a') },
      textSize: Number(s.textSize) || null,
    };
  });
  if (!scenes.length) scenes.push({ text: String(plan.title || '短视频'), narration: '', seconds: 3, bg: { c0: '#101a33', c1: '#3a2a5a' }, textSize: null });

  // 总时长封顶：超了就把每场按比例压回来
  let total = scenes.reduce((a, s) => a + s.seconds, 0);
  if (total > CFG.maxTotalSeconds + CFG.fade * (scenes.length - 1)) {
    const target = CFG.maxTotalSeconds;
    const gaps = CFG.fade * (scenes.length - 1);
    const k = (target + gaps) / total;
    for (const s of scenes) s.seconds = Math.max(CFG.minSceneSeconds, Number((s.seconds * k).toFixed(2)));
    total = scenes.reduce((a, s) => a + s.seconds, 0);
  }
  // xfade 是重叠转场：成片比"场次之和"短 (n-1)*fade 秒
  const span = Math.max(0.5, total - CFG.fade * (scenes.length - 1));
  return { title: String(plan.title || '').slice(0, 60), scenes, totalSeconds: Number(span.toFixed(2)) };
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

async function renderPlan(plan, opts = {}) {
  const jobId = crypto.randomUUID();
  const work = path.join(os.tmpdir(), `studio-${jobId.slice(0, 8)}`);
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(CFG.outDir, { recursive: true });
  const started = Date.now();

  const stills = [];
  const clips = [];
  const durations = plan.scenes.map((s) => s.seconds);

  for (let i = 0; i < plan.scenes.length; i++) {
    const still = await R.sceneStill({
      ffmpeg: CFG.ffmpeg, work, index: i, scene: plan.scenes[i],
      w: CFG.width, h: CFG.height, font: CFG.font,
    });
    if (!still.ok) return { ok: false, error: `SCENE_STILL_FAILED#${i}: ${(still.error || '').slice(0, 300)}` };
    stills.push(still.png);

    const clip = await R.sceneClip({
      ffmpeg: CFG.ffmpeg, work, index: i, stillPng: still.png,
      seconds: plan.scenes[i].seconds, w: CFG.width, h: CFG.height, fps: CFG.fps,
    });
    if (!clip.ok) return { ok: false, error: `SCENE_CLIP_FAILED#${i}: ${(clip.error || '').slice(0, 300)}` };
    clips.push(clip.file);
  }

  const joined = path.join(work, 'joined.mp4');
  const cat = await R.concatClips({ ffmpeg: CFG.ffmpeg, clips, durations, out: joined, fade: CFG.fade });
  if (!cat.ok) return { ok: false, error: `CONCAT_FAILED: ${(cat.error || '').slice(0, 300)}` };

  // 旁白：逐场合成，按累计起点排进去（每过一次转场，起点要提前 fade 秒）
  const narrations = [];
  let at = 0;
  for (let i = 0; i < plan.scenes.length; i++) {
    const line = plan.scenes[i].narration;
    if (line) {
      const wav = path.join(work, `tts-${i}.wav`);
      const got = await fetchSpeech(line, opts.voice, wav);
      if (got) narrations.push({ file: got, at: Math.max(0, at) });
    }
    at += plan.scenes[i].seconds - CFG.fade;
  }

  const bgm = pickBgm(opts.bgm);
  const outFile = path.join(CFG.outDir, `${jobId}.mp4`);
  const mixed = await R.mixAudio({
    ffmpeg: CFG.ffmpeg, videoIn: joined, narrations, bgm,
    totalSeconds: plan.totalSeconds, out: outFile,
  });
  if (!mixed.ok) return { ok: false, error: `AUDIO_FAILED: ${(mixed.error || '').slice(0, 300)}` };

  try { fs.rmSync(work, { recursive: true, force: true }); } catch { }
  const stat = fs.statSync(outFile);
  return {
    ok: true,
    file: outFile,
    jobId,
    bytes: stat.size,
    seconds: plan.totalSeconds,
    narrationCount: narrations.length,
    bgm: bgm ? path.basename(bgm) : null,
    ms: Date.now() - started,
  };
}

// ------------------------------------------------------------------ routes --

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
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

fs.mkdirSync(CFG.bgmDir, { recursive: true });
server.listen(CFG.port, HOST, () => {
  log(`studio on http://${HOST}:${CFG.port}  ${CFG.width}x${CFG.height}@${CFG.fps}  ffmpeg=${fs.existsSync(CFG.ffmpeg)}  bgmDir=${CFG.bgmDir}`);
});
