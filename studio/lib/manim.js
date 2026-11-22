'use strict';
/**
 * manim.js -- 让模型写 Manim 脚本，渲成"会动的"数学画面。
 *
 * 为什么值得换掉 zoompan：
 *   静帧 + zoompan 只是"一张图在慢慢放大"，画面里没有任何信息在动；
 *   而且 zoompan 的 x/y 只取整数像素，1080p 下每帧的取整位置不一样，
 *   看着就是整张图在"呼吸/发抖"。Manim 输出的是真正的逐帧动画（曲线生长、
 *   切线滑动、公式变形），每一帧都是按时间算出来的，不存在取整抖动。
 *
 * 安全边界（模型写的代码要在服务器上跑，所以过滤是硬门槛）：
 *   - 出现 open( / import os / subprocess / requests / socket / __import__ /
 *     eval( / exec( 就整段拒收，返回 UNSAFE_CODE，上层退回 matplotlib 或文字卡；
 *   - 进程 cwd 是本次渲染的临时目录，TMP 也指到那里，写的相对路径跑不出这个目录；
 *   - 超时按"20 秒 + 3×时长"估，到点 taskkill /T /F 杀掉整棵进程树
 *     （manim 自己会开 ffmpeg 子进程，只 kill 父进程会留下孤儿占着 CPU）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * 场景名必须是合法 Python 标识符：它会原样进命令行（spawn 传 argv，不过 shell，
 * 但仍不放行空格/引号/分号这类字符，免得任何一个位置被当成参数拆开）。
 * 允许 Unicode 字母是因为 Python 3 的类名可以是中文，模型偶尔会写 `class 切线动画(Scene)`。
 */
const SCENE_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u;

/**
 * 禁止清单。用词边界匹配，避免把 numpy 的 cos 之类误伤；
 * `open(` 前后加边界是因为 `ax.plot(` 里也可能出现 "open" 之外的子串。
 */
