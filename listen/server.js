'use strict';
/**
 * DSH-MultiTool :: listen module
 *
 * 只做一件事：音频 → 文字。识别在本机 Windows SAPI 里跑，不联网、不花 token。
 * 人设、上下文、回复内容交给 io，这里不碰。
 *
 * 数据流：
 *   POST /v1/transcribe { audioBase64, mime }
 *     → 写临时文件（os.tmpdir()/listen-XXXX）
 *     → 非规范 wav 时调 ffmpeg 转 16k/mono/pcm_s16le
 *     → powershell -File asr.ps1 -In x.wav -Out x.txt
 *     → 读回 UTF-8 文本，删临时目录，返回 { ok, text, ms, provider }
 *
 * 为什么文本走文件而不是 stdout：SYSTEM 账户下 PowerShell 5.1 的 stdout 是
 * OEM 代码页（cp936），中文经 Node 按 UTF-8 解码会变成乱码。写 UTF-8 文件稳。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DIR = __dirname;

function readJson(file, fallback) {
  // 去 BOM：PowerShell 的 Set-Content -Encoding UTF8、记事本都会写 U+FEFF，
  // JSON.parse 见到它就抛，整个 config 会静默回退到默认值（端口都变了）。
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

const CFG = Object.assign({
  port: 8771,
  host: '127.0.0.1',
  provider: 'windows-sapi',
  powershell: 'powershell.exe',
  asrScript: 'asr.ps1',
  ffmpeg: 'C:\\Apps\\DSH-MultiTool\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  recognizer: '',
  timeoutMs: 60000,
  maxAudioBytes: 32 * 1024 * 1024,
  sampleRate: 16000,
}, readJson(path.join(DIR, 'config.json'), {}));

const ASR_SCRIPT = path.isAbsolute(CFG.asrScript) ? CFG.asrScript : path.join(DIR, CFG.asrScript);
const HOST = CFG.host || '127.0.0.1';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.join(DIR, '..', 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DIR, '..', 'logs', 'listen.log'), line + '\n');
  } catch { }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' }));
        try { req.destroy(); } catch { }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** spawn + 收集输出 + 超时杀进程。超时用 timedOut 标记，调用方据此报 TIMEOUT。 */
function run(cmd, args, timeoutMs, binary) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err), timedOut: false });
      return;
    }
    // binary=true 时 stdout 是 PCM 字节流，绝不能用 toString('utf8') 接（会毁掉样本）
    let out = binary ? [] : '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Windows 上 SIGKILL 落到 TerminateProcess，powershell 一定被杀掉。
      try { child.kill('SIGKILL'); } catch { }
      // 兜底：某些情况下 close 迟迟不来，自己也收敛。
      setTimeout(() => finish({ code: -1, stdout: binary ? Buffer.concat(out) : out, stderr: err, timedOut }), 2000);
    }, Math.max(0, timeoutMs));
    child.stdout.on('data', (d) => { if (binary) out.push(d); else out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const payload = () => (binary ? Buffer.concat(out) : out);
    child.on('error', (e) => finish({ code: -1, stdout: payload(), stderr: String(e && e.message || e), timedOut }));
    child.on('close', (code) => finish({ code, stdout: payload(), stderr: err, timedOut }));
  });
}

function tail(text, max = 240) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(-max) : s;
}

function ffmpegPath() {
  return fs.existsSync(CFG.ffmpeg) ? CFG.ffmpeg : null;
}

// ------------------------------------------------------------------- audio --

const MIME_EXT = {
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'video/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/amr': '.amr',
  'audio/opus': '.opus',
  'audio/3gpp': '.3gp',
};

function normalizeMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/** 看文件头判断真实容器，比 mime 可靠（浏览器常把 webm 报成 video/webm）。 */
function sniffExt(buf) {
  if (!buf || buf.length < 12) return '';
  const ascii = (start, len) => buf.toString('latin1', start, start + len);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return '.wav';
  if (ascii(0, 4) === 'OggS') return '.ogg';
  if (ascii(0, 4) === 'fLaC') return '.flac';
  if (ascii(0, 3) === 'ID3') return '.mp3';
  if (ascii(4, 4) === 'ftyp') return '.m4a';
  if (ascii(0, 4) === '#!AMR') return '.amr';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';
  return '';
}

