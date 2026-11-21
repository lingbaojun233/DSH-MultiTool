'use strict';
/**
 * DSH-MultiTool :: speak module（发声）
 *
 * 把一段文字合成为语音，返回 wav。
 *   provider=breezeblue  云端 BreezeBlue，音色由记忆模块的人设决定（默认，也是唯一推荐的路径）
 *   provider=piper       离线 huayan（strict=false 时的回退）
 *   provider=winrt       Yaoyao/Huihui/Kangkang
 *
 * ------------------------------------------------------------------ strict 模式
 * config.strict = true（默认）时本模块**只用 BreezeBlue 发声**：
 *   云端 429 / 5xx / 超时 / 网络错误 → 按 config.breezeblue.retry.backoffMs（默认 1s,2s,4s,8s）
 *   退避重试，最多 maxAttempts 次（默认 4）；仍失败 → HTTP 503 +
 *   {ok:false, error:'BREEZEBLUE_UNAVAILABLE', attempts, lastError}，**不返回任何替代音频**。
 *   这样视频模块能明确区分"这段声音是真人念的"和"没拿到"，而不是掺进一个不同音色。
 * config.strict = false 时保持老行为：失败静默回退 piper huayan，并带 x-speak-fallback-from: breezeblue。
 *
 * 单次请求可用 body.strict / ?strict=0|1 覆盖 config（视频模块可按镜头要求），默认取 config。
 *
 * ------------------------------------------------------------------ 并发
 * 实测 BreezeBlue 的 Starter 档**并发上限是 1**：同时发 4 句，1 成功、3 个 429
 * GENERATION_CONCURRENCY_EXCEEDED。所以云端合成一律进本进程的串行队列
 * （config.breezeblue.maxConcurrency，默认 1；maxDepth 默认 64，排队超时 queueTimeoutMs）。
 * 队列只包住"请求云端 + ffmpeg 转封装"，人设音色解析走缓存、不进队列。
 *
 * ------------------------------------------------------------------ 计费
 * 每句合成前后各读一次 /v1/balance（30s 缓存，避免每句多打一个请求），
 * 把 creditsBefore / creditsAfter / creditsSpent 写进 logs/speak.log。
 * 注意：BreezeBlue 是 60 秒批量结算（settlement_interval_seconds=60），
 * 实测 charge 在调用后 ~29s 才出现在账本里，所以**立刻读到的 creditsSpent 常常是 0**。
 * 因此另外做了一层账本对齐：进程每 60s 拉一次 balance，把新出现的 charge 按字符数匹配回
 * 对应的那句，算出真实 credits（日志里的 settled=，以及 GET /v1/usage 的 recentCalls）。
 * GET /v1/usage 给出本进程累计 calls / chars / credits / fallbacks / failures。
 *
 * ------------------------------------------------------------------ 音色
 * 音色不写死：GET /v1/voice 读 /v1/persona，按人设（gender/age/tone）从 zh 音色池打分挑一个，
 * 按 version 缓存到 data/speak/persona-voice.json；人设版本一变就重选。
 * GET /v1/voices?zh=1 给前端下拉（id + 名字 + 打分维度）；POST /v1/voice {voiceId} 人工钉住。
 * voice 合法值：'' / 'auto' / 'persona' / 'default'（= 人设决定）、'breezeblue' / 'cloud'（= 云端默认音色）、
 * 'voc_xxx'（指定云端音色）、huayan / huayan-fast / yaoyao / huihui / kangkang（显式点名本地引擎）。
 *
 * 为什么不是 qwen：MaaS token-plan 网关虽然把 qwen-audio-3.0-tts-plus 列在 /models 里，
 * 但 /audio/speech 一律回 "url error, please check url" —— 那个网关没给音频模型配可路由上游。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIR = __dirname;
const HOST = '127.0.0.1';
/** 部署/测试时可以用 DSH_SPEAK_CONFIG 指向另一份 config.json（默认读同目录 config.json）。 */
const CONFIG_FILE = process.env.DSH_SPEAK_CONFIG
  ? path.resolve(process.env.DSH_SPEAK_CONFIG)
  : path.join(DIR, 'config.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const personaVoice = require('./lib/persona-voice');

/** 深合并：config.json 只写想改的键，嵌套块（breezeblue/personaVoice）不会被整体顶掉。 */
function mergeDeep(base, override) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)
      && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const CFG = mergeDeep({
  port: 8770,
  provider: 'breezeblue',    // breezeblue（云端，音色由人设决定）| piper | winrt | sapi | qwen
  voice: '',
  rate: -1,
  maxChars: 300,
  /** true = 只用 BreezeBlue：失败重试后返回 503，绝不回退 huayan。false = 老行为（回退 huayan）。 */
  strict: true,
  /** strict 下是否仍允许调用方显式点名本地音色（huayan/yaoyao…）。显式不是"静默替换"，默认允许；设为 false 则彻底关死本地引擎。 */
  strictAllowExplicitLocal: true,
  /** 日志文件。默认 ../logs/speak.log（模块目录之外，push 覆盖 speak\ 时不会丢）。 */
  logFile: '',
  gateway: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  qwenModel: 'qwen-audio-3.0-tts-plus',
  requestTimeoutMs: 60000,
  piperExe: 'C:\\Apps\\DSH-MultiTool\\tools\\piper\\piper.exe',
  piperDir: 'C:\\Apps\\DSH-MultiTool\\tools\\piper',
  breezeblue: {
    base: 'https://api.breeze.blue',
    keyPath: 'C:\\Apps\\DSH-MultiTool\\secrets\\breezeblue.key',
    voiceId: 'voc_cc9mhfrqw4z2',
    model: '',
    outputFormat: 'wav',
    timeoutMs: 120000,
    ffmpegExe: 'C:\\Apps\\DSH-MultiTool\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    sampleRate: 22050,
    voicesCacheFile: '',
    voicesTtlMs: 604800000,
    /** 实测 0.185~0.19 credits/字（22 字 = 4.2）。只用于"估算"字段，真实值以账本为准。 */
    creditsPerChar: 0.185,
    /** 云端并发上限实测为 1，必须串行。 */
    maxConcurrency: 1,
    /** 队列最多排多少人；再多就 503 QUEUE_FULL，避免无限堆积把超时拖到几分钟。 */
    queueMax: 64,
    /** 排队等多久算超时（毫秒）。一集 8 句串行约 40~70s，留足余量。 */
    queueTimeoutMs: 180000,
    retry: {
      /** 总尝试次数（含首次）。4 = 首跑 + 3 次重试，等待序列 1s,2s,4s。 */
      maxAttempts: 4,
      /** 每次重试前等多久（第 i 次重试用 backoffMs[i-1]）。 */
      backoffMs: [1000, 2000, 4000, 8000],
      /** 这些状态码视为可重试（429 = 并发/容量，5xx = 上游抖动）。 */
      retryStatus: [408, 429, 500, 502, 503, 504],
      /** 网络错误/超时也重试。 */
      retryOnNetwork: true,
    },
    /** 余额缓存 30 秒：别每句都打 /v1/balance。 */
    balanceTtlMs: 30000,
    /** 合成完之后那次余额读取：缓存超过这个岁数就强制刷新（相当于"尽力拿最新值"）。 */
    balanceAfterMaxAgeMs: 5000,
    balanceTimeoutMs: 15000,
  },
  personaVoice: {
    memoryUrl: 'http://127.0.0.1:8767',
    cacheFile: '',
    language: 'zh',
    useModel: false,
    ioUrl: 'http://127.0.0.1:8765',
    internalTokenPath: 'C:\\Apps\\DSH-MultiTool\\secrets\\internal-token.txt',
    modelUserId: 0,
    memoryTimeoutMs: 15000,
    modelTimeoutMs: 90000,
  },
}, readJson(CONFIG_FILE, {}));

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

