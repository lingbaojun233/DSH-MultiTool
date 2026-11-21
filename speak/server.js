'use strict';
/**
 * DSH-MultiTool :: speak module（发声）
 *
 * 把一段文字合成为语音，返回 wav。默认走 Windows SAPI（离线、免 key、中文女声 Huihui）。
 *
 * 为什么不是 qwen：MaaS token-plan 网关虽然把 qwen-audio-3.0-tts-plus 列在 /models 里，
 * 但 /audio/speech 一律回 "url error, please check url" —— 那个网关没给音频模型配可路由上游。
 * 一旦拿到可用路由，把 config.json 的 provider 改成 "qwen" 并填上 gateway 即可（见 README）。
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIR = __dirname;
const HOST = '127.0.0.1';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const CFG = Object.assign({
  port: 8770,
  provider: 'piper',         // piper（huayan，音质最好）| winrt（Yaoyao/Huihui/Kangkang）| sapi | qwen
  voice: 'huayan',
  rate: -1,
  maxChars: 300,
  gateway: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  qwenModel: 'qwen-audio-3.0-tts-plus',
  requestTimeoutMs: 60000,
  piperExe: 'C:\\Apps\\DSH-MultiTool\\tools\\piper\\piper.exe',
  piperDir: 'C:\\Apps\\DSH-MultiTool\\tools\\piper',
}, readJson(path.join(DIR, 'config.json'), {}));

/**
 * 音色表：名字 → 用哪个引擎、哪个模型。
 * 让面板/调用方按名字点单，不用关心底下是 piper 还是 WinRT。
 */
function voiceTable() {
  const p = CFG.piperDir;
  return {
    huayan: { engine: 'piper', model: `${p}\\models\\huayan\\zh_CN-huayan-medium.onnx`, config: `${p}\\models\\huayan\\zh_CN-huayan-medium.onnx.json` },
    'huayan-fast': { engine: 'piper', model: `${p}\\models\\x_low\\zh_CN-huayan-x_low.onnx`, config: `${p}\\models\\x_low\\zh_CN-huayan-x_low.onnx.json` },
    yaoyao: { engine: 'winrt', match: 'Yaoyao' },
    huihui: { engine: 'winrt', match: 'Huihui' },
    kangkang: { engine: 'winrt', match: 'Kangkang' },
  };
}

function resolveVoice(name) {
  const table = voiceTable();
  const key = String(name || CFG.voice || 'huayan').toLowerCase();
  if (table[key]) return { name: key, ...table[key] };
  // 认不出来就退回默认，别让调用直接失败
  const fallback = table[String(CFG.voice || 'huayan').toLowerCase()] || table.huayan;
  return { name: CFG.voice || 'huayan', ...fallback };
}

const OUT_DIR = path.join(DIR, 'out');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.join(DIR, '..', 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DIR, '..', 'logs', 'speak.log'), line + '\n');
  } catch { }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 2 * 1024 * 1024) {
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

/**
 * 念出来之前先洗一遍：Markdown、颜文字、表情符号念出来都是噪音。
 * 人格里写着"语音只说出口的话"，这条规则在这里落地。
 */
function cleanForSpeech(raw) {
  let t = String(raw || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/[*#>|]/g, ' ');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  t = t.replace(/[(（][^)）]{0,12}[)）]/g, (m) => (/[\u3040-\u30ff\u4e00-\u9fff]/.test(m) ? m : ' '));
  t = t.replace(/\s{2,}/g, ' ').trim();
  if (t.length > CFG.maxChars) t = t.slice(0, CFG.maxChars);
  return t;
}

function runPowerShellScript(scriptName, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, scriptName), ...args],
      { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); });
  });
}

function runPowerShell(args, timeoutMs) {
  return runPowerShellScript('speak.ps1', args, timeoutMs);
}

/** OneCore 音色（WinRT）。比 SAPI 多出 Yaoyao 这类音色，音质也更新。 */
async function synthesizeWinRt(text, voice) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const txtFile = path.join(OUT_DIR, `t-${stamp}.txt`);
  const wavFile = path.join(OUT_DIR, `s-${stamp}.wav`);
  fs.writeFileSync(txtFile, text, 'utf8');
  try {
    const args = ['-InFile', txtFile, '-OutFile', wavFile, '-VoiceMatch', voice || 'Yaoyao'];
    const r = await runPowerShellScript('tts-winrt.ps1', args, CFG.requestTimeoutMs);
    if (r.code !== 0 || !fs.existsSync(wavFile)) {
      return { ok: false, error: (r.stderr || r.stdout || 'WINRT_FAILED').slice(0, 400) };
    }
    let info = {};
    try { info = JSON.parse(r.stdout.split('\n').filter(Boolean).pop()); } catch { }
    return { ok: true, file: wavFile, info, provider: 'winrt' };
  } finally {
    try { fs.unlinkSync(txtFile); } catch { }
  }
}

