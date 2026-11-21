'use strict';
/**
 * subtitles.js -- 字幕：词级时间戳 → SRT → 用 ffmpeg 烧进画面。
 *
 * 三条硬规则（都是踩出来的）：
 *
 * 1) **绝对时间 = 场起始偏移 + 句内偏移，而场起始偏移必须按"实际拼接"算。**
 *    concatClips 用 xfade 串场，相邻两场重叠 CFG.fade 秒，所以第 i 场的画面起点是
 *    Σ(seconds - fade)，不是 Σseconds。差这一个 fade 就是 0.4 秒的整句错位 ——
 *    "旁白说到第二个点时，第二个元素要正在出现"，靠的就是这个偏移是准的。
 *    注意：时间轴必须用**进入成片的那些场**（渲染失败被跳过的场不占位），
 *    所以调用方传进来的是 timeline，不是 project.scenes。
 *
 * 2) **时间戳来源优先级：BreezeBlue `/v1/text-to-speech/{voice}/with-timestamps` → 按字数比例估算。**
 *    接口拿到的是词级 [{word,start,end}]（单位秒）。它和 speak 合成的那条音频是**两次合成**，
 *    语速会有几十分之一秒的漂移，所以这里再按"这条音频的实测时长 / 最后一个词的结束时间"
 *    做一次比例校准，把漂移压到 100ms 以内。校准系数的合理区间是 [0.8, 1.25]，
 *    超出说明音频对不上（换了音色/文本被改写），直接退回估算，不要拿错的去烧字幕。
 *
 * 3) **烧字幕用 subtitles 滤镜 + cwd。** Windows 路径里的 `C:` 冒号在滤镜表达式里是参数分隔符，
 *    转义规则又随 ffmpeg 版本变；把 srt 复制成工作目录里的纯 ASCII 文件名、再把 ffmpeg 的
 *    当前目录切过去，就不用转义任何东西。
 *
 * 字号换算：ffmpeg 给 SRT 生成的 ASS 头是 PlayResX=384 / PlayResY=288，
 * libass 会按 frame_height/288 放大字号。所以要让 1080p 上字号 ≈52px，
 * FontSize 只能写 52*288/1080 ≈ 14 —— 写 52 会变成满屏巨字。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------- 小工具 ----

function sha1(text, len = 16) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, len);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** `HH:MM:SS,mmm`（SRT 的格式，逗号不是点）。 */
function fmtSrtTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const total = Math.round(t * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
}

