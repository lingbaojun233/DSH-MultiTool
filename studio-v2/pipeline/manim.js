'use strict';
/**
 * manim.js -- 调 Manim 渲染一段真动画。
 *
 * 只做三件事：
 *   1) 安全闸门：模型写的代码要在服务器上跑，文件/网络/进程/动态执行一律拒收；
 *   2) 字体增强：中文 Text 强制 Microsoft YaHei；标题 font_size>=44 且 weight=BOLD；
 *   3) 渲染：python -m manim render -qm --disable_caching，超时 20s + 3×时长。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCENE_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u;
const CJK_RE = /[\u3400-\u9fff]/;

const FORBIDDEN = [
  { re: /(^|[^\w.])open\s*\(/m, name: 'open(' },
  { re: /\bimport\s+os\b|\bfrom\s+os\b|\bos\.[a-zA-Z_]/m, name: 'import os' },
  { re: /\bsubprocess\b/m, name: 'subprocess' },
  { re: /\brequests\b/m, name: 'requests' },
  { re: /\burllib\b|\bhttpx?\b/m, name: 'http' },
  { re: /\bsocket\b/m, name: 'socket' },
  { re: /\bpathlib\b|\bshutil\b|\bglob\b/m, name: 'filesystem module' },
  { re: /\bctypes\b|\bpickle\b|\bmarshal\b/m, name: 'native/serialization' },
  { re: /__import__/m, name: '__import__' },
  { re: /(^|[^\w.])eval\s*\(/m, name: 'eval(' },
  { re: /(^|[^\w.])exec\s*\(/m, name: 'exec(' },
  { re: /\bScene\.embed\b/m, name: 'Scene.embed' },
];

/** 返回命中的规则名；null 表示通过。 */
function checkCode(code) {
  const src = String(code == null ? '' : code);
  for (const f of FORBIDDEN) if (f.re.test(src)) return f.name;
  // import 只允许 manim / numpy
  const importRe = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm;
  let m;
  while ((m = importRe.exec(src))) {
    const part = String(m[1] || m[2] || '');
    for (const mod of part.split(',')) {
      const root = mod.trim().split('.')[0];
      if (!root) continue;
      if (root !== 'manim' && root !== 'numpy') return `import ${root}`;
    }
  }
  return null;
}

function tail(s, n = 800) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(-n) : t;
}

function run(cmd, args, timeoutMs, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        cwd: opts.cwd,
        env: Object.assign({}, process.env, opts.env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, out: '', err: String((err && err.message) || err), timedOut: false });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        try { child.kill(); } catch { /* 已退出 */ }
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String((e && e.message) || e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

/** 从 ffmpeg -i 的 stderr 里抠时长/尺寸/fps（机器上只有 ffmpeg，没有 ffprobe）。 */
async function probeMedia(ffmpeg, file) {
  if (!ffmpeg || !fs.existsSync(file)) return null;
  const r = await run(ffmpeg, ['-hide_banner', '-i', file], 20000);
  const s = String(r.err || '');
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  const dim = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(s);
  const fps = /(\d+(?:\.\d+)?)\s*fps\b/.exec(s);
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    width: dim ? Number(dim[1]) : 0,
    height: dim ? Number(dim[2]) : 0,
    fps: fps ? Number(fps[1]) : 0,
  };
}

function guessSceneName(code) {
  const m = String(code || '').match(/class\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\.)?Scene\s*\)/u);
  return m ? m[1] : null;
}

