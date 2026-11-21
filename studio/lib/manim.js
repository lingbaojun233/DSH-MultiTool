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
function findOutput(work, stem) {
  const base = path.join(work, 'media', 'videos', stem);
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
  walk(path.join(work, 'media', 'videos'), 0);
  if (best) return best.file;
  return tried[0] || path.join(base, 'out.mp4');
}

/** 删掉 partial_movie_files：它是按场景切片的中间文件，体积能占到一半，渲完就没用了 */
function cleanPartials(work) {
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
  walk(path.join(work, 'media'), 0);
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
async function normalizeClip({ ffmpeg, inFile, outFile, w, h, fps, seconds = 0 }) {
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
  ffmpeg = null, timeoutBaseMs = 20000, timeoutPerSecondMs = 3000,
}) {
  const started = Date.now();
  if (!code || typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'NO_CODE', file: null, ms: 0 };
  }
  if (!python || !fs.existsSync(python)) {
    return { ok: false, error: 'NO_PYTHON', file: null, ms: 0 };
  }

  // 安全过滤放在最前面：命中就立刻返回，不落盘、不起进程
  const hit = checkCode(code);
  if (hit) {
    return { ok: false, error: 'UNSAFE_CODE', detail: hit, file: null, ms: Date.now() - started };
  }
  // 无 LaTeX：提前拒收，省一次注定失败的渲染
  const latex = checkNoLatex(code);
  if (latex) {
    return { ok: false, error: 'NO_LATEX', detail: latex, file: null, ms: Date.now() - started };
  }

  const name = SCENE_NAME_RE.test(String(sceneName || '')) ? String(sceneName) : guessSceneName(code);
  if (!name) return { ok: false, error: 'NO_SCENE_NAME', file: null, ms: Date.now() - started };

  const stem = `manim-${index}`;
  const script = path.join(work, `${stem}.py`);
  const mediaDir = path.join(work, 'media');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(script, String(code), 'utf8');

  const q = String(quality || '-qm');
  const args = ['-m', 'manim', 'render', q, '--disable_caching', '--media_dir', mediaDir];
  // 分辨率/帧率显式给：项目是 1080p30，manim 的 -qm 默认 720p30，不覆盖就得再缩放一次
  if (Number(w) > 0 && Number(h) > 0) args.push('-r', `${Number(w)},${Number(h)}`);
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
  const out = findOutput(work, stem);
  const exists = fs.existsSync(out) && fs.statSync(out).size > 1000;

  // 不管成功失败都清一次：失败时磁盘上更可能残留一堆 partial
  let freed = 0;
  try { freed = cleanPartials(work); } catch { }

  if (r.timedOut) {
    return { ok: false, error: `MANIM_TIMEOUT(${budget}ms)`, file: null, ms, partialFreed: freed };
  }
  if (!exists || r.code !== 0) {
    const tail = String(r.err || r.out || '').slice(-600);
    return { ok: false, error: `MANIM_FAILED(code=${r.code}) ${tail}`, file: null, ms, partialFreed: freed };
  }

  // 规格统一：给了目标宽高就保证拼得上
  if (Number(w) > 0 && Number(h) > 0 && ffmpeg) {
    const norm = await normalizeClip({
      ffmpeg, inFile: out, outFile: path.join(work, `manim-${index}-norm.mp4`),
      w, h, fps: Number(fps) || 30, seconds: Number(seconds) || 0,
    });
    if (!norm.ok) return { ok: false, error: norm.error, file: null, ms: Date.now() - started, partialFreed: freed };
    return {
      ok: true, file: norm.file, error: null, ms: Date.now() - started,
      rawFile: out, reencoded: norm.reencoded, sourceInfo: norm.info, partialFreed: freed,
    };
  }

  return { ok: true, file: out, error: null, ms, partialFreed: freed };
}

module.exports = { renderManim, checkCode, checkNoLatex, normalizeClip, probeVideo, guessSceneName };