/** 在指定工作目录跑一个子进程（ffmpeg 的 cwd 就是"免转义"的关键）。 */
function runIn(cwd, cmd, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, Math.max(1000, timeoutMs));
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String((e && e.message) || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

// ---------------------------------------------------------------- 配置 ----

const DEFAULT_STYLE = {
  fontSizePx: 52,        // 1080p 上白字的实际像素高度（会按分辨率换算成 ASS 字号）
  color: '#FFFFFF',
  outlinePx: 3,
  outlineColor: '#000000',
  backColor: '#000000',  // 半透明黑底
  backAlpha: 0.55,       // 0=全透明 1=不透明
  marginBottomPx: 64,    // 距画面底部的像素
  marginSidePx: 96,
  maxCharsPerCue: 16,    // 一条字幕最多几个字（再长就切）
  minCueSec: 0.55,
};

/** 取"这一集要不要字幕 / 字幕长什么样"，优先级：项目 > 风格 > 全局配置 > 默认。 */
function resolveStyle({ project, style, cfg }) {
  const C = cfg || {};
  const enabled = project && project.subtitles != null
    ? Boolean(project.subtitles)
    : (C.subtitles !== false);
  const merged = Object.assign({}, DEFAULT_STYLE);
  const globals = {
    fontSizePx: num(C.subtitleFontSize, DEFAULT_STYLE.fontSizePx),
    color: C.subtitleColor || DEFAULT_STYLE.color,
    backAlpha: num(C.subtitleBackAlpha, DEFAULT_STYLE.backAlpha),
    marginBottomPx: num(C.subtitleMarginBottom, DEFAULT_STYLE.marginBottomPx),
    maxCharsPerCue: num(C.subtitleMaxChars, DEFAULT_STYLE.maxCharsPerCue),
  };
  const fromStyle = style && style.subtitleStyle && typeof style.subtitleStyle === 'object' ? style.subtitleStyle : {};
  const fromProject = project && project.subtitleStyle && typeof project.subtitleStyle === 'object' ? project.subtitleStyle : {};
  const pick = (key) => {
    if (fromProject[key] != null) return fromProject[key];
    if (fromStyle[key] != null) return fromStyle[key];
    return globals[key];
  };
  merged.fontSizePx = num(pick('fontSizePx'), DEFAULT_STYLE.fontSizePx);
  merged.color = String(pick('color') || DEFAULT_STYLE.color);
  merged.backAlpha = Math.min(1, Math.max(0, num(pick('backAlpha'), DEFAULT_STYLE.backAlpha)));
  merged.marginBottomPx = num(pick('marginBottomPx'), DEFAULT_STYLE.marginBottomPx);
  merged.maxCharsPerCue = Math.max(6, num(pick('maxCharsPerCue'), DEFAULT_STYLE.maxCharsPerCue));
  // 字体固定微软雅黑：服务器上只有它保证有中文字形，换字体等于出一排方框。
  merged.fontName = String(pick('fontName') || 'Microsoft YaHei');
  return { enabled, style: merged };
}

// -------------------------------------------------- BreezeBlue 时间戳 ----

/**
 * 从 speak 的配置里拿 BreezeBlue 的 base / keyPath / 默认音色。
 * **不复制密钥**：只读路径，运行时现读文件（轮换密钥后立刻生效）。
 * 读不到就返回 null —— 调用方退回"按字数比例估算"，字幕照常出。
 */
function breezeConfig(cfg) {
  const C = cfg || {};
  const file = C.subtitleBreezeConfigFile
    || path.join(__dirname, '..', '..', 'speak', 'config.json');
  const conf = readJson(file, null);
  const bb = conf && conf.breezeblue;
  if (!bb || !bb.base) return null;
  return {
    base: String(bb.base).replace(/\/+$/, ''),
    keyPath: String(bb.keyPath || ''),
    voiceId: String(C.subtitleVoiceId || bb.voiceId || ''),
    timeoutMs: num(C.subtitleTimingsTimeoutMs, 30000),
  };
}

function readKey(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || '';
  } catch { return ''; }
}

/** 时间戳缓存的落盘文件：同一句话只花一次钱（键 = 文本 + 音色）。 */
function cacheFile(cfg) {
  const C = cfg || {};
  return C.subtitleTimingsCacheFile || path.join(C.outDir || '.', 'subtitle-timings.json');
}

function loadCache(cfg) {
  const data = readJson(cacheFile(cfg), null);
  return data && typeof data === 'object' && data.items && typeof data.items === 'object'
    ? data
    : { v: 1, items: {} };
}

function saveCache(cfg, data, log) {
  const file = cacheFile(cfg);
  const items = data && data.items ? data.items : {};
  const keys = Object.keys(items);
  const max = 400;
  if (keys.length > max) {
    // 超量按"最后使用"淘汰：只留最近用到的，别让缓存文件无限长
    const keep = keys
      .sort((a, b) => num(items[b].usedAt, 0) - num(items[a].usedAt, 0))
      .slice(0, max);
    const next = {};
    for (const k of keep) next[k] = items[k];
    data.items = next;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    if (log) log(`字幕时间戳缓存写盘失败（不影响出片）：${(err && err.message) || err}`);
  }
}