function logFile() {
  return CFG.logFile || path.join(DIR, '..', 'logs', 'speak.log');
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch { }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * HTTP 头只允许 latin-1。云端音色名是中文（"大肥鱼（迷糊版）"），
 * 直接塞进 x-speak-voice 会让 writeHead 抛 ERR_INVALID_CHAR —— 而那时音频已经合成完、
 * 钱也扣了，结果整个响应 500，调用方只看到连接被重置。所以头部一律 ASCII 安全化。
 */
function headerSafe(value) {
  const s = String(value == null ? '' : value);
  return /^[\x20-\x7E]*$/.test(s) ? s : encodeURIComponent(s);
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
  // 中文引号/书名号/方头括号：TTS 读到这里会顿一下甚至念出"引号"两个字，整句就碎了
  t = t.replace(/[「」『』“”‘’《》〈〉【】\[\]]/g, '');
  // 数学/符号：直接念符号会得到"等于方"这种，换成口语词
  t = t.replace(/²/g, ' 的平方').replace(/³/g, ' 的立方')
    .replace(/×/g, '乘以').replace(/÷/g, '除以')
    .replace(/±/g, '加减').replace(/≈/g, '约等于')
    .replace(/→/g, '变成').replace(/←/g, '来自')
    .replace(/Δ/g, ' delta ').replace(/∑/g, '求和').replace(/∫/g, '积分')
    .replace(/π/g, '派').replace(/∞/g, '无穷')
    .replace(/['′]/g, '撇').replace(/\//g, '比');
  // 罗马/希腊字母混在中文里容易读成英文字母串，保留但用空格隔开，让它逐字念
  t = t.replace(/[()\[\]{}（）]/g, ' ');
  t = t.replace(/[，,]\s*[，,]+/g, '，');
  t = t.replace(/[。！？!?]{2,}/g, '。');
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

// ---------------------------------------------------------------- 进程内计数（GET /v1/usage）
//
// credits 与 creditsEstimated 的区别：
//   credits          = 账本里真实结算到的（charge.amount 累加，60s 一批，最准）
//   creditsEstimated = 字符数 × breezeblue.creditsPerChar（立刻可得，用作对照/预估）

function round3(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

function creditsPerChar() {
  const v = Number(CFG.breezeblue && CFG.breezeblue.creditsPerChar);
  return Number.isFinite(v) && v > 0 ? v : 0.185;
}

const usage = {
  startedAt: new Date().toISOString(),
  requests: 0,          // 收到的 /v1/speak 次数（含失败）
  calls: 0,             // 成功返回音频的次数
  chars: 0,             // 成功合成的字符数
  credits: 0,           // 账本结算到、且认领到本进程某一句的真实 credits
  accountCredits: 0,    // 账本上所有新出现的 charge（账户级参考，含别的进程/别的工具）
  creditsEstimated: 0,  // 字符数 × 单价
  fallbacks: 0,         // 回退到本地引擎的次数（strict=false 才有）
  failures: 0,          // 没拿到音频的次数
  retries: 0,           // 触发重试的次数
  retriedSuccesses: 0,  // 重试后成功的次数
  strictFailures: 0,    // strict 模式下的 503 次数
  queueFull: 0,
  queueTimeout: 0,
  lastCall: null,
  lastFailure: null,
  recentCalls: [],      // 最近 30 次成功（含结算后的真实 credits）
  pending: [],          // 等账本结算的句子，用于把 charge 匹配回具体某句
};

let callSeq = 0;

// ---------------------------------------------------------------- 余额 / 计费
//
// 30 秒缓存（config.breezeblue.balanceTtlMs）：一句一句合成时不能每句都白打一个余额请求，
// 但又要能反映"这一句花掉了多少"，所以合成之后用 maxAgeMs 强制刷新一次。

const BALANCE = {
  at: 0,
  data: null,        // {balance, millicredits, scale, settlementIntervalSec, settlementPending}
  error: '',
  inflight: null,
  ledger: { baseline: false, seen: new Set(), recent: [] },
  fetches: 0,
  lastError: '',
};

function balanceBase() {
  return String(CFG.breezeblue.base || '').replace(/\/+$/, '');
}

async function fetchBalanceRaw() {
  let key;
  try {
    key = readBreezeblueKey();
  } catch (err) {
    return { ok: false, error: `BREEZEBLUE_NO_KEY: ${err && err.message || err}` };
  }
  BALANCE.fetches += 1;
  const base = balanceBase();
  const timeoutMs = Number(CFG.breezeblue.balanceTimeoutMs) || 15000;
  // 余额请求偶发 fetch failed（undici 连接抖动），重试一次就够；它绝不能影响合成主流程
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/v1/balance`, {
        headers: { 'xi-api-key': key },
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, status: res.status, error: `BALANCE_HTTP_${res.status}: ${String(body).slice(0, 200)}` };
      }
      const j = await res.json();
      const data = {
        balance: Number(j.balance),
        millicredits: Number(j.balance_millicredits),
        scale: Number(j.scale) || 1000,
        settlementIntervalSec: Number(j.settlement_interval_seconds) || 60,
        settlementPending: Boolean(j.settlement_pending),
        charges: Array.isArray(j.charges) ? j.charges : [],
      };
      return { ok: true, data };
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? 'timeout' : (err && err.message || err);
      if (attempt >= 2) return { ok: false, error: `BALANCE_FETCH: ${msg}` };
      await sleep(300);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: 'BALANCE_FETCH: unknown' };
}

/**
 * 账本对齐：上一次余额快照里没见过的 charge 就是"新结算的账单"。
 * 第一次只建立基线（不把历史账单算进本进程），之后每笔都尝试认领回 pending 里那句。
 *
 * 两个口径必须分开：
 *   usage.accountCredits = 账本上所有新出现的 charge 之和（账户级；如果别的程序也用同一个 key，
 *                          或者另一个 speak 进程在跑，也会算进来 —— 只能当参考）
 *   usage.credits        = 只算成功认领到本进程某一句的那些 charge（进程级，最准）
 * 认领不到的（别人的进程、基线之前的历史）只进 accountCredits，不进 credits。
 */
function applyLedger(charges) {
  const list = Array.isArray(charges) ? charges : [];
  if (!BALANCE.ledger.baseline) {
    for (const c of list) {
      if (c && c.id) BALANCE.ledger.seen.add(String(c.id));
    }
    BALANCE.ledger.baseline = true;
    log(`billing baseline: ${BALANCE.ledger.seen.size} existing charge(s) ignored (not from this process)`);
    return { fresh: [], credited: 0 };
  }
  const fresh = [];
  let credited = 0;
  for (const c of list) {
    const id = c && c.id ? String(c.id) : '';
    if (!id || BALANCE.ledger.seen.has(id)) continue;
    BALANCE.ledger.seen.add(id);
    const amount = round3(Number(c.amount) || 0);
    credited += amount;
    fresh.push({
      id,
      amount,
      chars: Number(c.text_characters) || 0,
      units: Number(c.billable_units) || 0,
      status: Number(c.status) || 0,
      at: String(c.created_at || ''),
      endpoint: String(c.endpoint || ''),
    });
  }
  if (!fresh.length) return { fresh: [], credited: 0 };

  usage.accountCredits = round3(usage.accountCredits + credited);
  BALANCE.ledger.recent = fresh.concat(BALANCE.ledger.recent).slice(0, 40);
  let claimed = 0;
  let claimedCredits = 0;
  for (const f of fresh) {
    const got = attributeCharge(f);
    if (got) { claimed += 1; claimedCredits += f.amount; }
  }
  log(`billing settled: ${fresh.length} charge(s) +${round3(credited)} credits (claimed ${claimed} for this process, +${round3(claimedCredits)}); process credits=${usage.credits}, account credits=${usage.accountCredits}`);
  return { fresh, credited, claimed, claimedCredits: round3(claimedCredits) };
}

/** 把一笔结算账单认领到某一句（先按字符数精确匹配，再按 FIFO）。认领不到返回 false。 */
function attributeCharge(charge) {
  if (!usage.pending.length) return false;
  let idx = usage.pending.findIndex((p) => p.settledCredits == null && p.chars === charge.chars);
  if (idx < 0) idx = usage.pending.findIndex((p) => p.settledCredits == null);
  if (idx < 0) return false;
  const entry = usage.pending[idx];
  entry.settledCredits = charge.amount;
  entry.settledAt = charge.at;
  entry.settledChargeId = charge.id;
  usage.pending.splice(idx, 1);
  usage.credits = round3(usage.credits + charge.amount);
  const diff = round3(charge.amount - entry.creditsEstimated);
  log(`billing sentence: chars=${entry.chars} settled=${entry.settledCredits} est=${entry.creditsEstimated} diff=${diff > 0 ? '+' : ''}${diff} voice=${entry.voiceId || '-'} processCredits=${usage.credits}`);
  const rc = usage.recentCalls.find((c) => c.id === entry.id);
  if (rc) { rc.settledCredits = entry.settledCredits; rc.settledAt = entry.settledAt; }
  return true;
}

/**
 * 读余额（默认 30s 缓存）。opts.maxAgeMs 覆盖缓存容忍度，opts.refresh=true 强制重取。
 * 并发调用共享同一次请求，不会因为 4 个并发 speak 打 4 次 balance。
 */
function getBalance(opts = {}) {
  const ttl = opts.refresh ? 0
    : (Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : (Number(CFG.breezeblue.balanceTtlMs) || 30000));
  const age = Date.now() - BALANCE.at;
  if (BALANCE.data && age <= ttl) {
    return Promise.resolve(Object.assign({ cached: true, ageMs: age, ledgerBaseline: BALANCE.ledger.baseline }, BALANCE.data, { ok: true }));
  }
  if (!BALANCE.inflight) {
    BALANCE.inflight = fetchBalanceRaw()
      .then((r) => {
        BALANCE.inflight = null;
        if (r.ok) {
          BALANCE.data = r.data;
          BALANCE.at = Date.now();
          BALANCE.error = '';
          const applied = applyLedger(r.data.charges);
          r.applied = applied;
        } else {
          BALANCE.error = r.error;
          BALANCE.lastError = r.error;
        }
        return r;
      })
      .catch((err) => {
        BALANCE.inflight = null;
        BALANCE.error = String(err && err.message || err);
        return { ok: false, error: BALANCE.error };
      });
  }
  return BALANCE.inflight.then((r) => {
    if (!r || !r.ok) {
      return Object.assign({}, r || { ok: false, error: 'BALANCE_UNKNOWN' }, { cached: false, ageMs: 0 });
    }
    // 注意：fetchBalanceRaw 返回 {ok, data}，这里必须摊平，否则调用方拿不到 balance
    return Object.assign({}, r.data, {
      ok: true,
      cached: false,
      ageMs: 0,
      ledgerBaseline: BALANCE.ledger.baseline,
      applied: r.applied,
    });
  });
}

function balanceSnapshot(b) {
  if (!b || !b.ok) return { ok: false, error: (b && b.error) || BALANCE.error || 'BALANCE_UNKNOWN' };
  return {
    ok: true,
    balance: b.balance,
    millicredits: b.millicredits,
    scale: b.scale,
    settlementPending: b.settlementPending,
    settlementIntervalSec: b.settlementIntervalSec,
    cached: Boolean(b.cached),
    ageMs: b.ageMs,
    at: BALANCE.at ? new Date(BALANCE.at).toISOString() : '',
  };
}

/** 每 60s 拉一次账本（有请求之后才启动），把结算结果对齐到已花掉的钱。 */
let reconcileTimer = null;
function startReconcileTimer() {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    getBalance({ refresh: true }).catch(() => { });
  }, Math.max(30000, (Number(CFG.breezeblue.balanceTtlMs) || 30000) * 2));
  if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
}

// ---------------------------------------------------------------- 串行队列 / 重试
//
// 为什么必须有队列：BreezeBlue Starter 档并发上限是 1。实测同时发 4 句，
// 1 句 200、3 句 429 GENERATION_CONCURRENCY_EXCEEDED —— 自己跟自己抢配额，
// 只会把 4 个请求里 3 个变成重试。串行化后 4 句全部成功，代价是排队等待。

class SerialQueue {
  constructor(name, limit, maxDepth) {
    this.name = name;
    this.limit = Math.max(1, Number(limit) || 1);
    this.maxDepth = Math.max(1, Number(maxDepth) || 64);
    this.active = 0;
    this.waiters = [];
    this.stats = { served: 0, rejected: 0, timedOut: 0, waitMsTotal: 0, waitMsMax: 0, maxDepthSeen: 0 };
  }

  get depth() { return this.waiters.length; }

  /** 排队执行 fn。成功 resolve {value, waitMs}；队列满/排队超时 reject 带 code 的错误。 */
  run(fn, opts = {}) {
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 180000);
    return new Promise((resolve, reject) => {
      if (this.active >= this.limit && this.waiters.length >= this.maxDepth) {
        this.stats.rejected += 1;
        const err = new Error(`queue ${this.name} is full (${this.waiters.length} waiting)`);
        err.code = 'QUEUE_FULL';
        err.queue = this.name;
        err.depth = this.waiters.length;
        reject(err);
        return;
      }
      const job = { fn, resolve, reject, enqueuedAt: Date.now(), timer: null };
      this.waiters.push(job);
      this.stats.maxDepthSeen = Math.max(this.stats.maxDepthSeen, this.waiters.length);
      job.timer = setTimeout(() => {
        const i = this.waiters.indexOf(job);
        if (i < 0) return;
        this.waiters.splice(i, 1);
        this.stats.timedOut += 1;
        const err = new Error(`queue ${this.name} wait exceeded ${timeoutMs}ms`);
        err.code = 'QUEUE_TIMEOUT';
        err.queue = this.name;
        err.depth = this.waiters.length;
        reject(err);
      }, timeoutMs);
      if (typeof job.timer.unref === 'function') job.timer.unref();
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.limit && this.waiters.length) {
      const job = this.waiters.shift();
      clearTimeout(job.timer);
      this.active += 1;
      const waitMs = Date.now() - job.enqueuedAt;
      this.stats.served += 1;
      this.stats.waitMsTotal += waitMs;
      this.stats.waitMsMax = Math.max(this.stats.waitMsMax, waitMs);
      Promise.resolve()
        .then(job.fn)
        .then(
          (value) => { this.active -= 1; this._pump(); job.resolve({ value, waitMs }); },
          (err) => { this.active -= 1; this._pump(); job.reject(err); },
        );
    }
  }

  snapshot() {
    const avg = this.stats.served ? Math.round(this.stats.waitMsTotal / this.stats.served) : 0;
    return {
      limit: this.limit,
      maxDepth: this.maxDepth,
      depth: this.waiters.length,
      active: this.active,
      served: this.stats.served,
      rejected: this.stats.rejected,
      timedOut: this.stats.timedOut,
      waitMsAvg: avg,
      waitMsMax: this.stats.waitMsMax,
      maxDepthSeen: this.stats.maxDepthSeen,
    };
  }
}

const CLOUD_QUEUE = new SerialQueue('breezeblue', Number(CFG.breezeblue.maxConcurrency) || 1, Number(CFG.breezeblue.queueMax) || 64);

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); if (typeof t.unref === 'function') t.unref(); });
}

function retryPolicy() {
  const r = CFG.breezeblue.retry || {};
  const maxAttempts = Math.max(1, Math.min(8, Number(r.maxAttempts) || 4));
  let backoff = Array.isArray(r.backoffMs)
    ? r.backoffMs.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 0)
    : [];
  if (!backoff.length) backoff = [1000, 2000, 4000, 8000];
  const statuses = Array.isArray(r.retryStatus) && r.retryStatus.length
    ? r.retryStatus.map((x) => Number(x)).filter(Number.isFinite)
    : [408, 429, 500, 502, 503, 504];
  return { maxAttempts, backoff, statuses, retryOnNetwork: r.retryOnNetwork !== false };
}

// ---------------------------------------------------------------- BreezeBlue 云端 TTS
//
// 云端返回的是 mp3（audio/mpeg），我们整条链路（面板的 <audio>、时长统计、下发）都吃 wav，
// 所以这里用 ffmpeg 转封装成 22050Hz 单声道 16bit wav —— 和 piper 的输出规格一致。

function dataDir() { return path.join(DIR, '..', 'data', 'speak'); }
function personaVoiceCacheFile() { return CFG.personaVoice.cacheFile || path.join(dataDir(), 'persona-voice.json'); }
function voicesCacheFile() { return CFG.breezeblue.voicesCacheFile || path.join(dataDir(), 'breezeblue-voices.json'); }

/** key 每次现读：轮换或吊销后立即生效，不会拿着进程里的旧值一直撞 401。 */
function readBreezeblueKey() {
  const file = CFG.breezeblue.keyPath;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) throw new Error(`key file is empty: ${file}`);
  return text;
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CFG.breezeblue.ffmpegExe, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stderr: `FFMPEG_SPAWN: ${err && err.message || err}` });
      return;
    }
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeoutMs);
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: `FFMPEG_ERROR: ${e && e.message || e}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err }); });
  });
}