const FORBIDDEN = [
  { re: /(^|[^\w.])open\s*\(/m, name: 'open(' },
  { re: /\bimport\s+os\b|\bfrom\s+os\b|\bos\.[a-zA-Z_]/m, name: 'import os' },
  { re: /\bsubprocess\b/m, name: 'subprocess' },
  { re: /\brequests\b/m, name: 'requests' },
  { re: /\bsocket\b/m, name: 'socket' },
  { re: /__import__/m, name: '__import__' },
  { re: /(^|[^\w.])eval\s*\(/m, name: 'eval(' },
  { re: /(^|[^\w.])exec\s*\(/m, name: 'exec(' },
];

/**
 * 静态检查模型给的 manim 脚本。
 * 返回 null 表示通过；返回字符串表示命中的规则名（上层拼成 UNSAFE_CODE 上报）。
 */
function checkCode(code) {
  const src = String(code == null ? '' : code);
  for (const f of FORBIDDEN) {
    if (f.re.test(src)) return f.name;
  }
  return null;
}

/**
 * 无 LaTeX 检查。服务器上没装 LaTeX，任何走 TeX 编译的类都会在
 * `compile_tex` 里以 FileNotFoundError: [WinError 2] 失败（报错完全看不出是缺 LaTeX）。
 * 命中就提前拒收，别浪费一次 20 秒的渲染。
 *
 * 注意 `\bTex\s*\(` 不会误伤 `Text(`：Tex 后面紧跟 t，不满足 `\s*\(`。
 */
const LATEX_ONLY = [
  { re: /\bMathTex\b/m, name: 'MathTex' },
  { re: /\bSingleStringMathTex\b/m, name: 'SingleStringMathTex' },
  { re: /\bTex\s*\(/m, name: 'Tex(' },
  { re: /\bTexTemplate\b/m, name: 'TexTemplate' },
  { re: /\bDecimalNumber\b/m, name: 'DecimalNumber' },
  { re: /\bInteger\s*\(/m, name: 'Integer(' },
  { re: /\binclude_numbers\s*=/m, name: 'include_numbers（Axes 的刻度数字是 DecimalNumber，走 LaTeX）' },
];

/** 返回命中的 LaTeX-only 名字，或 null */
function checkNoLatex(code) {
  // LaTeX 已装（MiKTeX 25.12，pdflatex + dvisvgm 可用），MathTex/Tex 现在能编译，
  // 所以这里只留一个开关：DSH_MANIM_LATEX=0 时才重新拦截（例如换到没有 LaTeX 的机器）。
  if (process.env.DSH_MANIM_LATEX !== '0') return null;
  const src = String(code == null ? '' : code);
  for (const f of LATEX_ONLY) {
    if (f.re.test(src)) return f.name;
  }
  return null;
}

/** 从脚本里猜场景类名：模型没给 manim.scene 时用 */
function guessSceneName(code) {
  const m = String(code || '').match(/class\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\.)?Scene\s*\)/u);
  return m ? m[1] : null;
}

// ------------------------------------------------ 文字字重/字号兜底（确定性） --

/**
 * 为什么要在渲染前改模型写的代码：
 *   manim 的 `Text` 默认字重是 NORMAL，字号默认 48。模型很爱写 `Text("标题", font_size=32)`
 *   —— 32 号 + 常规字重，投到大屏、再经 ffmpeg 编码，笔画就糊成一条灰线（用户实测
 *   "第一分镜字很细"）。提示词里写死约束只能降低概率，不能保证；这里做一次**确定性**改写：
 *   - 标题类（后面链着 .to_edge(UP) / .to_corner(UL|UR)，或 font_size ≥ 40）：
 *     没有 weight= 就补 `weight=BOLD`；字号 < 44 抬到 44。
 *   - 所有 Text：font_size < 28 抬到 28（再小就真的看不清了）。
 *   - 中文文本没写 font= 时补 font="Microsoft YaHei"（否则 fallback 字体没有中文字形，出方框）。
 *
 * 边界（宁可少改，不可改坏）：
 *   - 已经有 weight= 的一律不动 —— 模型显式写了 NORMAL 就尊重它；
 *   - 只认 Text / MarkupText，**绝不碰 MathTex**（LaTeX 的字重由数学字体决定，改了就乱套）；
 *   - 括号配对用逐字符扫描（跳过字符串与 # 注释），不靠正则硬套 —— 多行调用、字符串里带
 *     逗号/括号都能正确切开。
 */
const ENHANCE_TEXT_RE = /\b(Text|MarkupText)\s*\(/g;
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const ENHANCE_TITLE_MIN = 44;
const ENHANCE_BODY_MIN = 28;

/** 从 openIdx（指向 '(' 的下标）开始找配对的 ')'；跳过字符串字面量与 # 注释。找不到返回 -1。 */
function findCallEnd(src, openIdx) {
  let depth = 0;
  let quote = '';
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 把一段参数列表按顶层逗号切开（字符串/括号里的逗号不算）。 */
function splitTopArgs(args) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += args[i + 1] || ''; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 调用后面的链式方法里有没有"贴到顶部"—— 有就是标题。 */
function looksLikeTitleChain(chain) {
  return /\.\s*(?:to_edge|to_corner|move_to|align_to|next_to)\s*\(\s*(?:UP|UL|UR)\b/.test(String(chain || ''));
}

/**
 * 改写一段 Text(...) 的参数，返回 { args, bold, sized, font }（都是"改了几处"的计数）。
 * 所有改动都是追加关键字参数或替换 font_size 的数字，不改动原有参数顺序。
 */
function enhanceTextArgs(args, chain) {
  const parts = splitTopArgs(args);
  const out = { args, bold: 0, sized: 0, font: 0 };
  if (!parts.length) return out;
  let hasWeight = false;
  let hasFont = false;
  let sizeIdx = -1;
  let fontSize = null;
  let firstString = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\s*weight\s*=/.test(p)) hasWeight = true;
    if (/^\s*font\s*=/.test(p)) hasFont = true;
    const fm = p.match(/^\s*font_size\s*=\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (fm) { sizeIdx = i; fontSize = Number(fm[1]); }
    if (!firstString) {
      const sm = p.match(/^\s*[rRbBfFuU]{0,2}("([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/);
      if (sm) firstString = String(sm[2] != null ? sm[2] : sm[3]);
    }
  }
  // 标题判定：字号 ≥40 或链式贴顶部。字号 ≥40 已经接近 manim 默认 48，基本只会是标题。
  const titleLike = (fontSize != null && fontSize >= 40) || looksLikeTitleChain(chain);

  if (sizeIdx >= 0) {
    const want = titleLike ? Math.max(ENHANCE_TITLE_MIN, fontSize) : Math.max(ENHANCE_BODY_MIN, fontSize);
    if (want !== fontSize) {
      // 用原参数的缩进风格替换数字，保留 `font_size = 44` 这种写法
      parts[sizeIdx] = parts[sizeIdx].replace(/(-?\d+(?:\.\d+)?)/, String(want));
      out.sized = 1;
    }
  }
  if (!hasWeight && titleLike) { parts.push(' weight=BOLD'); out.bold = 1; }
  if (!hasFont && CJK_RE.test(firstString)) { parts.push(' font="Microsoft YaHei"'); out.font = 1; }

  if (out.bold || out.sized || out.font) out.args = parts.join(',');
  return out;
}

/**
 * 对整段 manim 脚本做一次字重/字号兜底。返回 { code, stats }。
 * stats = { calls, bold, sized, font, minSize }，用于渲染日志里报"改写了几处"。
 */
function enhanceTextStyle(code) {
  const src = String(code == null ? '' : code);
  const stats = { calls: 0, bold: 0, sized: 0, font: 0, minSize: 0 };
  let out = '';
  let cursor = 0;
  ENHANCE_TEXT_RE.lastIndex = 0;
  let m;
  while ((m = ENHANCE_TEXT_RE.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = findCallEnd(src, open);
    if (close < 0) break; // 括号不配对：剩下的原样保留，不冒险改
    const args = src.slice(open + 1, close);
    const chain = src.slice(close + 1, close + 160);
    const fixed = enhanceTextArgs(args, chain);
    out += src.slice(cursor, open + 1) + fixed.args;
    cursor = close;
    ENHANCE_TEXT_RE.lastIndex = close + 1;
    stats.calls += 1;
    stats.bold += fixed.bold;
    stats.sized += fixed.sized;
    stats.font += fixed.font;
    if (fixed.sized) {
      const fm = fixed.args.match(/font_size\s*=\s*(-?\d+(?:\.\d+)?)/);
      if (fm) stats.minSize = stats.minSize ? Math.min(stats.minSize, Number(fm[1])) : Number(fm[1]);
    }
  }
  out += src.slice(cursor);
  return { code: out, stats };
}

/** 跑一个子进程并把 stdout/stderr 收起来（和 render.js 里的 run 同形，但不跨模块引依赖） */
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
      resolve({ code: -1, out: '', err: String(err && err.message || err), timedOut: false });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 必须杀整棵树：manim 主进程下面还挂着 ffmpeg，只杀 python 会让 ffmpeg 继续写文件
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        try { child.kill(); } catch { }
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e && e.message || e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

/**
 * 找 manim 的成片。
 *
 * 不写死 `media/videos/<stem>/720p30/out.mp4`：只要命令行里给了 -r 改分辨率，
 * manim 的目录名就会跟着变成 `1080p30` 之类，写死必然在某个版本上失效。
 * 所以先按约定路径试一遍，再在 media 目录里按修改时间找最新的 out.mp4。
 */
function findOutput(mediaRoot, stem) {
  const base = path.join(mediaRoot, 'videos', stem);
  const tried = [];
  try {
    for (const q of fs.readdirSync(base)) {
      const p = path.join(base, q, 'out.mp4');
      tried.push(p);
      if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
    }
  } catch { /* 目录不存在：走下面的递归兜底 */ }

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
        } catch { }
      }
    }
  };
  walk(path.join(mediaRoot, 'videos'), 0);
  if (best) return best.file;
  return tried[0] || path.join(base, 'out.mp4');
}

/**
 * 删掉 partial_movie_files：它是按场景切片的中间文件，体积能占到一半，渲完就没用了。
 *
 * 只扫**这一场自己的 media 目录**（media-<index>）。场级并行之后多个 manim 同时在跑，
 * 以前扫整个 work/media 会在别的场还没渲完时把它的 partial 删掉 —— 轻则重算、重则报错。
 */
function cleanPartials(mediaRoot) {
  let freed = 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (!e.isDirectory()) continue;
      if (e.name === 'partial_movie_files') {
        try {
          const size = dirSize(p);
          fs.rmSync(p, { recursive: true, force: true });
          freed += size;
        } catch { }
      } else {
        walk(p, depth + 1);
      }
    }
  };
  walk(mediaRoot, 0);
  return freed;
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch { } }
  }
  return total;
}