function base64ToBuffer(text) {
  let s = String(text || '').trim();
  const dataUrl = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(s);
  let mime = '';
  if (dataUrl) {
    mime = dataUrl[1];
    s = s.slice(dataUrl[0].length);
  }
  s = s.replace(/\s+/g, '');
  if (!s) return { ok: false, error: 'EMPTY_AUDIO' };
  if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) return { ok: false, error: 'BAD_BASE64' };
  let buf;
  try { buf = Buffer.from(s, 'base64'); } catch { return { ok: false, error: 'BAD_BASE64' }; }
  if (!buf || buf.length < 44) return { ok: false, error: 'AUDIO_TOO_SHORT' };
  return { ok: true, buf, mime };
}

/** 读 wav 的 fmt 块：SAPI 只吃 PCM，且已规范成 16k/mono/16bit 时就不用再转。 */
function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 8 + 16 <= buf.length) {
      const base = offset + 8;
      return {
        format: buf.readUInt16LE(base),
        channels: buf.readUInt16LE(base + 2),
        sampleRate: buf.readUInt32LE(base + 4),
        bits: buf.readUInt16LE(base + 14),
      };
    }
    if (size <= 0 || size > buf.length) break;
    offset += 8 + size + (size % 2);
  }
  return null;
}

function isCanonicalWav(info) {
  return Boolean(info && info.format === 1 && info.channels === 1 &&
    info.sampleRate === Number(CFG.sampleRate) && info.bits === 16);
}

async function toWav(inputFile, buf, deadline) {
  const ff = ffmpegPath();
  const raw = wavInfo(buf);
  if (!ff) {
    // 没有 ffmpeg 时只能寄希望于 SAPI 自己认；wav 直通，其它格式注定失败。
    if (raw) return { ok: true, file: inputFile, converted: false };
    return { ok: false, error: 'FFMPEG_MISSING' };
  }
  if (isCanonicalWav(raw)) return { ok: true, file: inputFile, converted: false };

  // 固定写 norm.wav：不能按「换扩展名」推输出名，48k 立体声 wav 会让 in.wav
  // 撞上 out.wav同名输入，ffmpeg 直接拒绝（same as Input #0）。
  const out = path.join(path.dirname(inputFile), 'norm.wav');
  const budget = Math.min(deadline - Date.now(), 30000);
  if (budget <= 500) return { ok: false, error: 'TIMEOUT' };
  const r = await run(ff, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', inputFile,
    '-ar', String(CFG.sampleRate || 16000), '-ac', '1',
    '-acodec', 'pcm_s16le', '-f', 'wav', '-y', out,
  ], budget);
  if (r.timedOut) return { ok: false, error: 'TIMEOUT' };
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 44) {
    return { ok: false, error: 'FFMPEG_FAILED: ' + tail(r.stderr || r.stdout) };
  }
  return { ok: true, file: out, converted: true };
}

// ------------------------------------------------------------- recognizers --

let recognizers = [];
let recognizerError = null;
let lastProbe = 0;

function parseJsonLoose(text) {
  const s = String(text || '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

async function probeRecognizers(force) {
  if (!force && recognizers.length && Date.now() - lastProbe < 60000) return recognizers;
  if (!force && Date.now() - lastProbe < 5000) return recognizers; // 别把失败查询打成风暴
  lastProbe = Date.now();
  const r = await run(CFG.powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ASR_SCRIPT, '-List',
  ], 30000);
  if (r.timedOut) {
    recognizerError = 'LIST_TIMEOUT';
    return recognizers;
  }
  if (r.code !== 0) {
    recognizerError = 'LIST_FAILED: ' + tail(r.stderr || r.stdout);
    recognizers = [];
    return recognizers;
  }
  const data = parseJsonLoose(r.stdout);
  if (!Array.isArray(data)) {
    recognizerError = 'LIST_UNPARSABLE';
    return recognizers;
  }
  recognizers = data.filter((x) => x && x.id);
  recognizerError = recognizers.length ? null : 'NO_RECOGNIZER_INSTALLED';
  return recognizers;
}

// ------------------------------------------------------------------ transcribe --

async function transcribe(buf, mime) {
  const t0 = Date.now();
  const deadline = t0 + Number(CFG.timeoutMs || 60000);
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-'));
    const mimeExt = MIME_EXT[normalizeMime(mime)] || '';
    const ext = sniffExt(buf) || mimeExt || '.bin';
    const inputFile = path.join(dir, 'in' + ext);
    fs.writeFileSync(inputFile, buf);

    const wav = await toWav(inputFile, buf, deadline);
    if (!wav.ok) {
      return { ok: false, error: wav.error, ms: Date.now() - t0, provider: CFG.provider };
    }

    const outTxt = path.join(dir, 'out.txt');
    const budget = Math.min(deadline - Date.now(), Number(CFG.timeoutMs || 60000));
    if (budget <= 500) {
      return { ok: false, error: 'TIMEOUT', ms: Date.now() - t0, provider: CFG.provider };
    }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ASR_SCRIPT, '-In', wav.file, '-Out', outTxt];
    if (CFG.recognizer) args.push('-Recognizer', String(CFG.recognizer));
    const r = await run(CFG.powershell, args, budget);
    if (r.timedOut) {
      return { ok: false, error: 'TIMEOUT', ms: Date.now() - t0, provider: CFG.provider };
    }
    if (r.code !== 0) {
      return {
        ok: false,
        error: 'ASR_FAILED: ' + tail(r.stderr || r.stdout),
        ms: Date.now() - t0,
        provider: CFG.provider,
      };
    }

    let text = '';
    try {
      text = fs.readFileSync(outTxt, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch (err) {
      return {
        ok: false,
        error: 'NO_RESULT_FILE: ' + String(err && err.message || err),
        ms: Date.now() - t0,
        provider: CFG.provider,
      };
    }
    const meta = parseJsonLoose(r.stdout) || {};
    return {
      ok: true,
      text,
      ms: Date.now() - t0,
      provider: CFG.provider,
      segments: Number(meta.segments || 0),
      confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
      recognizer: meta.recognizer || '',
      source: ext.replace('.', '') || 'unknown',
      converted: Boolean(wav.converted),
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err && err.message || err),
      ms: Date.now() - t0,
      provider: CFG.provider,
    };
  } finally {
    // 处理完立刻删，别让服务器磁盘堆临时 wav。
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  }
}