/** 把接口返回的 word_timestamps 归一化成 [{word,start,end}]，并丢掉非法项。 */
function normalizeWords(raw) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const word = String(it.word == null ? it.text == null ? '' : it.text : it.word);
    const start = num(it.start, NaN);
    const end = num(it.end, NaN);
    if (!word || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({ word, start, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 调 BreezeBlue 的 with-timestamps。
 * 成功返回 { ok:true, words:[...], voiceId, apiMs }；任何失败都返回 { ok:false, error }，
 * 由上层决定退回估算 —— 字幕是"锦上添花"，不能因为它把整集弄失败。
 */
async function fetchWordTimings(text, cfg, log) {
  const mode = String((cfg && cfg.subtitleTimingsMode) || 'api').toLowerCase();
  if (mode === 'off' || mode === 'estimate') return { ok: false, error: 'MODE_ESTIMATE' };
  const bb = breezeConfig(cfg);
  if (!bb || !bb.voiceId) return { ok: false, error: 'NO_BREEZE_CONFIG' };
  const key = readKey(bb.keyPath);
  if (!key) return { ok: false, error: 'NO_BREEZE_KEY' };
  const url = `${bb.base}/v1/text-to-speech/${encodeURIComponent(bb.voiceId)}/with-timestamps`;
  let last = null;
  // 429 是 BreezeBlue 的"并发额度已满"（Starter 档并发上限是 1）。它随时可能因为
  // speak 正在合成、或另一个任务在跑而触发 —— 退避重试一次，比直接退回估算值得。
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), bb.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(text) }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let code = '';
        try { code = String((JSON.parse(body) || {}).code || ''); } catch { /* 非 JSON */ }
        last = { ok: false, error: `HTTP_${res.status}${code ? ` ${code}` : ''}`, detail: String(body).slice(0, 200) };
        if (res.status === 429) continue;
        return last;
      }
      const json = await res.json();
      const words = normalizeWords(json && (json.word_timestamps || json.alignment || json.words));
      if (!words.length) return { ok: false, error: 'NO_WORDS' };
      return { ok: true, words, voiceId: bb.voiceId, apiMs: Date.now() - t0 };
    } catch (err) {
      last = { ok: false, error: String((err && err.name) || 'FETCH'), detail: String((err && err.message) || err).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last || { ok: false, error: 'UNKNOWN' };
}

// ------------------------------------------------------------ 字数估算 ----

/** 一个字符大约占多长时间（相对权重）。中文 1，标点稍短，拉丁字母/数字更短。 */
function charWeight(ch) {
  if (/[\u3000-\u303f\uff00-\uffef]/.test(ch)) return 0.55;   // 中文标点
  if (/[，。！？；：「」（）…—]/.test(ch)) return 0.6;
  if (/\s/.test(ch)) return 0.12;
  if (/[A-Za-z0-9]/.test(ch)) return 0.5;
  return 1;
}

/**
 * 拿不到接口时间戳时的兜底：按字重比例把整条音频时长切开。
 * 比"每字等长"准得多（标点、空格、英文单词的时长差一倍以上），
 * 而且这里同样按标点切句，保证字幕条的**条数与内容**和接口路径一致。
 */
function estimateWords(text, durationSec) {
  const s = String(text || '');
  const total = Math.max(0.2, Number(durationSec) || 0);
  const chars = Array.from(s);
  const weights = chars.map(charWeight);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  // TTS 一般有几十毫秒的起音和收尾静音，直接按比例铺会整体前移 → 留 3% / 6%
  const lead = total * 0.03;
  const tail = total * 0.06;
  const span = Math.max(0.05, total - lead - tail);
  const out = [];
  let acc = 0;
  for (let i = 0; i < chars.length; i++) {
    const start = lead + (acc / sum) * span;
    acc += weights[i];
    const end = lead + (acc / sum) * span;
    if (chars[i].trim()) out.push({ word: chars[i], start, end });
  }
  return out.length ? out : [{ word: s.slice(0, 20), start: 0, end: total }];
}

// ------------------------------------------------------------ 分条 ----

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const PUNCT_SENT = /[。！？；…!?;]$/;     // 句末：一定断
const PUNCT_SOFT = /[，、：,;:—]$/;         // 句中停顿：优先在这里断

/** 词数组 → 一行文字（中文不加空格，英文单词之间补一个）。 */
function joinWords(list) {
  let text = '';
  for (const w of list) {
    const piece = String(w.word || '');
    if (!piece) continue;
    const needSpace = text && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(piece) && !CJK.test(piece[0]);
    text += (needSpace ? ' ' : '') + piece;
  }
  return text.trim();
}

function charCount(list) {
  return Array.from(joinWords(list).replace(/\s+/g, '')).length;
}

/**
 * 一句话按字数上限**均衡**切几段。
 *
 * 为什么不是"攒够 maxChars 就断"：那样 18 个字会被切成 16+2，
 * 屏幕上先出现一整行、再闪一个两个字的小尾巴 —— 观众会以为字幕出错了。
 * 做法：先算要切几段，再在"累计字数最接近目标值"的词边界切；
 * 落在逗号/冒号这种句中停顿处的边界额外加分（-1.5 权重），所以优先断在标点后面。
 */
function splitBalanced(words, maxChars) {
  const total = charCount(words);
  if (total <= maxChars || words.length < 2) return [words];
  const parts = Math.ceil(total / maxChars);
  const cum = [];
  let acc = 0;
  for (const w of words) {
    acc += Array.from(joinWords([w]).replace(/\s+/g, '')).length;
    cum.push(acc);
  }
  const out = [];
  let start = 0;
  let consumed = 0;
  let left = parts;
  while (left > 1 && start < words.length - 1) {
    const target = consumed + (total - consumed) / left;
    let best = -1;
    let bestScore = Infinity;
    for (let i = start; i < words.length - 1; i++) {
      const isPunct = PUNCT_SOFT.test(String(words[i].word || ''));
      const score = Math.abs(cum[i] - target) - (isPunct ? 1.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    out.push(words.slice(start, best + 1));
    consumed = cum[best];
    start = best + 1;
    left -= 1;
  }
  if (start <= words.length - 1) out.push(words.slice(start));
  return out;
}

/**
 * 词 → 字幕条：先按句末标点断句，每句再均衡切段。
 * 返回 [{start,end,text}]，时间来自首词/末词。
 */
function groupWords(words, maxChars) {
  const max = Math.max(6, num(maxChars, 16));
  const list = (Array.isArray(words) ? words : []).filter((w) => w && String(w.word || '').trim());
  const sentences = [];
  let cur = [];
  for (const w of list) {
    cur.push(w);
    if (PUNCT_SENT.test(String(w.word || ''))) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);
  const cues = [];
  for (const sent of sentences) {
    const parts = splitBalanced(sent, max);
    for (let pi = 0; pi < parts.length; pi++) {
      let part = parts[pi];
      // 切点落在标点后面时，下一段可能以"，"开头：把它挪回上一段结尾，
      // 否则屏幕上会出现一条以逗号开头的字幕。
      if (pi > 0 && part.length && /^[，、：,;:—]+$/.test(String(part[0].word || '').trim())) {
        const prev = cues[cues.length - 1];
        if (prev) {
          prev.text = `${prev.text}${String(part[0].word).trim()}`;
          prev.end = Math.max(prev.end, num(part[0].end, prev.end));
        }
        part = part.slice(1);
      }
      if (!part.length) continue;
      const text = joinWords(part);
      if (!text) continue;
      cues.push({
        start: Math.max(0, num(part[0].start, 0)),
        end: Math.max(0, num(part[part.length - 1].end, 0)),
        text,
      });
    }
  }
  return cues;
}

/**
 * 校准：把接口时间戳按"这条音频的实测时长"缩放。
 *
 * 为什么必须校准：`with-timestamps` 那次合成和 speak 那次合成是两个独立请求，
 * 实测同一句话 speak 的 wav 比接口给的 mp3 长 20% 左右（接口那边的音色/模型组合语速更快）。
 * 两次合成都匀速，所以按总时长做一次线性缩放就能对回来；不缩放时句子末尾会差 0.5~0.7 秒。
 *
 * 两道校验，任一不过就返回 null（调用方退回字数估算）：
 *   1) 文本覆盖：接口给的词拼起来必须和原句一致（差一两个字算正常，少了半句就是截断）
 *   2) 缩放系数落在 [0.7, 1.5]：超出说明音频和文本根本不是一句话
 *
 * 返回 { words, scale }。
 */
function calibrate(words, audioSec, text) {
  if (!Array.isArray(words) || !words.length) return null;
  const lastEnd = num(words[words.length - 1].end, 0);
  const dur = Number(audioSec) || 0;
  if (!(lastEnd > 0.1) || !(dur > 0.2)) return null;
  // 文本覆盖：去掉空白和标点后比长度。接口偶尔会截断长句，那样时间戳只覆盖前半句，
  // 直接拿来用会让后半句没有字幕（观众听到人声但屏幕没字）。
  if (text) {
    const norm = (s) => String(s || '').replace(/[\s，。！？；：、,.!?;:"'（）()【】\[\]…—-]/g, '');
    const want = norm(text);
    const gotText = norm(words.map((w) => w.word).join(''));
    if (want.length > 4) {
      const common = Math.min(want.length, gotText.length);
      let same = 0;
      for (let i = 0; i < common; i++) if (want[i] === gotText[i]) same += 1;
      if (same / want.length < 0.9) return null;
    }
  }
  const scale = dur / lastEnd;
  if (!(scale > 0.7 && scale < 1.5)) return null;
  return {
    scale,
    words: words.map((w) => ({
      word: w.word,
      start: Math.max(0, w.start * scale),
      end: Math.max(0, w.end * scale),
    })),
  };
}

/**
 * 对齐报告：每场的"旁白时长 / 场时长 / 动画时长"。
 * 差值就是节奏对不对的证据 —— 这三者差 ≤0.5 秒，观感才是"图文对上"。
 */
function rhythmRow({ index, at, narrationMs, seconds, animSeconds }) {
  const narration = Math.round(Number(narrationMs) || 0) / 1000;
  const scene = Math.round((Number(seconds) || 0) * 100) / 100;
  const anim = Math.round((Number(animSeconds) || 0) * 100) / 100;
  const diffNarrationScene = Math.round(Math.abs(scene - narration) * 100) / 100;
  const diffAnimNarration = anim > 0 ? Math.round(Math.abs(anim - narration) * 100) / 100 : 0;
  return {
    index, at: Math.round((Number(at) || 0) * 100) / 100,
    narration, scene, anim,
    diffNarrationScene, diffAnimNarration,
  };
}

// ------------------------------------------------------------ 主流程 ----

/**
 * 生成这一集的字幕条。
 *
 * @param {Object} a
 * @param {Array}  a.timeline  真正进成片的场次 [{ scene, index }]（顺序即拼接顺序）
 * @param {Array}  a.speeches  与 timeline 对齐（按 index 取），每项 { wav, ms } 或 null
 * @param {Number} a.fade      转场重叠秒数（xfade 的 duration）
 * @param {Object} a.cfg       studio 的 CFG
 * @param {Function} a.log     日志函数
 * @returns {Promise<{ok:boolean, cues:Array, rows:Array, srt:string, stats:Object}>}
 */
async function buildCues({ timeline, speeches, fade, cfg, log }) {
  const C = cfg || {};
  const fadeSec = Math.max(0, num(fade, 0.4));
  const { style } = resolveStyle({ project: null, style: null, cfg: C });
  const maxChars = style.maxCharsPerCue;
  const cache = loadCache(C);
  const rows = [];
  const all = [];
  const stats = { api: 0, estimate: 0, failed: 0, scenes: 0 };
  let at = 0;

  // 时间戳可以并发取，但 BreezeBlue Starter 档并发上限是 1（speak 那边就是这么限的），
  // 所以这里串行：一条一条取，429 由 fetchWordTimings 内部退避重试。
  const limit = 1;
  const jobs = [];
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const sp = speeches[item.index];
    const sceneAt = at;
    at += Math.max(0, num(item.scene && item.scene.seconds, 0)) - fadeSec;
    const scene = item.scene || {};
    const narrationMs = sp ? num(sp.ms, 0) : 0;
    const row = rhythmRow({
      index: item.index, at: sceneAt, narrationMs,
      seconds: scene.seconds, animSeconds: scene.animSeconds,
    });
    rows.push(row);
    if (!sp || !narrationMs || !String(scene.narration || '').trim()) continue;
    stats.scenes += 1;
    // 句首/句尾静音（rhythm.polishSpeech 量好的）：开头静音是字幕的**偏移**，
    // 不算进去字幕会比人声早 0.3 秒出现；结尾静音不算进"这句话多长"，
    // 否则字会被拉长、跟人声对不上。
    jobs.push({
      index: i, scene, sceneAt, narrationMs, text: String(scene.narration),
      leadSec: Math.max(0, num(sp.leadMs, 0)) / 1000,
      tailSec: Math.max(0, num(sp.tailMs, 0)) / 1000,
    });
  }

  const resolveOne = async (job) => {
    // 用来校准的"说话时长" = 总时长 - 首静音 - 尾静音
    const audioSec = Math.max(0.25, (job.narrationMs - job.leadSec * 1000 - job.tailSec * 1000) / 1000);
    // 缓存键只用 (文本, 音色)：存的是**接口原样的词级时间**，缩放（按这条音频的实际时长）
    // 每次现算 —— 这样改了语速/重新合成也不会拿到"按旧音频缩放好的"错位时间。
    const key = sha1(`${job.text}|${(breezeConfig(C) || {}).voiceId || ''}`);
    const hit = cache.items[key];
    if (hit && Array.isArray(hit.words) && hit.words.length) {
      hit.usedAt = Date.now();
      const cal = calibrate(hit.words, audioSec, job.text);
      if (cal) return { words: cal.words, source: 'api-cache', scale: cal.scale };
      if (log) log(`字幕：第 ${job.index + 1} 场缓存的接口时间戳和这条音频对不上，改用字数估算`);
      return { words: estimateWords(job.text, audioSec), source: 'estimate' };
    }
    const got = await fetchWordTimings(job.text, C, log);
    if (got.ok) {
      const cal = calibrate(got.words, audioSec, job.text);
      if (cal) {
        cache.items[key] = { words: got.words, voiceId: got.voiceId || '', at: new Date().toISOString(), usedAt: Date.now() };
        return { words: cal.words, source: 'api', scale: cal.scale };
      }
      // 拿到了但对不上（换了音色/接口把句子截断了）：宁可估算，也不烧一版错位字幕
      if (log) log(`字幕：第 ${job.index + 1} 场接口时间戳和这条音频对不上，改用字数估算`);
      return { words: estimateWords(job.text, audioSec), source: 'estimate' };
    }
    if (log && got.error && got.error !== 'MODE_ESTIMATE') {
      log(`字幕：第 ${job.index + 1} 场没拿到接口时间戳（${got.error}${got.detail ? ` ${got.detail}` : ''}），改用字数估算`);
    }
    return { words: estimateWords(job.text, audioSec), source: 'estimate' };
  };

  const results = new Array(jobs.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const k = cursor;
      cursor += 1;
      if (k >= jobs.length) return;
      try { results[k] = await resolveOne(jobs[k]); } catch (err) {
        results[k] = { words: estimateWords(jobs[k].text, jobs[k].narrationMs / 1000), source: 'estimate' };
        stats.failed += 1;
        if (log) log(`字幕：第 ${jobs[k].index + 1} 场取时间戳异常（${(err && err.message) || err}），用字数估算`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, jobs.length)) }, worker));

  for (let k = 0; k < jobs.length; k++) {
    const job = jobs[k];
    const got = results[k] || { words: estimateWords(job.text, job.narrationMs / 1000), source: 'estimate' };
    if (got.source === 'api' || got.source === 'api-cache') stats.api += 1; else stats.estimate += 1;
    const cues = groupWords(got.words, maxChars);
    // 场窗口：字幕不能飘到上一场/下一场去。句尾稍许超出画面是正常的（旁白还在说），
    // 所以结束时间只压到"本场画面结束"，不压到下一场的起点之前 —— 下一场的字幕会自然接上。
    const sceneEnd = job.sceneAt + Math.max(0, num(job.scene && job.scene.seconds, 0));
    for (const c of cues) {
      // 场起始偏移 + 句首静音 + 句内偏移 = 这条字幕在成片里的绝对起点
      let start = job.sceneAt + job.leadSec + Math.max(0, c.start);
      let end = job.sceneAt + job.leadSec + Math.max(0, c.end);
      if (!(end > start)) end = start + 0.2;
      if (end - start < 0.35) end = start + 0.35;
      if (start < job.sceneAt) start = job.sceneAt;
      if (end > sceneEnd + 0.6) end = sceneEnd + 0.6;   // 允许压过场尾 0.6s（旁白尾巴）
      all.push({ start, end, text: c.text, sceneIndex: job.index, source: got.source });
    }
  }

  all.sort((a, b) => a.start - b.start);
  // 相邻条不重叠：后一条的起点压到前一条结束之后（差 1ms 也算重叠，播放器会闪）
  for (let i = 1; i < all.length; i++) {
    if (all[i].start < all[i - 1].end) all[i].start = all[i - 1].end;
    if (all[i].end <= all[i].start) all[i].end = all[i].start + 0.3;
  }
  for (const c of all) c.start = Math.round(c.start * 1000) / 1000;
  for (const c of all) c.end = Math.round(c.end * 1000) / 1000;

  saveCache(C, cache, log);
  const srt = toSrt(all);
  return { ok: true, cues: all, rows, srt, stats };
}

/** 字幕条 → SRT 文本。末行留空（SRT 规范），CRLF 用 \n，播放器都吃。 */
function toSrt(cues) {
  const lines = [];
  let n = 0;
  for (const c of Array.isArray(cues) ? cues : []) {
    n += 1;
    lines.push(String(n));
    lines.push(`${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}`);
    lines.push(String(c.text || '').replace(/\r?\n/g, ' '));
    lines.push('');
  }
  return lines.join('\n');
}

/** `#RRGGBB` → ASS 的 `&HAABBGGRR`（注意是 BGR 顺序 + 先 alpha）。 */
function assColor(hex, alpha01) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const rgb = m ? m[1] : 'ffffff';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const a = Math.round(Math.min(1, Math.max(0, alpha01 == null ? 0 : alpha01)) * 255);
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

/** 生成 force_style 串。字号/边距都按 288 高的 ASS 坐标系换算。 */
function forceStyle(style, videoH) {
  const H = Math.max(120, num(videoH, 1080));
  const k = 288 / H;
  const fontPx = Math.max(10, num(style.fontSizePx, 52));
  const assFont = Math.max(6, Math.round(fontPx * k));
  const marginV = Math.max(2, Math.round(num(style.marginBottomPx, 64) * k));
  const marginH = Math.max(2, Math.round(num(style.marginSidePx, 96) * k));
  const outline = Math.max(0, num(style.outlinePx, 3) * k);
  return [
    `FontName=${style.fontName || 'Microsoft YaHei'}`,
    `FontSize=${assFont}`,
    `PrimaryColour=${assColor(style.color, 0)}`,
    `OutlineColour=${assColor(style.outlineColor, 0)}`,
    // BorderStyle=3 = 整块不透明底（不是描边），配 BackColour 的半透明黑才是"半透明黑底"
    `BackColour=${assColor(style.backColor, 1 - num(style.backAlpha, 0.55))}`,
    'BorderStyle=3',
    `Outline=${outline.toFixed(1)}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${marginV}`,
    `MarginL=${marginH}`,
    `MarginR=${marginH}`,
  ].join(',');
}

/**
 * 把 srt 烧进一段视频。
 *
 * 为什么要 cwd：见文件头第 3 条。这里把 srt 复制成 work 目录下的 `subs.srt`，
 * ffmpeg 的 cwd 设成 work，滤镜参数就只是 `subtitles=subs.srt` —— 没有冒号、没有反斜杠。
 *
 * 输出统一重编码（libx264 veryfast / crf 20）：字幕是烧在像素里的，不重编码没法出画面。
 */
async function burn({ ffmpeg, videoIn, srt, out, videoH, style, timeoutMs, log }) {
  const work = path.dirname(out);
  const localSrt = path.join(work, 'subs.srt');
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(localSrt, String(srt || ''), 'utf8');
  } catch (err) {
    return { ok: false, error: `SRT_WRITE: ${(err && err.message) || err}` };
  }
  const vf = `subtitles=subs.srt:force_style='${forceStyle(style, videoH)}'`;
  const t0 = Date.now();
  const r = await runIn(work, ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoIn,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an', out,
  ], timeoutMs || 600000);
  const ms = Date.now() - t0;
  if (r.code !== 0 || !fs.existsSync(out)) {
    return { ok: false, error: `SUBTITLE_BURN_FAILED: ${String(r.stderr || '').slice(-400)}`, ms };
  }
  try { fs.unlinkSync(localSrt); } catch { }
  if (log) log(`字幕烧进画面完成 ${ms}ms（${path.basename(out)}）`);
  return { ok: true, file: out, ms };
}