/** 音色清单：一周缓存一次，避免每句话都多打一个云端请求。 */
async function fetchBreezeblueVoices(opts = {}) {
  const cacheFile = voicesCacheFile();
  const ttl = Number(CFG.breezeblue.voicesTtlMs) || 604800000;
  if (!opts.force) {
    const cached = personaVoice.readCache(cacheFile);
    if (cached && Array.isArray(cached.voices) && cached.voices.length
      && Date.now() - Number(cached.at || 0) < ttl) {
      return { ok: true, cached: true, at: cached.at, voices: personaVoice.normalizeVoices(cached.voices) };
    }
  }
  let key;
  try {
    key = readBreezeblueKey();
  } catch (err) {
    return { ok: false, error: `BREEZEBLUE_NO_KEY: ${err && err.message || err}` };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(`${String(CFG.breezeblue.base || '').replace(/\/+$/, '')}/v1/voices`, {
      headers: { 'xi-api-key': key },
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `VOICES_HTTP_${res.status}: ${String(body).slice(0, 200)}` };
    }
    const data = await res.json();
    const voices = personaVoice.normalizeVoices(data);
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, `${JSON.stringify({ at: Date.now(), voices }, null, 2)}\n`, 'utf8');
    } catch { }
    return { ok: true, cached: false, at: Date.now(), voices };
  } catch (err) {
    return { ok: false, error: `VOICES_FETCH: ${err && err.name === 'AbortError' ? 'timeout' : (err && err.message || err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 现算/读缓存：当前人设该用哪个音色。 */
async function resolveVoiceCached(opts = {}) {
  const list = await fetchBreezeblueVoices();
  if (!list.ok) return { ok: false, error: list.error };
  const r = await personaVoice.resolveVoiceForPersona({
    memoryUrl: CFG.personaVoice.memoryUrl,
    voices: list.voices,
    cacheFile: personaVoiceCacheFile(),
    force: Boolean(opts.force),
    language: CFG.personaVoice.language || 'zh',
    defaultVoiceId: CFG.breezeblue.voiceId,
    useModel: Boolean(CFG.personaVoice.useModel),
    ioUrl: CFG.personaVoice.ioUrl,
    modelUserId: CFG.personaVoice.modelUserId,
    internalTokenPath: CFG.personaVoice.internalTokenPath,
    memoryTimeoutMs: CFG.personaVoice.memoryTimeoutMs,
    modelTimeoutMs: CFG.personaVoice.modelTimeoutMs,
  });
  return Object.assign({ ok: true, voicesTotal: list.voices.length, voicesCacheHit: list.cached }, r);
}

/**
 * 单次云端合成：POST → mp3 → ffmpeg → 22050 单声道 wav。
 * 返回 { ok, retryable, status?, error?, file?, info? }；重试由 synthesizeBreezeblue 负责。
 * 可重试 = 429 / 5xx / 超时 / 网络抖动。不可重试 = 拿不到 key、401/403/400、ffmpeg 失败
 * （音频已经生成并扣费了，再试一次等于再花一次钱）。
 */
async function synthesizeBreezeblueOnce(text, voice) {
  const started = Date.now();
  const voiceId = String((voice && voice.voiceId) || CFG.breezeblue.voiceId || '');
  if (!voiceId) {
    return { ok: false, provider: 'breezeblue', error: 'BREEZEBLUE_NO_VOICE_ID', retryable: false };
  }
  let key;
  try {
    key = readBreezeblueKey();
  } catch (err) {
    // key 文件缺失/为空是确定性错误，重试 4 次只会白等 7 秒
    return { ok: false, provider: 'breezeblue', voiceId, error: `BREEZEBLUE_NO_KEY: ${err && err.message || err}`, retryable: false };
  }

  const base = String(CFG.breezeblue.base || '').replace(/\/+$/, '');
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const ac = new AbortController();
  const timeoutMs = Number(CFG.breezeblue.timeoutMs) || 120000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const mp3File = path.join(OUT_DIR, `bb-${stamp}.mp3`);
  const wavFile = path.join(OUT_DIR, `bb-${stamp}.wav`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const policy = retryPolicy();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      let detail = String(body).slice(0, 300);
      let code = '';
      try {
        const j = JSON.parse(body);
        detail = String((j && (j.detail || j.message || j.error)) || detail).slice(0, 300);
        code = String((j && j.code) || '');
      } catch { }
      const retryable = policy.statuses.includes(Number(res.status));
      return {
        ok: false, provider: 'breezeblue', voiceId, status: Number(res.status), retryable,
        error: `BREEZEBLUE_HTTP_${res.status}${code ? ' ' + code : ''}: ${detail}`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) {
      // 空音频视为瞬时问题，可重试（没拿到声音就不该算成功）
      return { ok: false, provider: 'breezeblue', voiceId, error: `BREEZEBLUE_EMPTY_AUDIO(${buf.length}B)`, retryable: true };
    }
    fs.writeFileSync(mp3File, buf);

    if (String(CFG.breezeblue.outputFormat || 'wav').toLowerCase() === 'mp3') {
      return {
        ok: true, provider: 'breezeblue', content: 'audio/mpeg',
        file: mp3File,
        info: { voice: (voice && voice.name) || voiceId, voiceId, mp3Bytes: buf.length, ms: Date.now() - started },
      };
    }

    const sampleRate = String(Number(CFG.breezeblue.sampleRate) || 22050);
    const ff = await runFfmpeg([
      '-y', '-loglevel', 'error',
      '-i', mp3File,
      '-ar', sampleRate, '-ac', '1', '-c:a', 'pcm_s16le',
      wavFile,
    ], Math.min(timeoutMs, 60000));
    if (ff.code !== 0 || !fs.existsSync(wavFile) || fs.statSync(wavFile).size < 1000) {
      return {
        ok: false, provider: 'breezeblue', voiceId, retryable: false,
        error: `BREEZEBLUE_FFMPEG_FAILED(code=${ff.code}): ${String(ff.stderr || '').slice(0, 300)}`,
      };
    }
    const size = fs.statSync(wavFile).size;
    return {
      ok: true, provider: 'breezeblue', content: 'audio/wav',
      file: wavFile,
      info: {
        voice: (voice && voice.name) || voiceId,
        voiceId,
        ms: Date.now() - started,
        bytes: size,
        mp3Bytes: buf.length,
        sampleRate: Number(sampleRate),
      },
    };
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    return {
      ok: false, provider: 'breezeblue', voiceId, retryable: true,
      error: `${timeout ? 'BREEZEBLUE_TIMEOUT' : 'BREEZEBLUE_FETCH'}: ${err && err.message || err}`,
    };
  } finally {
    clearTimeout(timer);
    // mp3 只在 outputFormat=mp3 时保留（那时它就是返回值）
    if (String(CFG.breezeblue.outputFormat || 'wav').toLowerCase() !== 'mp3') {
      try { fs.unlinkSync(mp3File); } catch { }
    }
  }
}

/**
 * 带退避重试的云端合成。attempts 是"实际打了几次"，retries = attempts-1。
 * 只有 retryable 的失败才会重试；确定性失败（没 key、401、ffmpeg）立刻返回，不白等。
 */
async function synthesizeBreezeblue(text, voice) {
  const policy = retryPolicy();
  const errors = [];
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const r = await synthesizeBreezeblueOnce(text, voice);
    if (r.ok) {
      const retries = attempt - 1;
      if (retries > 0) usage.retriedSuccesses += 1;
      return Object.assign(r, { attempts: attempt, retries, errors });
    }
    errors.push(r.error);
    const canRetry = r.retryable !== false && attempt < policy.maxAttempts;
    if (!canRetry) {
      return Object.assign(r, {
        attempts: attempt,
        retries: attempt - 1,
        errors,
        exhausted: Boolean(r.retryable) && attempt >= policy.maxAttempts,
      });
    }
    const waitMs = policy.backoff[Math.min(attempt - 1, policy.backoff.length - 1)];
    usage.retries += 1;
    log(`breezeblue attempt ${attempt}/${policy.maxAttempts} failed (${r.error}); retry in ${waitMs}ms`);
    await sleep(waitMs);
  }
}

/** 计费块：一句合成前后的余额差 + 估算值。 */
function buildBilling(text, out, before, after, queueWaitMs, totalMs) {
  const creditsBefore = before && before.ok ? round3(before.balance) : null;
  const creditsAfter = after && after.ok ? round3(after.balance) : null;
  const spent = (creditsBefore != null && creditsAfter != null) ? round3(creditsAfter - creditsBefore) : null;
  const estimated = round3(text.length * creditsPerChar());
  return {
    chars: text.length,
    creditsBefore,
    creditsAfter,
    creditsSpent: spent,
    creditsEstimated: estimated,
    // 结算有 ~60s 滞后，所以立刻读到的 spent 常常是 0，这里把"是否已结算"标出来，别让人误读
    settledImmediately: spent != null && Math.abs(spent) > 0.0005,
    balanceCachedBefore: Boolean(before && before.cached),
    balanceCachedAfter: Boolean(after && after.cached),
    balanceError: (after && !after.ok && after.error) || (before && !before.ok && before.error) || '',
    balanceAt: BALANCE.at ? new Date(BALANCE.at).toISOString() : '',
    queueWaitMs,
    totalMs,
  };
}

function rememberCall(text, out, billing) {
  const id = `call-${++callSeq}`;
  const entry = {
    id,
    at: new Date().toISOString(),
    chars: text.length,
    voiceId: (out.info && out.info.voiceId) || '',
    voice: (out.info && out.info.voice) || '',
    attempts: out.attempts || 1,
    retries: out.retries || 0,
    ms: (out.info && out.info.ms) || billing.totalMs || 0,
    bytes: (out.info && out.info.bytes) || 0,
    creditsBefore: billing.creditsBefore,
    creditsAfter: billing.creditsAfter,
    creditsSpent: billing.creditsSpent,
    creditsEstimated: billing.creditsEstimated,
    settledCredits: null,
    settledAt: '',
  };
  usage.recentCalls.unshift(entry);
  if (usage.recentCalls.length > 30) usage.recentCalls.length = 30;
  usage.pending.push(Object.assign({}, entry, { settledCredits: null }));
  if (usage.pending.length > 50) usage.pending.shift();
  return entry;
}

// ---------------------------------------------------------------- 路由
//
// voice 合法值：''|auto|persona|default（人设决定）、breezeblue|cloud（云端默认）、
// voc_xxx（指定云端音色）、huayan|huayan-fast|yaoyao|huihui|kangkang（显式本地）。
// 老实现把 voice:"persona" 当成"认不出来的本地音色"→ 静默落到 huayan，这是个坑，现在明确归一到 auto。

const VOICE_ALIAS_AUTO = new Set(['', 'auto', 'persona', 'default', 'persona-auto']);
const VOICE_ALIAS_CLOUD = new Set(['breezeblue', 'cloud', 'breeze']);

function classifyVoice(wanted) {
  const raw = String(wanted == null ? '' : wanted).trim();
  const low = raw.toLowerCase();
  if (VOICE_ALIAS_AUTO.has(low)) return { kind: 'auto', raw, low };
  if (VOICE_ALIAS_CLOUD.has(low)) return { kind: 'cloud', raw, low };
  if (/^voc_[a-z0-9]+$/i.test(raw)) return { kind: 'voiceId', raw, low, voiceId: raw };
  if (voiceTable()[low]) return { kind: 'local', raw, low };
  return { kind: 'unknown', raw, low };
}

function legalVoicesHint() {
  return `合法值：''|auto|persona|default（人设决定）, breezeblue|cloud（云端默认音色）, voc_xxx（指定音色）, ${Object.keys(voiceTable()).join('|')}（显式本地）`;
}

/**
 * 路由：显式本地音色 > 云端（人设音色）> 老规则。
 * strict=true 时云端失败**不回退**：返回结构化失败，由调用方决定怎么办。
 */
async function synthesizeDispatch(text, voice, rate, opts = {}) {
  const strict = opts.strict == null ? Boolean(CFG.strict) : Boolean(opts.strict);
  const picked = classifyVoice(voice);

  // 1) 显式点名本地引擎：huayan / huayan-fast / yaoyao / huihui / kangkang
  if (picked.kind === 'local') {
    if (strict && CFG.strictAllowExplicitLocal === false) {
      return {
        ok: false, strict: true, status: 400, attempts: 0,
        error: 'LOCAL_VOICE_BLOCKED',
        lastError: `strict=true 且 strictAllowExplicitLocal=false：本地音色 ${picked.low} 已停用，只有 BreezeBlue 可用`,
        hint: legalVoicesHint(),
      };
    }
    const r = await synthesize(text, picked.low, rate);
    r.explicitLocal = true;
    r.strict = strict;
    if (r.ok) r.info = Object.assign({}, r.info, { explicitLocal: true });
    return r;
  }

  // 2) 认不出来的名字：strict 直接 400，别让它悄悄变成另一个嗓子
  if (picked.kind === 'unknown') {
    if (strict) {
      return {
        ok: false, strict: true, status: 400, attempts: 0,
        error: 'UNKNOWN_VOICE',
        lastError: `voice="${picked.raw}" 不是合法值`,
        hint: legalVoicesHint(),
      };
    }
    log(`warn: unknown voice "${picked.raw}", legacy behavior -> ${CFG.voice || 'huayan'}`);
    return synthesize(text, picked.low, rate);
  }

  // 3) 云端：voc_ 音色 id、breezeblue/cloud、auto（=人设决定），或 provider=breezeblue 且没点音色
  const wantsCloud = picked.kind === 'voiceId' || picked.kind === 'cloud'
    || (picked.kind === 'auto' && (CFG.provider === 'breezeblue' || strict));
  if (wantsCloud) {
    let voiceId = picked.kind === 'voiceId' ? picked.raw : '';
    let pick = null;
    if (!voiceId) {
      const r = await resolveVoiceCached();
      if (r.ok && r.voiceId) {
        voiceId = r.voiceId;
        pick = { voiceId: r.voiceId, name: r.name, reason: r.reason, cached: r.cached, version: r.version, method: r.method };
      } else {
        voiceId = CFG.breezeblue.voiceId;
        pick = { voiceId, name: '', reason: `人设音色不可用：${(r && r.error) || 'UNKNOWN'}`, cached: false, method: 'default' };
      }
    }

    const startedAt = Date.now();
    const before = await getBalance();
    let out;
    let queueWaitMs = 0;
    try {
      const q = await CLOUD_QUEUE.run(
        () => synthesizeBreezeblue(text, { voiceId, name: pick && pick.name }),
        { timeoutMs: Number(CFG.breezeblue.queueTimeoutMs) || 180000 },
      );
      out = q.value;
      queueWaitMs = q.waitMs;
    } catch (err) {
      const code = String((err && err.code) || 'QUEUE_ERROR');
      const now = new Date().toISOString();
      if (code === 'QUEUE_FULL') usage.queueFull += 1;
      if (code === 'QUEUE_TIMEOUT') usage.queueTimeout += 1;
      usage.lastFailure = { at: now, error: code, detail: String(err && err.message || err), chars: text.length };
      log(`breezeblue queue rejected: ${code} depth=${(err && err.depth) || '-'} chars=${text.length}`);
      const afterFail = await getBalance();
      const billing = buildBilling(text, { ok: false }, before, afterFail, 0, Date.now() - startedAt);
      return {
        ok: false, provider: 'breezeblue', voiceId, strict, status: 503, attempts: 0,
        error: code, lastError: String(err && err.message || err),
        retryable: true, queueWaitMs: 0, billing, persona: pick,
      };
    }

    // 合成完再读一次余额（缓存超过 balanceAfterMaxAgeMs 就强制刷新），拿到 creditsAfter
    const after = await getBalance({ maxAgeMs: Number(CFG.breezeblue.balanceAfterMaxAgeMs) || 5000 });
    const totalMs = Date.now() - startedAt;
    const billing = buildBilling(text, out, before, after, queueWaitMs, totalMs);
    out.billing = billing;
    out.attempts = out.attempts || 1;
    out.retries = out.retries || 0;
    out.queueWaitMs = queueWaitMs;

    if (out.ok) {
      out.info = Object.assign({}, out.info, { provider: 'breezeblue', persona: pick, credits: billing });
      out.strict = strict;
      rememberCall(text, out, billing);
      return out;
    }

    // ---- 失败：strict 就到此为止，非 strict 才回退 huayan
    const lastError = out.error;
    if (strict) {
      log(`strict: breezeblue unavailable after ${out.attempts} attempt(s): ${lastError}`);
      return {
        ok: false, provider: 'breezeblue', voiceId, strict: true, status: 503,
        error: 'BREEZEBLUE_UNAVAILABLE',
        attempts: out.attempts,
        retries: out.retries,
        lastError,
        errors: out.errors || [lastError],
        retryable: out.retryable !== false,
        exhausted: Boolean(out.exhausted),
        queueWaitMs,
        billing,
        persona: pick,
        hint: 'strict 模式：不回退本地音色。检查 keyPath/额度/并发，或用 body.strict=false 显式降级',
      };
    }

    log(`breezeblue failed after ${out.attempts} attempt(s), falling back to huayan: ${lastError}`);
    const fb = await synthesizePiper(text, resolveVoice('huayan'));
    fb.fallbackFrom = 'breezeblue';
    fb.cloudError = lastError;
    fb.provider = 'piper';
    fb.attempts = out.attempts;
    fb.retries = out.retries;
    fb.strict = false;
    fb.queueWaitMs = queueWaitMs;
    fb.billing = billing;
    fb.info = Object.assign({}, fb.info, {
      voice: 'huayan',
      fallbackFrom: 'breezeblue',
      cloudError: lastError,
      persona: pick,
      attempts: out.attempts,
      credits: billing,
    });
    return fb;
  }

  // 4) 老规则：CFG.provider 决定
  return synthesize(text, picked.low || CFG.voice, rate);
}

function usageBody() {
  const calls = usage.calls;
  return {
    ok: true,
    startedAt: usage.startedAt,
    uptimeSec: Math.round(process.uptime()),
    configFile: CONFIG_FILE,
    strict: Boolean(CFG.strict),
    provider: CFG.provider,
    creditsPerChar: creditsPerChar(),

    // ---- 需求要求的五个累计值
    calls,
    chars: usage.chars,
    credits: usage.credits,                 // 真实结算到、且属于本进程的 credits（60s 一批，会滞后）
    fallbacks: usage.fallbacks,
    failures: usage.failures,

    // ---- 辅助口径
    requests: usage.requests,
    accountCredits: usage.accountCredits,   // 账户级账本增量（别的进程也会算进来，只作参考）
    creditsEstimated: usage.creditsEstimated,
    settledCalls: usage.recentCalls.filter((c) => c.settledCredits != null).length,
    creditsPerCall: calls ? round3(usage.creditsEstimated / calls) : 0,
    creditsPerCharActual: usage.chars ? round3(usage.creditsEstimated / usage.chars) : 0,
    avgChars: calls ? round3(usage.chars / calls) : 0,
    retries: usage.retries,
    retriedSuccesses: usage.retriedSuccesses,
    strictFailures: usage.strictFailures,
    queueFull: usage.queueFull,
    queueTimeout: usage.queueTimeout,
    pendingSettlement: usage.pending.length,
    lastCall: usage.lastCall,
    lastFailure: usage.lastFailure,
    queue: CLOUD_QUEUE.snapshot(),
    balance: balanceSnapshot(BALANCE.data ? Object.assign({ ok: true, cached: true, ageMs: Date.now() - BALANCE.at }, BALANCE.data) : { ok: false, error: BALANCE.error }),
    recentSettled: BALANCE.ledger.recent.slice(0, 12),
    recentCalls: usage.recentCalls.slice(0, 20),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/v1/health' || p === '/health')) {
      let keyPresent = false;
      try { keyPresent = readBreezeblueKey().length > 0; } catch { keyPresent = false; }
      const cache = personaVoice.readCache(personaVoiceCacheFile());
      return json(res, 200, {
        ok: true,
        provider: CFG.provider,
        voice: CFG.voice || 'persona',
        voices: Object.keys(voiceTable()),
        piper: fs.existsSync(CFG.piperExe),
        rate: CFG.rate,
        configFile: CONFIG_FILE,
        strict: Boolean(CFG.strict),
        strictAllowExplicitLocal: CFG.strictAllowExplicitLocal !== false,
        scripts: {
          winrt: fs.existsSync(path.join(DIR, 'tts-winrt.ps1')),
          sapi: fs.existsSync(path.join(DIR, 'speak.ps1')),
        },
        breezeblue: {
          base: CFG.breezeblue.base,
          keyPath: CFG.breezeblue.keyPath,
          keyPresent,
          ffmpeg: fs.existsSync(CFG.breezeblue.ffmpegExe),
          voiceId: CFG.breezeblue.voiceId,
          outputFormat: CFG.breezeblue.outputFormat,
          timeoutMs: CFG.breezeblue.timeoutMs,
          creditsPerChar: creditsPerChar(),
          voicesCache: voicesCacheFile(),
          retry: retryPolicy(),
          queue: CLOUD_QUEUE.snapshot(),
          balance: balanceSnapshot(BALANCE.data ? Object.assign({ ok: true, cached: true, ageMs: Date.now() - BALANCE.at }, BALANCE.data) : { ok: false, error: BALANCE.error }),
        },
        personaVoice: {
          memoryUrl: CFG.personaVoice.memoryUrl,
          cacheFile: personaVoiceCacheFile(),
          useModel: Boolean(CFG.personaVoice.useModel),
          language: CFG.personaVoice.language,
          cached: cache ? { voiceId: cache.voiceId, name: cache.name, version: cache.version, at: cache.at, method: cache.method, source: cache.source } : null,
        },
      });
    }

    // 本进程累计用量：一集视频花了多少钱一眼能看到
    if (req.method === 'GET' && p === '/v1/usage') {
      const refresh = /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || '');
      if (refresh) await getBalance({ refresh: true });
      return json(res, 200, usageBody());
    }

    // 余额（带 30s 缓存；refresh=1 强制重取）
    if (req.method === 'GET' && p === '/v1/balance') {
      const refresh = /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || '');
      const b = await getBalance({ refresh });
      const snap = balanceSnapshot(b);
      return json(res, 200, {
        ok: snap.ok,
        error: snap.error,
        balance: snap.balance,
        millicredits: snap.millicredits,
        settlementPending: snap.settlementPending,
        settlementIntervalSec: snap.settlementIntervalSec,
        cached: snap.cached,
        ageMs: snap.ageMs,
        at: snap.at,
        creditsSpentThisProcess: usage.credits,
        recentSettled: BALANCE.ledger.recent.slice(0, 10),
      });
    }

    // 音色清单：GET /v1/voices?zh=1 → 中文音色池（id + 名字 + 打分维度），给前端下拉
    if (req.method === 'GET' && p === '/v1/voices') {
      const force = /^(1|true|yes)$/i.test(url.searchParams.get('force') || '');
      const zhParam = url.searchParams.get('zh');
      const wantZh = zhParam == null
        ? String(CFG.personaVoice.language || 'zh').toLowerCase() === 'zh'
        : /^(1|true|yes)$/i.test(zhParam);
      const list = await fetchBreezeblueVoices({ force });
      if (!list.ok) return json(res, 200, { ok: false, error: list.error });
      const filtered = wantZh
        ? list.voices.filter((v) => /^zh/i.test(v.language))
        : list.voices;
      const cache = personaVoice.readCache(personaVoiceCacheFile());
      const current = cache && cache.voiceId ? String(cache.voiceId) : '';
      return json(res, 200, {
        ok: true,
        filter: wantZh ? 'zh' : 'all',
        total: list.voices.length,
        returned: filtered.length,
        cached: list.cached,
        at: list.at,
        current,
        currentName: (filtered.find((v) => v.voiceId === current) || {}).name || (cache && cache.name) || '',
        // 打分维度（lib/persona-voice.js 的权重）：language 是硬门槛，其余用于人设画像匹配
        scoringDimensions: { language: 'hard-filter', gender: 34, age: 22, tone: 12, ageNeighbor: 9, toneClash: -6 },
        voices: filtered.map((v) => ({
          voiceId: v.voiceId,
          name: v.name,
          language: v.language,
          gender: v.gender,
          age: v.age,
          tones: v.tones,
          tags: v.tags,
          description: v.description,
          current: v.voiceId === current,
          dimensions: {
            gender: v.gender || 'unknown',
            age: v.age || 'unknown',
            tones: v.tones.length ? v.tones : [],
            tags: v.tags,
          },
        })),
      });
    }

    // 当前音色（人设决定，人工可审）。force=1 强制重算并覆盖缓存。
    if (req.method === 'GET' && p === '/v1/voice') {
      const force = /^(1|true|yes)$/i.test(url.searchParams.get('force') || '');
      const r = await resolveVoiceCached({ force });
      if (!r.ok) return json(res, 200, { ok: false, error: r.error });
      return json(res, 200, {
        ok: true,
        provider: 'breezeblue',
        voiceId: r.voiceId,
        name: r.name,
        reason: r.reason,
        cached: r.cached,
        method: r.method,
        source: r.source,
        version: r.version,
        at: r.at,
        ms: r.ms,
        score: r.score,
        profile: r.profile || null,
        candidates: r.candidates || [],
        voices: { total: r.voicesTotal, cacheHit: r.voicesCacheHit },
      });
    }

    // 人工指定音色：直接写缓存，覆盖人设决定（直到下一次 force 或再次人工指定）。
    if (req.method === 'POST' && p === '/v1/voice') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false, error: 'BAD_JSON' }); }
      const voiceId = String(body.voiceId || body.voice_id || '').trim();
      if (!/^voc_[a-z0-9]+$/i.test(voiceId)) return json(res, 400, { ok: false, error: 'VOICE_ID_REQUIRED', hint: '形如 voc_xxxxxxxx' });
      const list = await fetchBreezeblueVoices();
      if (!list.ok) return json(res, 200, { ok: false, error: list.error });
      const found = list.voices.find((v) => v.voiceId === voiceId);
      if (!found) return json(res, 400, { ok: false, error: 'UNKNOWN_VOICE_ID', hint: '音色清单里没有这个 id' });
      const persona = await personaVoice.fetchPersona(CFG.personaVoice.memoryUrl, CFG.personaVoice.memoryTimeoutMs);
      const version = persona.ok ? persona.version : 0;
      const pin = personaVoice.pinVoice(personaVoiceCacheFile(), {
        voiceId,
        name: found.name,
        reason: String(body.reason || '人工指定（POST /v1/voice）').slice(0, 300),
        version,
      });
      log(`voice pinned manually: ${voiceId} (${found.name})`);
      return json(res, 200, {
        ok: true, voiceId: pin.voiceId, name: pin.name, reason: pin.reason,
        version: pin.version, at: pin.at, cached: false, method: 'manual', source: 'manual',
      });
    }

    // 返回 wav 字节，方便 <audio> 直接播
    if (req.method === 'POST' && p === '/v1/speak') {
      usage.requests += 1;
      startReconcileTimer();
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {
        usage.failures += 1;
        return json(res, 400, { ok: false, error: 'BAD_JSON' });
      }
      const text = cleanForSpeech(body.text);
      if (!text) {
        usage.failures += 1;
        return json(res, 400, { ok: false, error: 'EMPTY_TEXT' });
      }
      // 单次请求可覆盖 strict（视频模块可以按镜头要求），默认取 config
      let strictOverride = null;
      if (body.strict != null) {
        strictOverride = typeof body.strict === 'boolean'
          ? body.strict
          : /^(1|true|yes|on)$/i.test(String(body.strict));
      }
      const qsStrict = url.searchParams.get('strict');
      if (qsStrict != null) strictOverride = /^(1|true|yes|on)$/i.test(qsStrict);

      const r = await synthesizeDispatch(
        text,
        body.voice == null ? '' : String(body.voice),
        Number.isFinite(body.rate) ? body.rate : CFG.rate,
        { strict: strictOverride },
      );

      if (!r.ok) {
        usage.failures += 1;
        if (r.strict) usage.strictFailures += 1;
        usage.lastFailure = {
          at: new Date().toISOString(),
          error: r.error,
          lastError: r.lastError || '',
          chars: text.length,
          attempts: r.attempts || 0,
          strict: Boolean(r.strict),
          voiceId: r.voiceId || '',
        };
        log(`speak failed: error=${r.error} chars=${text.length} attempts=${r.attempts || 0} strict=${Boolean(r.strict)} lastError=${r.lastError || '-'}`);
        const status = Number(r.status) || 200;
        return json(res, status, {
          ok: false,
          error: r.error,
          strict: Boolean(r.strict),
          attempts: r.attempts == null ? null : r.attempts,
          retries: r.retries == null ? null : r.retries,
          lastError: r.lastError || '',
          errors: r.errors || [],
          retryable: r.retryable == null ? null : r.retryable,
          exhausted: r.exhausted == null ? null : r.exhausted,
          voiceId: r.voiceId || '',
          chars: text.length,
          // 非 strict 时可能"云端失败 → 回退本地也失败"，把云端那句原因一并带出来
          fallbackFrom: r.fallbackFrom || '',
          cloudError: r.cloudError || '',
          billing: r.billing || null,
          hint: r.hint || '',
        });
      }

      const buf = fs.readFileSync(r.file);
      try { fs.unlinkSync(r.file); } catch { }

      // ---- 累计计量（成功才有 chars / calls）
      usage.calls += 1;
      usage.chars += text.length;
      const est = round3(text.length * creditsPerChar());
      usage.creditsEstimated = round3(usage.creditsEstimated + est);
      if (r.fallbackFrom) usage.fallbacks += 1;

      const billing = r.billing || null;
      const personaInfo = (r.info && r.info.persona) || null;
      const call = {
        id: `call-${callSeq + 1}`,
        at: new Date().toISOString(),
        chars: text.length,
        voiceId: (r.info && r.info.voiceId) || '',
        voice: (r.info && r.info.voice) || '',
        provider: r.provider || '',
        attempts: r.attempts || 1,
        retries: r.retries || 0,
      };
      usage.lastCall = call;

      log(`speak ok provider=${r.provider || '-'} voice=${(r.info && r.info.voice) || '-'} voiceId=${(r.info && r.info.voiceId) || '-'} chars=${text.length} bytes=${buf.length} ms=${(r.info && r.info.ms) || '-'} attempts=${r.attempts || 1} queueWaitMs=${r.queueWaitMs || 0} strict=${Boolean(CFG.strict)} fallbackFrom=${r.fallbackFrom || '-'}`);
      if (billing) {
        log(`billing chars=${billing.chars} creditsBefore=${billing.creditsBefore} creditsAfter=${billing.creditsAfter} creditsSpent=${billing.creditsSpent} creditsEstimated=${billing.creditsEstimated} settledImmediately=${billing.settledImmediately} balanceAt=${billing.balanceAt}${billing.balanceError ? ' balanceError=' + billing.balanceError : ''}`);
      }

      res.writeHead(200, {
        'content-type': r.content || 'audio/wav',
        'content-length': buf.length,
        'cache-control': 'no-store',
        // x-speak-voice 保持"机器可读"：本地音色是名字（huayan），云端是 voice id（voc_xxx）；
        // 中文名字放在 x-speak-voice-name 里，percent-encoded，调用方 decodeURIComponent 即可。
        'x-speak-voice': headerSafe((r.info && r.info.voiceId) || (r.info && r.info.voice) || ''),
        'x-speak-voice-name': headerSafe((r.info && r.info.voice) || ''),
        'x-speak-voice-id': String((r.info && r.info.voiceId) || ''),
        'x-speak-ms': String((r.info && r.info.ms) || ''),
        'x-speak-provider': String(r.provider || ''),
        'x-speak-strict': String(r.strict ? '1' : '0'),
        'x-speak-attempts': String(r.attempts || 1),
        'x-speak-retries': String(r.retries || 0),
        'x-speak-queue-wait-ms': String(r.queueWaitMs || 0),
        'x-speak-chars': String(text.length),
        'x-speak-credits-est': billing ? String(billing.creditsEstimated) : '',
        'x-speak-credits-spent': billing ? String(billing.creditsSpent == null ? '' : billing.creditsSpent) : '',
        'x-speak-balance': billing && billing.creditsAfter != null ? String(billing.creditsAfter) : '',
        'x-speak-fallback-from': String(r.fallbackFrom || ''),
        'x-speak-cloud-error': String(r.cloudError || '').replace(/[^\x20-\x7E]/g, '?').slice(0, 200),
        'x-speak-persona-cached': personaInfo ? String(Boolean(personaInfo.cached)) : '',
        'x-speak-explicit-local': r.explicitLocal ? '1' : '',
      });
      return res.end(buf);
    }

    return json(res, 404, { ok: false, error: 'not found', paths: ['GET /v1/health', 'GET /v1/voice', 'POST /v1/voice', 'GET /v1/voices', 'GET /v1/usage', 'GET /v1/balance', 'POST /v1/speak'] });
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(CFG.port, HOST, () => {
  log(`speak module on http://${HOST}:${CFG.port}  provider=${CFG.provider}  voice=${CFG.voice || 'auto'}  strict=${Boolean(CFG.strict)}  cloudConcurrency=${CLOUD_QUEUE.limit}  config=${CONFIG_FILE}`);
  // 预热一份余额基线：这样第一句的 creditsBefore 就是真的余额，而不是 null
  getBalance().catch(() => { });
});