/**
 * 探一个视频的宽高、帧率与时长。
 *
 * 为什么不用 ffprobe：服务器上 ffmpeg 目录里只有 ffmpeg.exe，没有 ffprobe.exe。
 * `ffmpeg -i <file>` 不接输出时必定报错退出，但它会把读到的元信息整段打到 stderr，
 * 里面正好有 `Duration: 00:00:05.00` 和 `Video: ..., 1920x1080 ..., 30 fps`。
 * 解析这几行比多装一个 exe 划算，也不会因为缺 ffprobe 就退化成"每次都盲目重编码"。
 */
async function probeVideo(ffmpeg, file) {
  if (!ffmpeg || !fs.existsSync(ffmpeg)) return null;
  const r = await run(ffmpeg, ['-hide_banner', '-i', file], 20000);
  const text = String(r.err || '');
  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dim = text.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  const fpsm = text.match(/(\d+(?:\.\d+)?)\s*fps\b/);
  if (!dim) return null;
  return {
    width: Number(dim[1]),
    height: Number(dim[2]),
    fps: fpsm ? Number(fpsm[1]) : 0,
    duration: dur ? (Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) : 0,
  };
}

/**
 * 把 manim 的 mp4 统一成项目规格（宽高 + fps + 时长）。
 *
 * 为什么不直接拼：xfade 要求两路输入尺寸一致、而且 offset 必须落在片段内部。
 * manim 的动画长度是"脚本里各段 run_time 之和"，不可能恰好等于这一场的秒数
 * （旁白驱动时长后更是经常不等），短了拼接时第一路会在 offset 之前就结束，
 * 长了又会在下一场开始后还在播。所以这里统一：缩放补边 + 补帧到目标时长 + 截断。
 * 已经是目标规格且时长够的，只做复制，不多花一秒。
 */