// ---------------------------------------------------------------- hear ------
// "听"不只是转写：视频里的声音还包括音乐、撞击、环境音。这里用 ffmpeg 抽音轨，
// 按窗口算能量（dBFS），把静音段/突然的响动/持续背景声找出来，再和 ASR 文本合并。

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

async function extractAudio(inputFile, outWav, deadline, maxSeconds) {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'FFMPEG_MISSING' };
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputFile, '-vn'];
  if (maxSeconds > 0) args.push('-t', String(maxSeconds));
  args.push('-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', outWav);
  const r = await run(ff, args, Math.max(5000, deadline - Date.now()));
  if (r.timedOut) return { ok: false, error: 'FFMPEG_TIMEOUT' };
  if (r.code !== 0 || !fs.existsSync(outWav)) {
    return { ok: false, error: 'FFMPEG_FAILED: ' + tail(r.stderr || r.stdout) };
  }
  return { ok: true, file: outWav };
}

/** 逐窗口 RMS（dBFS）。直接从 ffmpeg 管道拿 8k 单声道 s16le，自己算，不依赖解析文本。 */
async function energyProfile(wavFile, windowSec, deadline) {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'FFMPEG_MISSING' };
  const rate = 8000;
  const per = Math.max(0.1, Number(windowSec) || 0.25);
  const chunkSamples = Math.max(1, Math.round(rate * per));

  const r = await run(ff, [
    '-hide_banner', '-loglevel', 'error', '-i', wavFile,
    '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1',
  ], Math.max(5000, deadline - Date.now()), true);

  if (r.timedOut) return { ok: false, error: 'FFMPEG_TIMEOUT' };
  if (r.code !== 0 || !r.stdout) return { ok: false, error: 'PCM_EMPTY' };

  const buf = r.stdout;
  const total = Math.floor(buf.length / 2 / chunkSamples);
  const segments = [];
  for (let i = 0; i < total; i++) {
    let sum = 0;
    const start = i * chunkSamples * 2;
    for (let j = 0; j < chunkSamples; j++) {
      const v = buf.readInt16LE(start + j * 2);
      sum += v * v;
    }
    const rms = Math.sqrt(sum / chunkSamples);
    const db = rms <= 0 ? -100 : 20 * Math.log10(rms / 32768);
    segments.push({ t: Number((i * per).toFixed(2)), db: Number(db.toFixed(1)) });
  }
  return { ok: true, segments, duration: total * per, windowSec: per };
}