/** MathTex 参数外再包 $ 会让 LaTeX 直接失败，这里做确定性清洗。 */
function stripMathDelims(code) {
  return String(code == null ? '' : code).replace(
    /\b(MathTex|Tex)\(\s*(r?)(["'])\s*\$+([\s\S]*?)\$+\s*\3\s*\)/g,
    (m, fn, raw, quote, inner) => `${fn}(${raw}${quote}${inner}${quote})`,
  );
}

function normText(s) {
  return String(s || '').replace(/[\s，。！？、；：,.!?;:'"「」『』（）()\-—]/g, '').toLowerCase();
}

/**
 * 找到某个函数调用的参数区间（括号配对，跳过字符串里的括号）。
 * 只用于 Text(...) 这种简单调用；找不到就返回空数组。
 */
function findCalls(src, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index);
    let depth = 0;
    let quote = '';
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close > open) out.push({ open, close, args: src.slice(open + 1, close), index: m.index });
  }
  return out;
}

function stringLiterals(args) {
  const out = [];
  const re = /(?:r)?(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(String(args || '')))) out.push(m[2]);
  return out;
}

/**
 * 标题判定：
 *   - 字符串内容匹配场景标题；
 *   - 变量名是 title/标题；
 *   - 这一行后面跟着 .to_edge(UP...；
 *   - 模型自己写了 font_size >= 40。
 * 匹配用归一化后的包含关系，避免标点/换行差异导致漏掉。
 */
function looksLikeTitle(args, scene, callStart, src) {
  const target = normText(scene && scene.text);
  const lits = stringLiterals(args).map(normText).filter(Boolean);
  if (target && target.length >= 2) {
    for (const lit of lits) {
      if (lit.includes(target) || (lit.length >= 4 && target.includes(lit))) return true;
    }
  }
  const sizeMatch = /\bfont_size\s*=\s*(\d+)/.exec(args);
  if (sizeMatch && Number(sizeMatch[1]) >= 40) return true;
  const lineStart = src.lastIndexOf('\n', callStart) + 1;
  const before = src.slice(lineStart, callStart);
  if (/(?:^|[^\w])(title|标题)\s*=\s*$/i.test(before)) return true;
  // 找这个调用的右括号之后到行尾，看是不是 .to_edge(UP...)
  let depth = 0;
  let quote = '';
  let close = -1;
  for (let i = callStart; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close >= 0) {
    const lineEnd = src.indexOf('\n', close);
    const rest = src.slice(close, lineEnd < 0 ? src.length : lineEnd);
    if (/\.to_edge\(\s*UP\b/.test(rest)) return true;
  }
  return false;
}

/**
 * 给 Text 调用补字体/字号/字重（确定性兜底，不依赖模型自觉）：
 *   - 标题：font_size 缺省补 52，已有但 <44 抬到 44；没有 weight 补 BOLD
 *   - 所有 Text：已有 font_size <28 抬到 28
 *   - 含中文且没有 font 补 Microsoft YaHei
 * 只处理括号配对的 Text(...)；MathTex/Tex 不碰；幂等（重复执行结果不变）。
 */
function enhanceTextCalls(code, scene) {
  let src = String(code || '');
  const calls = findCalls(src, 'Text');
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    let args = c.args;
    const isTitle = looksLikeTitle(args, scene, c.index, src);
    const hasCjk = stringLiterals(args).some((s) => CJK_RE.test(s));
    const add = [];

    if (!/\bfont\s*=/.test(args) && (hasCjk || isTitle)) {
      add.push('font="Microsoft YaHei"');
    }
    const sizeMatch = /\bfont_size\s*=\s*(\d+)/.exec(args);
    const size = sizeMatch ? Number(sizeMatch[1]) : null;
    if (isTitle) {
      if (size == null) add.push('font_size=52');
      else if (size < 44) args = args.replace(/\bfont_size\s*=\s*\d+/, 'font_size=44');
      if (!/\bweight\s*=/.test(args)) add.push('weight=BOLD');
    } else if (size != null && size < 28) {
      args = args.replace(/\bfont_size\s*=\s*\d+/, 'font_size=28');
    }
    if (!add.length && args === c.args) continue;
    let addition = add.map((a) => `, ${a}`).join('');
    if (/,\s*$/.test(args)) addition = addition.replace(/^,\s*/, '');
    if (!args.trim()) addition = addition.replace(/^,\s*/, '');
    src = src.slice(0, c.open + 1) + args + addition + src.slice(c.close);
  }
  return src;
}

/** 在 construct 开头注入风格背景色（模型自己设了就不动）。 */
function injectBackground(code, style) {
  const bg = style && style.bg;
  if (!bg || /background_color\s*=/.test(code)) return code;
  const lines = String(code || '').split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*def\s+construct\s*\(\s*self\s*\)\s*:/.test(l));
  if (idx < 0) return code;
  let indent = '';
  for (let i = idx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    indent = (lines[i].match(/^\s*/) || [''])[0];
    break;
  }
  if (!indent) indent = (lines[idx].match(/^\s*/) || [''])[0] + '    ';
  lines.splice(idx + 1, 0, `${indent}self.camera.background_color = "${bg}"`);
  return lines.join('\n');
}