/** 成片旁的 srt 路径（`<outDir>/<renderId>.srt`），和 mp4 并列，方便直接下载。 */
function srtPathFor(cfg, renderId) {
  return path.join((cfg && cfg.outDir) || '.', `${renderId}.srt`);
}

/**
 * 渲染收尾：算字幕 → 写 srt → 烧进画面。
 *
 * 返回 { videoIn, srt, srtText, cues, rows, stats, burnMs }：
 *   videoIn 是"带字幕的画面"，调用方拿它去混音（混音那步是 -c:v copy，不再多编码一次）；
 *   字幕关掉 / 没有任何旁白时 videoIn 为 null，调用方沿用原来的 joined。
 */
async function finish({
  project, timeline, speeches, fade, cfg, joined, cdir, style, log, renderQualityLabel,
}) {
  const C = cfg || {};
  const resolved = resolveStyle({ project, style, cfg: C });
  if (!resolved.enabled) {
    if (log) log('字幕：这一集关闭了字幕（project.subtitles=false），跳过');
    return { videoIn: null, srt: null, cues: [], rows: [], stats: { disabled: true } };
  }
  const built = await buildCues({ timeline, speeches, fade, cfg: C, log });
  if (!built.ok || !built.cues.length) {
    if (log) log('字幕：这一集没有生成任何字幕条（没有旁白或全部场次静音），跳过烧制');
    return { videoIn: null, srt: null, cues: [], rows: built.rows || [], stats: built.stats || {} };
  }
  const subSrt = path.join(cdir, `sub-${sha1(built.srt, 12)}.srt`);
  try { fs.writeFileSync(subSrt, built.srt, 'utf8'); } catch (err) {
    if (log) log(`字幕：srt 写盘失败（不烧字幕，成片照出）：${(err && err.message) || err}`);
    return { videoIn: null, srt: null, cues: built.cues, rows: built.rows, stats: built.stats };
  }
  const stamp = sha1(`${path.basename(joined)}|${built.srt}|${forceStyle(resolved.style, C.height)}|${renderQualityLabel || ''}`, 12);
  const burned = path.join(cdir, `sub-${stamp}.mp4`);
  let burnMs = 0;
  if (fs.existsSync(burned) && fs.statSync(burned).size > 1024) {
    if (log) log(`字幕：复用已烧好的画面 ${path.basename(burned)}`);
  } else {
    const r = await burn({
      ffmpeg: C.ffmpeg, videoIn: joined, srt: built.srt, out: burned,
      videoH: C.height, style: resolved.style, timeoutMs: C.renderTimeoutMs, log,
    });
    burnMs = r.ms || 0;
    if (!r.ok) {
      if (log) log(`字幕：烧制失败，退回无字幕成片（不影响出片）：${r.error}`);
      return { videoIn: null, srt: subSrt, cues: built.cues, rows: built.rows, stats: built.stats, error: r.error };
    }
  }
  return {
    videoIn: burned, srt: subSrt, srtText: built.srt,
    cues: built.cues, rows: built.rows, stats: built.stats, burnMs,
  };
}

/** 把 srt 发布到 outDir（和成片并列），给 GET /v1/video/:id.srt 用。 */
function publish({ srt, cfg, renderId }) {
  if (!renderId || !/^[0-9a-fA-F-]{8,64}$/.test(String(renderId))) return '';
  const dest = srtPathFor(cfg, renderId);
  try {
    if (srt && fs.existsSync(srt)) fs.copyFileSync(srt, dest);
    else return '';
    return dest;
  } catch { return ''; }
}

module.exports = {
  DEFAULT_STYLE,
  resolveStyle,
  fmtSrtTime,
  toSrt,
  assColor,
  forceStyle,
  estimateWords,
  groupWords,
  calibrate,
  normalizeWords,
  fetchWordTimings,
  buildCues,
  burn,
  finish,
  publish,
  srtPathFor,
  rhythmRow,
  charWeight,
  runIn,
};