async function normalizeClip({ ffmpeg, inFile, outFile, w, h, fps, seconds = 0, threads = 0 }) {
  const info = await probeVideo(ffmpeg, inFile);
  const want = Number(seconds) || 0;
  const sameSize = info && info.width === w && info.height === h && Math.abs(info.fps - fps) < 0.6;
  const sameLen = !want || (info && Math.abs(info.duration - want) < 0.08);
  if (sameSize && sameLen) {
    fs.copyFileSync(inFile, outFile);
    return { ok: true, file: outFile, reencoded: false, info };
  }

  const pad = want && info ? Math.max(0, want - info.duration) : 0;
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
    // 动画比这一场短：把最后一帧克隆出来撑满，看起来是"停在这里"，不会黑屏或丢帧
    ...(pad > 0.02 ? [`tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`] : []),
    'format=yuv420p',
  ].join(',');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-vf', vf];
  if (want) args.push('-t', String(want));
  // 显式给编码线程：场级并行时 -threads 2 给其它 manim 留核；串行时 0 = ffmpeg 自己吃满
  args.push('-threads', String(Math.max(0, Math.floor(Number(threads) || 0))));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outFile);
  const r = await run(ffmpeg, args, 180000);
  if (r.code !== 0 || !fs.existsSync(outFile)) {
    return { ok: false, error: `MANIM_RECODE_FAILED: ${String(r.err).slice(-300)}`, info };
  }
  return { ok: true, file: outFile, reencoded: true, info };
}

