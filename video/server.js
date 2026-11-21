'use strict';
/**
 * DSH-MultiTool :: video module
 *
 * 只做一件事：把「若干帧 + 一句话」变成「这段视频发生了什么」。
 * 人设、记忆、最终回复交给 io，这里不碰 —— 职责混在一起以后没法单独换模型。
 *
 * 上游是阿里云 MaaS 网关（OpenAI 兼容），已实测可用的看图模型：
 *   qwen3.8-flash（最快）/ qwen4-max / qwen3.7-plus
 * qwen3.7-max、glm-5.3 不吃图片输入，会直接 400。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DIR = __dirname;
const HOST = '127.0.0.1';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// 密钥单独放 secrets.json（不进仓库），config.json 里只有非敏感项。
const CFG = Object.assign({
  port: 8769,
  gateway: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-flash',
  fallbackModel: 'qwen4-max',
  maxFrames: 16,
  frameMaxSide: 896,
  requestTimeoutMs: 180000,
  ffmpeg: 'C:\\Apps\\DSH-MultiTool\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  ytdlp: 'C:\\Apps\\DSH-MultiTool\\tools\\yt-dlp.exe',
  listenUrl: 'http://127.0.0.1:8771',
  hearAudio: true,
}, readJson(path.join(DIR, 'config.json'), {}));

const SECRETS = readJson(path.join(DIR, 'secrets.json'), {});
const API_KEY = process.env.QWEN_API_KEY || SECRETS.apiKey || '';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.join(DIR, '..', 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DIR, '..', 'logs', 'video.log'), line + '\n');
  } catch { }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024 * 1024) {
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

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e && e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

// ------------------------------------------------------------------ prompt --

function buildVideoPrompt(frameTimes, userText) {
  const stamps = frameTimes.map((t, i) => `第 ${i + 1} 帧：${t}`).join('\n');
  return [
    '你在看一段视频。下面按时间顺序给你若干帧画面，每帧都标了时间点。',
    stamps,
    userText ? `\n看视频的人说：${userText}` : '',
    '',
    // 这条很关键：不给它音轨，它却会自作主张说"没有声音"，等于用画面冒充听觉。
    '注意：你只拿到了画面帧，没有拿到音频。音轨由另一个模块单独处理。',
    '所以不要对"有没有声音""听没听到"下任何结论，也不要猜音效或配乐；只描述看得见的东西。',
    '看不清就说不确定，不要编。',
    '只输出 JSON：',
    '{"synopsis":"这段视频在讲什么，三句以内",',
    ' "timeline":[{"t":"时间点","what":"这一帧发生了什么"}],',
    ' "highlights":["最值得注意的事，1~3 条"],',
    ' "on_screen":"画面上能读到的关键文字，没有就空字符串"}',
  ].filter(Boolean).join('\n');
}

async function chatWithFrames(model, frames, userText) {
  const content = [{ type: 'text', text: buildVideoPrompt(frames.map((f) => f.t), userText) }];
  for (const f of frames) {
    content.push({ type: 'image_url', image_url: { url: f.dataUrl } });
  }
  const body = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: 1600,
    temperature: 0.3,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.requestTimeoutMs);
  try {
    const res = await fetch(`${CFG.gateway}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { }
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data && (data.error && data.error.message)) || text.slice(0, 300) };
    }
    const answer = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '') : '';
    return { ok: true, answer, usage: data.usage || null, model };
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(s);
    if (obj && (obj.synopsis || obj.timeline)) return obj;
  } catch { }
  return null;
}

async function analyzeFrames(frames, userText) {
  if (!frames || !frames.length) return { ok: false, error: 'no frames' };
  if (!API_KEY) return { ok: false, error: 'NO_API_KEY' };

  const trimmed = frames.slice(0, CFG.maxFrames);
  let r = await chatWithFrames(CFG.model, trimmed, userText);
  if (!r.ok && CFG.fallbackModel && CFG.fallbackModel !== CFG.model) {
    log(`model ${CFG.model} failed (${r.status} ${r.error}); trying ${CFG.fallbackModel}`);
    r = await chatWithFrames(CFG.fallbackModel, trimmed, userText);
  }
  if (!r.ok) return { ok: false, error: r.error, status: r.status };

  const structured = parseModelJson(r.answer);
  return {
    ok: true,
    model: r.model,
    usage: r.usage,
    frames: trimmed.length,
    structured,
    answer: r.answer,
    synopsis: structured ? structured.synopsis : '',
    timeline: structured ? structured.timeline : [],
    highlights: structured ? structured.highlights : [],
    onScreen: structured ? structured.on_screen : '',
  };
}

// --------------------------------------------------------------- url path ---

function ffmpegPath() {
  return fs.existsSync(CFG.ffmpeg) ? CFG.ffmpeg : null;
}

function ytdlpPath() {
  return fs.existsSync(CFG.ytdlp) ? CFG.ytdlp : null;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function probeDuration(file) {
  const ff = ffmpegPath();
  if (!ff) return 0;
  const r = await run(ff, ['-i', file], 30000);
  // ffmpeg 把媒体信息打在 stderr：Duration: 00:01:23.45
  const m = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 均匀取样：不追求覆盖每一秒，只要能把"这段视频发生了什么"讲清楚。 */