async function synthesizeWindows(text, voice, rate) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const txtFile = path.join(OUT_DIR, `t-${stamp}.txt`);
  const wavFile = path.join(OUT_DIR, `s-${stamp}.wav`);
  fs.writeFileSync(txtFile, text, 'utf8');
  try {
    const args = ['-InFile', txtFile, '-OutFile', wavFile, '-Rate', String(rate)];
    if (voice) args.push('-Voice', voice);
    const r = await runPowerShell(args, CFG.requestTimeoutMs);
    if (r.code !== 0 || !fs.existsSync(wavFile)) {
      return { ok: false, error: (r.stderr || r.stdout || 'SAPI_FAILED').slice(0, 400) };
    }
    let info = {};
    try { info = JSON.parse(r.stdout.split('\n').filter(Boolean).pop()); } catch { }
    return { ok: true, file: wavFile, info, provider: 'windows' };
  } finally {
    try { fs.unlinkSync(txtFile); } catch { }
  }
}

/** 只在拿到可路由的音频上游后才启用；现在调用会明确报错，而不是假装成功。 */
async function synthesizeQwen() {
  return {
    ok: false,
    error: 'QWEN_AUDIO_NOT_ROUTED：该网关的音频模型没有可路由上游（/audio/speech 返回 url error）。改 config.provider="windows" 或换用可用的音频端点。',
  };
}

/** Piper（离线、CPU、huayan 音色）。文本走 stdin，必须 UTF-8 无 BOM + \n。 */
async function synthesizePiper(text, voice) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const wavFile = path.join(OUT_DIR, `p-${stamp}.wav`);
  const args = [
    '--model', voice.model,
    '--config', voice.config,
    '--output_file', wavFile,
    '--length_scale', '1.0',
    '--noise_scale', '0.667',
    '--noise_w', '0.8',
    '--sentence_silence', '0.2',
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CFG.piperExe, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: 'PIPER_SPAWN: ' + (err && err.message || err) });
      return;
    }
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, CFG.requestTimeoutMs);
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'PIPER_ERROR: ' + (e && e.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exists = fs.existsSync(wavFile);
      if (code !== 0 || !exists || fs.statSync(wavFile).size < 1000) {
        resolve({ ok: false, error: `PIPER_FAILED(code=${code}): ${err.slice(0, 300)}` });
        return;
      }
      resolve({ ok: true, file: wavFile, provider: 'piper', info: { voice: voice.name || 'huayan' } });
    });
    try {
      // 只送一行；末尾的换行是 piper 判定"这一句结束"的依据
      child.stdin.write(text + '\n', 'utf8');
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: 'PIPER_STDIN: ' + (e && e.message || e) });
    }
  });
}

async function synthesize(text, voice, rate) {
  const picked = resolveVoice(voice);
  if (picked.engine === 'piper') return synthesizePiper(text, picked);
  if (picked.engine === 'winrt') return synthesizeWinRt(text, picked.match);
  if (CFG.provider === 'qwen') return synthesizeQwen(text, voice, rate);
  return synthesizeWindows(text, voice, rate);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/v1/health' || p === '/health')) {
      return json(res, 200, {
        ok: true,
        provider: CFG.provider,
        voice: CFG.voice || 'auto',
        voices: Object.keys(voiceTable()),
        piper: fs.existsSync(CFG.piperExe),
        rate: CFG.rate,
        scripts: {
          winrt: fs.existsSync(path.join(DIR, 'tts-winrt.ps1')),
          sapi: fs.existsSync(path.join(DIR, 'speak.ps1')),
        },
      });
    }

    // 返回 wav 字节，方便 <audio> 直接播
    if (req.method === 'POST' && p === '/v1/speak') {
      const body = JSON.parse(await readBody(req) || '{}');
      const text = cleanForSpeech(body.text);
      if (!text) return json(res, 400, { ok: false, error: 'EMPTY_TEXT' });
      const r = await synthesize(text, body.voice || CFG.voice, Number.isFinite(body.rate) ? body.rate : CFG.rate);
      if (!r.ok) {
        log(`speak failed: ${r.error}`);
        return json(res, 200, { ok: false, error: r.error });
      }
      const buf = fs.readFileSync(r.file);
      try { fs.unlinkSync(r.file); } catch { }
      log(`speak ok chars=${text.length} bytes=${buf.length} ms=${(r.info && r.info.ms) || '-'}`);
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'x-speak-voice': String((r.info && r.info.voice) || ''),
        'x-speak-ms': String((r.info && r.info.ms) || ''),
      });
      return res.end(buf);
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(CFG.port, HOST, () => {
  log(`speak module on http://${HOST}:${CFG.port}  provider=${CFG.provider}  voice=${CFG.voice || 'auto'}`);
});