/**
 * 风格色落实：
 *   1) 把模型写死的 WHITE/BLUE/GREEN... 换成风格色（白板上的白字是隐形的）；
 *   2) 在 construct 开头设 Mobject 默认色，模型没写 color 的轴/线也有对比度。
 */
function injectStyleColors(code, style) {
  if (!style) return code;
  const fg = style.fg || '#23262c';
  const accent = style.accent || fg;
  const accent2 = style.accent2 || accent;
  const muted = style.muted || fg;
  const map = {
    WHITE: fg, BLUE: accent, GREEN: accent, TEAL: accent, PURPLE: accent,
    YELLOW: accent2, GOLD: accent2, ORANGE: accent2, RED: accent2,
    GREY: muted, GRAY: muted,
  };
  let out = String(code || '');
  // 模型自己定义的 BLUE/WHITE 变量别动：把变量名换成字面量会得到 "#..." = "#..."
  const assigned = new Set();
  const assignRe = /^\s*([A-Z][A-Z0-9_]*)\s*=/gm;
  let am;
  while ((am = assignRe.exec(out))) assigned.add(am[1]);
  for (const [word, hex] of Object.entries(map)) {
    if (assigned.has(word)) continue;
    out = out.replace(new RegExp(`(?<!["'])\\b${word}\\b(?!["'])`, 'g'), `"${hex}"`);
  }
  if (!/Mobject\.set_default\s*\(/.test(out)) {
    const lines = out.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^\s*def\s+construct\s*\(\s*self\s*\)\s*:/.test(l));
    if (idx >= 0) {
      let indent = '';
      for (let i = idx + 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        indent = (lines[i].match(/^\s*/) || [''])[0];
        break;
      }
      if (!indent) indent = (lines[idx].match(/^\s*/) || [''])[0] + '    ';
      lines.splice(idx + 1, 0,
        `${indent}Mobject.set_default(color="${fg}")`,
        `${indent}Text.set_default(color="${fg}", font="${(style.font || 'Microsoft YaHei')}")`,
        `${indent}Axes.set_default(color="${fg}")`,
      );
      out = lines.join('\n');
    }
  }
  return out;
}

/**
 * 渲染前的确定性增强：清 $、补字体、标题加粗放大、注入背景色。
 * 返回 { code, notes }，notes 会写日志，方便解释"为什么改它"。
 */
function enhanceCode(code, scene, style) {
  const notes = [];
  let out = stripMathDelims(code);
  if (!/^\s*from\s+manim\s+import/m.test(out)) {
    out = `from manim import *\n${out}`;
    notes.push('补 from manim import *');
  }
  const beforeText = out;
  out = enhanceTextCalls(out, scene);
  if (out !== beforeText) notes.push('字体/标题增强');
  const beforeBg = out;
  out = injectBackground(out, style);
  if (out !== beforeBg) notes.push(`注入背景色 ${style && style.bg}`);
  const beforeColors = out;
  out = injectStyleColors(out, style);
  if (out !== beforeColors) notes.push('风格色注入');
  return { code: out, notes };
}