async function extractFrames(file, count) {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'FFMPEG_MISSING' };
  const duration = await probeDuration(file);
  if (!duration) return { ok: false, error: 'DURATION_UNKNOWN' };

  const n = Math.max(1, Math.min(CFG.maxFrames, Number(count) || 8));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const frames = [];
  for (let i = 0; i < n; i++) {
    // 取每段的中点，避开片头和片尾的空白
    const t = duration * (i + 0.5) / n;
    const out = path.join(outDir, `f${String(i).padStart(2, '0')}.jpg`);
    const r = await run(ff, [
      '-ss', String(t.toFixed(3)), '-i', file,
      '-frames:v', '1',
      '-vf', `scale='min(${CFG.frameMaxSide},iw)':-2`,
      '-q:v', '4', '-y', out,
    ], 60000);
    if (r.code === 0 && fs.existsSync(out)) {
      const b64 = fs.readFileSync(out).toString('base64');
      frames.push({ t: fmtTime(t), dataUrl: `data:image/jpeg;base64,${b64}` });
    }
  }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { }
  return { ok: frames.length > 0, frames, duration, error: frames.length ? undefined : 'NO_FRAME_EXTRACTED' };
}

async function downloadVideo(url) {
  const yt = ytdlpPath();
  const ff = ffmpegPath();
  if (!yt) return { ok: false, error: 'YTDLP_MISSING' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-dl-'));
  const args = [
    url,
    '-o', path.join(dir, 'video.%(ext)s'),
    '--no-playlist',
    '--no-warnings',
    '--max-filesize', '600M',
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
  ];
  if (ff) args.push('--ffmpeg-location', ff);
  const r = await run(yt, args, 600000);
  if (r.code !== 0) {
    return { ok: false, error: `YTDLP_FAILED: ${(r.stderr || '').split('\n').slice(-3).join(' ').slice(0, 300)}`, dir };
  }
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.part'));
  const file = files.map((f) => path.join(dir, f)).find((f) => fs.statSync(f).isFile());
  if (!file) return { ok: false, error: 'DOWNLOAD_EMPTY', dir };
  return { ok: true, file, dir };
}

/** 让听力模块听一遍这条音轨：转写 + 声音事件（响动/静音/持续背景声）。 */
async function hearAudio(file) {
  if (!CFG.hearAudio || !CFG.listenUrl) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  try {
    const res = await fetch(`${CFG.listenUrl}/v1/hear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: file }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      log('hear failed: ' + ((data && data.error) || res.status));
      return null;
    }
    return data;
  } catch (err) {
    log('hear error: ' + (err && err.message || err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 服务器本地文件：抽帧 + 听音轨 + 视觉分析。链接下载和浏览器上传都走这里。 */
async function analyzeLocalFile(file, userText, frameCount) {
  if (!fs.existsSync(file)) return { ok: false, error: 'FILE_NOT_FOUND' };
  const t0 = Date.now();
  const grab = await extractFrames(file, frameCount || 8);
  if (!grab.ok) return { ok: false, error: grab.error };

  // 删文件之前先听一遍（调用方负责删）
  const audio = await hearAudio(file);

  const result = await analyzeFrames(grab.frames, userText || '');
  result.duration = grab.duration;
  result.audio = audio;
  result.ms = Date.now() - t0;
  return result;
}

// ------------------------------------------------------------------ routes --

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/v1/health' || p === '/health')) {
      return json(res, 200, {
        ok: true,
        model: CFG.model,
        fallback: CFG.fallbackModel,
        hasKey: Boolean(API_KEY),
        ffmpeg: Boolean(ffmpegPath()),
        ytdlp: Boolean(ytdlpPath()),
      });
    }

    if (req.method === 'POST' && p === '/v1/analyze') {
      const body = JSON.parse(await readBody(req) || '{}');
      const frames = Array.isArray(body.frames) ? body.frames : [];
      const normalized = frames.map((f, i) => ({
        t: f.t || `${i}`,
        dataUrl: String(f.dataUrl || '').startsWith('data:') ? f.dataUrl : `data:image/jpeg;base64,${f.dataUrl || ''}`,
      })).filter((f) => f.dataUrl.length > 100);
      const result = await analyzeFrames(normalized, body.text || '');
      log(`analyze frames=${normalized.length} ok=${result.ok} model=${result.model || '-'}`);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && p === '/v1/analyze-url') {
      const body = JSON.parse(await readBody(req) || '{}');
      const link = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(link)) return json(res, 400, { ok: false, error: 'BAD_URL' });
      const t0 = Date.now();
      const dl = await downloadVideo(link);
      if (!dl.ok) {
        log(`analyze-url download failed: ${dl.error}`);
        return json(res, 200, { ok: false, error: dl.error });
      }
      const result = await analyzeLocalFile(dl.file, body.text || '', body.frames || 8);
      try { fs.rmSync(dl.dir, { recursive: true, force: true }); } catch { }
      result.ms = Date.now() - t0;
      log(`analyze-url ok=${result.ok} ms=${result.ms}`);
      return json(res, 200, result);
    }

    // 浏览器已把原片传上来（面板负责落盘和删除），这里只处理
    if (req.method === 'POST' && p === '/v1/analyze-file') {
      const body = JSON.parse(await readBody(req) || '{}');
      const file = String(body.filePath || '');
      if (!file) return json(res, 400, { ok: false, error: 'FILE_REQUIRED' });
      const result = await analyzeLocalFile(file, body.text || '', body.frames || 8);
      log(`analyze-file ok=${result.ok} file=${path.basename(file)} ms=${result.ms || 0}`);
      return json(res, 200, result);
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(CFG.port, HOST, () => {
  log(`video module on http://${HOST}:${CFG.port}  model=${CFG.model}  key=${API_KEY ? 'yes' : 'MISSING'}  ffmpeg=${Boolean(ffmpegPath())}  ytdlp=${Boolean(ytdlpPath())}`);
});