/**
 * 渲一段 manim。
 *
 * 参数：
 *   python     python 解释器（要装好 manim）
 *   work       本次渲染的临时目录（脚本、media、输出都在这里）
 *   index      场次序号（脚本文件名用，多个 manim 场不会互相覆盖）
 *   code       模型写的 manim 脚本
 *   sceneName  场景类名；不传就从脚本里 grep
 *   quality    manim 画质参数，默认 -qm
 *   seconds    这场要演多久（只用于估超时）
 *   w/h/fps    目标规格；给了就把结果统一成这个规格
 *
 * 返回 { ok, file, error, ms }，error 为 'UNSAFE_CODE' 时上层必须退回别的引擎。
 */
async function renderManim({
  python, work, index, code, sceneName = null, quality = '-qm',
  timeoutMs = null, seconds = 0, w = 0, h = 0, fps = 0,
  // renderW/renderH = manim **实际渲染**的分辨率；w/h = normalizeClip 的**产出**规格。
  // 草稿档（renderQuality:low）要的是"少画像素、再放大回 1080p"，所以两者必须能分开传。
  renderW = 0, renderH = 0,
  ffmpeg = null, timeoutBaseMs = 20000, timeoutPerSecondMs = 3000, threads = 0,
}) {
  const started = Date.now();
  if (!code || typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'NO_CODE', file: null, ms: 0 };
  }
  if (!python || !fs.existsSync(python)) {
    return { ok: false, error: 'NO_PYTHON', file: null, ms: 0 };
  }

  // 文字兜底：先按"标题必须粗且大、正文不许太小"改写一遍，再做安全检查 ——
  // 校验的必须是最终会跑的那份代码（改写只加 weight/font、只调 font_size，不加任何调用）。
  const enhanced = enhanceTextStyle(code);
  const finalCode = enhanced.code;
  const textEnhance = enhanced.stats;

  // 安全过滤放在最前面：命中就立刻返回，不落盘、不起进程
  const hit = checkCode(finalCode);
  if (hit) {
    return { ok: false, error: 'UNSAFE_CODE', detail: hit, file: null, ms: Date.now() - started };
  }
  // 无 LaTeX：提前拒收，省一次注定失败的渲染
  const latex = checkNoLatex(finalCode);
  if (latex) {
    return { ok: false, error: 'NO_LATEX', detail: latex, file: null, ms: Date.now() - started };
  }

  const name = SCENE_NAME_RE.test(String(sceneName || '')) ? String(sceneName) : guessSceneName(finalCode);
  if (!name) return { ok: false, error: 'NO_SCENE_NAME', file: null, ms: Date.now() - started };

  const stem = `manim-${index}`;
  const script = path.join(work, `${stem}.py`);
  // 每场一个独立的 media 目录：场级并行时 manim 的临时文件/Tex 缓存/partial 互不干扰
  const mediaDir = path.join(work, `media-${index}`);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(script, String(finalCode), 'utf8');

  const q = String(quality || '-qm');
  const args = ['-m', 'manim', 'render', q, '--disable_caching', '--media_dir', mediaDir];
  // 分辨率/帧率显式给：项目是 1080p30，manim 的 -qm 默认 720p30，不覆盖就得再缩放一次。
  // 传了 renderW/renderH 就用它渲染，产出规格仍按 w/h（由 normalizeClip 统一）。
  const rw = Number(renderW) > 0 ? Number(renderW) : Number(w);
  const rh = Number(renderH) > 0 ? Number(renderH) : Number(h);
  if (rw > 0 && rh > 0) args.push('-r', `${rw},${rh}`);
  if (Number(fps) > 0) args.push('--fps', String(Number(fps)));
  args.push('-o', 'out.mp4', script, name);

  // 超时估算：基线 + 每秒时长 × 倍率。默认 20s + 3×时长（任务书的估算），
  // 但实测"带 Axes + 4K 中文 Text"的场次在并发渲染时会到 30s 以上，
  // 所以基线/倍率都留了 config.json 的可调项（manimTimeoutBaseMs / manimTimeoutPerSecondMs）。
  const base = Number(timeoutBaseMs) > 0 ? Number(timeoutBaseMs) : 20000;
  const perSec = Number(timeoutPerSecondMs) > 0 ? Number(timeoutPerSecondMs) : 3000;
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : (base + perSec * Math.max(0, Number(seconds) || 0));

  const r = await run(python, args, budget, {
    cwd: work,
    // 环境收窄：TMP 指到本次 work，manim 的临时文件不会堆到系统盘；
    // 保留 user site（manim 有可能是 pip --user 装的），所以不清 PYTHONNOUSERSITE。
    // PATH 里必须补上 ffmpeg 所在目录：manim 合成 partial 片段时是**自己 spawn ffmpeg** 的，
    // 服务器上的 ffmpeg 只在 tools\ffmpeg\bin 下、不在系统 PATH，不补就会在 Popen 里
    // 抛 FileNotFoundError: [WinError 2]（报错还长得像 manim 的错）。
    env: {
      PYTHONPATH: '',
      PYTHONIOENCODING: 'utf-8',
      TMP: work, TEMP: work, TMPDIR: work,
      PATH: ffmpeg ? `${path.dirname(ffmpeg)};${process.env.PATH || ''}` : (process.env.PATH || ''),
    },
  });

  const ms = Date.now() - started;
  const out = findOutput(mediaDir, stem);
  const exists = fs.existsSync(out) && fs.statSync(out).size > 1000;

  // 不管成功失败都清一次：失败时磁盘上更可能残留一堆 partial
  let freed = 0;
  try { freed = cleanPartials(mediaDir); } catch { }

  if (r.timedOut) {
    return { ok: false, error: `MANIM_TIMEOUT(${budget}ms)`, file: null, ms, partialFreed: freed, textEnhance };
  }
  if (!exists || r.code !== 0) {
    const tail = String(r.err || r.out || '').slice(-600);
    return { ok: false, error: `MANIM_FAILED(code=${r.code}) ${tail}`, file: null, ms, partialFreed: freed, textEnhance };
  }

  // 规格统一：给了目标宽高就保证拼得上
  if (Number(w) > 0 && Number(h) > 0 && ffmpeg) {
    const norm = await normalizeClip({
      ffmpeg, inFile: out, outFile: path.join(work, `manim-${index}-norm.mp4`),
      w, h, fps: Number(fps) || 30, seconds: Number(seconds) || 0, threads,
    });
    if (!norm.ok) {
      return { ok: false, error: norm.error, file: null, ms: Date.now() - started, partialFreed: freed, textEnhance };
    }
    return {
      ok: true, file: norm.file, error: null, ms: Date.now() - started,
      rawFile: out, reencoded: norm.reencoded, sourceInfo: norm.info, partialFreed: freed, textEnhance,
    };
  }

  return { ok: true, file: out, error: null, ms, partialFreed: freed, textEnhance };
}

module.exports = {
  renderManim, checkCode, checkNoLatex, normalizeClip, probeVideo, guessSceneName,
  // 字重/字号兜底（纯函数，单测和后台脚本可以单独调）
  enhanceTextStyle,
};