/** 把能量曲线翻译成"听到了什么"。所有推断性结论都带"像"，不装成事实。 */
function describeAudio(profile, transcript, truncated) {
  const segs = profile.segments || [];
  if (!segs.length) return { events: [], summary: '没听到任何声音（整段静音）', speechSeconds: 0 };

  const SILENT = -45;
  const LOUD = -18;
  const events = [];
  const parts = [];

  let quiet = 0;
  let loudCount = 0;
  let runStart = null;
  let runPeak = -100;

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.db < SILENT) quiet++;
    if (s.db > LOUD) loudCount++;

    // 突然的响动：相对上一窗口跳升 ≥12dB 且足够响
    const prev = i > 0 ? segs[i - 1].db : s.db;
    if (s.db > LOUD && s.db - prev >= 12) {
      events.push({ t: fmtSec(s.t), kind: 'sudden', desc: '音量突然变大到 ' + s.db + ' dB（像撞击、爆响或突然的呼喊）' });
    }

    // 持续有声段：连续非静音且音量不低
    if (s.db >= SILENT) {
      if (runStart === null) { runStart = s.t; runPeak = s.db; }
      else if (s.db > runPeak) runPeak = s.db;
    } else if (runStart !== null) {
      if (s.t - runStart >= 3) {
        events.push({ t: fmtSec(runStart) + '-' + fmtSec(s.t), kind: 'sustained', desc: '持续有声约 ' + Math.round(s.t - runStart) + ' 秒（峰值 ' + runPeak + ' dB）' });
      }
      runStart = null;
    }
  }
  if (runStart !== null && segs[segs.length - 1].t - runStart >= 3) {
    const last = segs[segs.length - 1];
    events.push({ t: fmtSec(runStart) + '-' + fmtSec(last.t), kind: 'sustained', desc: '持续有声约 ' + Math.round(last.t - runStart) + ' 秒（峰值 ' + runPeak + ' dB）' });
  }

  const activeSeconds = Math.round((segs.length - quiet) * (profile.windowSec || 0.25));
  const totalSeconds = Math.round(profile.duration || 0);

  parts.push('全长约 ' + totalSeconds + ' 秒，其中 ' + activeSeconds + ' 秒有声音');
  if (quiet === segs.length) parts.push('整段基本静音');
  else if (quiet > segs.length * 0.6) parts.push('大部分时间是安静/静音');

  if (transcript && transcript.length >= 4) {
    parts.push('听得到人说话');
  } else if (transcript) {
    // 只有"阿""嗯"这类语气词，不能算"有人在说话"
    parts.push('只有零星的人声/语气词');
  } else if (activeSeconds >= Math.max(3, totalSeconds * 0.5)) {
    parts.push('一直有声音但没听出成句的人话（更像配乐、环境音或噪音）');
  }

  if (loudCount > segs.length * 0.2) parts.push('整体偏吵（大量窗口超过 ' + LOUD + ' dB）');
  if (truncated) parts.push('（只听了前 ' + totalSeconds + ' 秒）');

  // 同类事件太多就收成一条，别把时间线撑爆
  const sudden = events.filter((e) => e.kind === 'sudden');
  if (sudden.length > 6) {
    events.length = 0;
    events.push({ t: '-', kind: 'sudden', desc: '有 ' + sudden.length + ' 次明显响动（首次在 ' + sudden[0].t + '）' });
  }

  return { events: events.slice(0, 12), summary: parts.join('；'), speechSeconds: transcript ? activeSeconds : 0 };
}