function findOutput(mediaRoot, stem) {
  const base = path.join(mediaRoot, 'videos', stem);
  try {
    for (const q of fs.readdirSync(base)) {
      const p = path.join(base, q, 'out.mp4');
      if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
    }
  } catch { /* 走递归兜底 */ }
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'out.mp4') {
        try {
          const st = fs.statSync(p);
          if (st.size > 1000 && (!best || st.mtimeMs > best.mtimeMs)) best = { file: p, mtimeMs: st.mtimeMs };
        } catch { /* 忽略 */ }
      }
    }
  };
  walk(path.join(mediaRoot, 'videos'), 0);
  return best ? best.file : path.join(base, 'out.mp4');
}

/**
 * 渲染一段 manim。
 * 返回 { ok, file, ms, error, detail, naturalSeconds, rawFile }。
 */
async function renderManim({ cfg, work, index, code, sceneName, seconds, log }) {
  const started = Date.now();
  if (!code || !String(code).trim()) return { ok: false, error: 'NO_CODE', ms: 0 };
  if (!cfg.python || !fs.existsSync(cfg.python)) return { ok: false, error: 'NO_PYTHON', ms: 0 };
  const unsafe = checkCode(code);
  if (unsafe) return { ok: false, error: 'UNSAFE_CODE', detail: unsafe, ms: Date.now() - started };

  const name = SCENE_NAME_RE.test(String(sceneName || '')) ? String(sceneName) : guessSceneName(code);
  if (!name) return { ok: false, error: 'NO_SCENE_NAME', ms: Date.now() - started };

  const stem = `manim-${index}`;
  const script = path.join(work, `${stem}.py`);
  const mediaDir = path.join(work, `media-${index}`);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(script, String(code), 'utf8');

  const args = [
    '-m', 'manim', 'render', String(cfg.manimQuality || '-qm'), '--disable_caching',
    '--media_dir', mediaDir,
  ];
  const rw = Number(cfg.manimRenderWidth) || Number(cfg.width) || 1920;
  const rh = Number(cfg.manimRenderHeight) || Number(cfg.height) || 1080;
  if (rw > 0 && rh > 0) args.push('-r', `${rw},${rh}`);
  if (Number(cfg.fps) > 0) args.push('--fps', String(Number(cfg.fps)));
  args.push('-o', 'out.mp4', script, name);

  // 任务书要求：超时 20s + 3×时长。
  const budget = (Number(cfg.manimTimeoutBaseMs) || 20000)
    + (Number(cfg.manimTimeoutPerSecondMs) || 3000) * Math.max(0, Number(seconds) || 0);

  const ffmpegDir = cfg.ffmpeg ? path.dirname(cfg.ffmpeg) : '';
  const r = await run(cfg.python, args, budget, {
    cwd: work,
    env: {
      PYTHONPATH: '',
      PYTHONIOENCODING: 'utf-8',
      TMP: work, TEMP: work, TMPDIR: work,
      PATH: ffmpegDir ? `${ffmpegDir};${process.env.PATH || ''}` : (process.env.PATH || ''),
    },
  });
  const ms = Date.now() - started;
  const out = findOutput(mediaDir, stem);
  const exists = fs.existsSync(out) && fs.statSync(out).size > 1000;

  if (r.timedOut) return { ok: false, error: `MANIM_TIMEOUT(${budget}ms)`, ms };
  if (!exists || r.code !== 0) {
    return {
      ok: false,
      error: `MANIM_FAILED(code=${r.code})`,
      detail: tail(r.err || r.out, 900),
      ms,
    };
  }
  const info = await probeMedia(cfg.ffmpeg, out);
  if (log) log(`manim 完成 ${(ms / 1000).toFixed(1)}s（自然时长 ${fix(info && info.duration)}s）`);
  return {
    ok: true,
    file: out,
    rawFile: out,
    ms,
    naturalSeconds: info && info.duration > 0 ? info.duration : Math.max(1, Number(seconds) || 4),
  };
}

function fix(v) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '?';
}

module.exports = {
  renderManim,
  enhanceCode,
  checkCode,
  probeMedia,
  guessSceneName,
  stripMathDelims,
  run,
  findCalls,
};