// ------------------------------------------------------------------- routes --

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/v1/health' || p === '/health')) {
      const list = await probeRecognizers(false);
      const healthy = Boolean(fs.existsSync(ASR_SCRIPT)) && list.length > 0;
      return json(res, 200, {
        ok: healthy,
        provider: CFG.provider,
        recognizers: list,
        ffmpeg: Boolean(ffmpegPath()),
        port: Number(CFG.port),
        timeoutMs: Number(CFG.timeoutMs),
        error: healthy ? undefined : (recognizerError || 'NO_RECOGNIZER_INSTALLED'),
      });
    }

    if (req.method === 'POST' && p === '/v1/transcribe') {
      const t0 = Date.now();
      const raw = await readBody(req, Number(CFG.maxAudioBytes || 32 * 1024 * 1024));
      let body = {};
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'BAD_JSON' });
      }
      const b64 = body.audioBase64 || body.audio || body.base64 || '';
      const decoded = base64ToBuffer(b64);
      if (!decoded.ok) {
        log(`transcribe rejected: ${decoded.error}`);
        return json(res, 200, { ok: false, error: decoded.error, ms: Date.now() - t0, provider: CFG.provider });
      }
      const mime = body.mime || decoded.mime || '';
      const result = await transcribe(decoded.buf, mime);
      log(`transcribe bytes=${decoded.buf.length} mime=${normalizeMime(mime) || '-'} ` +
        `ok=${result.ok} ms=${result.ms} chars=${(result.text || '').length} ` +
        `${result.ok ? '' : 'error=' + result.error}`);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && p === '/v1/hear') {
      const t0 = Date.now();
      const raw = await readBody(req, Number(CFG.maxAudioBytes || 32 * 1024 * 1024));
      let body = {};
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'BAD_JSON' });
      }

      let dir = null;
      let sourceFile = '';
      try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-hear-'));
        if (body.filePath) {
          sourceFile = String(body.filePath);
          if (!fs.existsSync(sourceFile)) {
            return json(res, 200, { ok: false, error: 'FILE_NOT_FOUND', ms: Date.now() - t0 });
          }
        } else {
          const decoded = base64ToBuffer(body.audioBase64 || body.audio || '');
          if (!decoded.ok) {
            return json(res, 200, { ok: false, error: decoded.error, ms: Date.now() - t0 });
          }
          const ext = sniffExt(decoded.buf) || MIME_EXT[normalizeMime(body.mime)] || '.bin';
          sourceFile = path.join(dir, 'src' + ext);
          fs.writeFileSync(sourceFile, decoded.buf);
        }

        const deadline = t0 + Math.max(30000, Number(CFG.hearTimeoutMs || 180000));
        const maxSeconds = Number(CFG.maxHearSeconds || 180);
        const wavFile = path.join(dir, 'audio.wav');
        const ex = await extractAudio(sourceFile, wavFile, deadline, maxSeconds);
        if (!ex.ok) {
          log(`hear extract failed: ${ex.error}`);
          return json(res, 200, { ok: false, error: ex.error, ms: Date.now() - t0 });
        }

        // 有没有超过截断上限（拿 wav 时长判断）
        let truncated = false;
        try {
          const info = wavInfo(fs.readFileSync(wavFile));
          const dur = info && info.dataBytes ? info.dataBytes / (info.byteRate || 32000) : 0;
          truncated = dur >= maxSeconds - 1.5;
        } catch { }

        const prof = await energyProfile(wavFile, Number(CFG.hearWindowSec || 0.25), deadline);
        if (!prof.ok) {
          return json(res, 200, { ok: false, error: prof.error, ms: Date.now() - t0 });
        }

        let asr = { ok: false, text: '' };
        try {
          const buf = fs.readFileSync(wavFile);
          asr = await transcribe(buf, 'audio/wav');
        } catch { }

        const desc = describeAudio(prof, (asr.text || '').trim(), truncated);
        const result = {
          ok: true,
          ms: Date.now() - t0,
          provider: CFG.provider,
          duration: Math.round(prof.duration),
          truncated,
          transcript: (asr.text || '').trim(),
          speechOk: Boolean(asr.ok),
          confidence: typeof asr.confidence === 'number' ? asr.confidence : null,
          segments: prof.segments.length,
          events: desc.events,
          summary: desc.summary,
          // 抽稀后的曲线，给前端画个波形用（每 2 秒一个点）
          levels: (() => {
            const step = Math.max(1, Math.round(2 / (prof.windowSec || 0.25)));
            const out = [];
            for (let i = 0; i < prof.segments.length; i += step) out.push(prof.segments[i].db);
            return out;
          })(),
        };
        log(`hear ok dur=${result.duration}s events=${result.events.length} chars=${result.transcript.length} ms=${result.ms}`);
        return json(res, 200, result);
      } finally {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
      }
    }

    if (req.method === 'GET' && (p === '/v1/recognizers' || p === '/recognizers')) {
      const list = await probeRecognizers(true);
      return json(res, 200, { ok: list.length > 0, recognizers: list, error: recognizerError || undefined });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      log('transcribe rejected: BODY_TOO_LARGE');
      return json(res, 413, { ok: false, error: 'BODY_TOO_LARGE' });
    }
    log('ERROR ' + (err && err.stack || err));
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.on('error', (err) => {
  log('SERVER_ERROR ' + (err && err.stack || err));
  process.exit(1);
});

server.listen(Number(CFG.port), HOST, async () => {
  log(`listen module on http://${HOST}:${CFG.port}  provider=${CFG.provider}  ` +
    `asr=${fs.existsSync(ASR_SCRIPT) ? 'ok' : 'MISSING'}  ffmpeg=${ffmpegPath() ? 'ok' : 'MISSING'}`);
  const list = await probeRecognizers(true);
  log(`recognizers=${list.map((r) => `${r.id}(${r.culture})`).join(',') || 'NONE'} err=${recognizerError || '-'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, exiting`);
    try { server.close(() => process.exit(0)); } catch { process.exit(0); }
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
