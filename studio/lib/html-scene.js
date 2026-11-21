'use strict';
/**
 * html-scene.js -- 把模型给的 HTML/SVG「讲解画面」截成 1920x1080 静帧，再拼成分步片段。
 *
 * 为什么用浏览器截图，而不是继续用 drawtext：
 *   讲解画面要的是坐标系、曲线、表格、公式上下标和左右分栏排版；ffmpeg 的 drawtext
 *   只能摆几行纯文字，讲不了图和公式。浏览器本身就是完整的排版/渲染引擎，模型只写
 *   HTML，我们负责套一个稳定模板、按步切状态、截图。
 *
 * 为什么不引 npm / CDN：
 *   出片环境无外网，多一个依赖就多一处装不上的风险。模板样式全部内联，SVG 由模型
 *   直接写进 HTML；截图只依赖本机已安装的 Edge（或 Chrome）。
 *
 * 为什么截完必须"验非空白"：
 *   无头浏览器失败时最常见的表现不是报错退出，而是静默写出一张纯白/纯色图：
 *   渲染进程没起来、文件还没写完进程就没了、字体/布局还没就绪就截了。这种图交给
 *   ffmpeg 不会报任何错，成片里就是几秒白屏。所以在交付前自己解码 PNG 看像素：
 *   颜色种类太少且体积过小就判失败，重试一次；两次都空则整场失败，绝不把白屏
 *   混进片子。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const DEFAULT_W = 1920;
const DEFAULT_H = 1080;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_STEPS = 12;          // 分步上限：再多就不像"讲解"，而且 SSE/缓存也会变重
const BLANK_MIN_BYTES = 20 * 1024; // 空白图阈值：1920x1080 纯色 PNG 一般 5~10KB
const BLANK_MIN_COLORS = 6;        // "颜色种类 > 5"

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function intIn(v, fallback, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** 文件名里只留安全字符：index 由调用方给，但没必要让它有拼接路径的机会 */
function tagOf(index) {
  return String(index == null ? 0 : index).replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 40) || '0';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 跑一个子进程并带超时。超时必须杀进程树：Edge 会再拉起 GPU/渲染/网络等子进程，
 * 只 kill 父进程会留下一堆孤儿进程，下一次截图可能被上一个实例的 profile 锁挡住。
 */
function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;

    const append = (buf) => {
      const s = buf.toString('utf8');
      if (stderr.length < 20000) stderr += s.slice(0, 20000 - stderr.length);
    };

    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore',
          }).on('error', () => {});
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* 进程可能已经退了，taskkill 找不到也无所谓 */ }
      try { child.kill(); } catch { /* 同上 */ }
      // 不等 close：taskkill 之后 close 有时会拖很久，这里给 1.5s 收尸时间后直接返回。
      // 调用方只关心"有没有在时限内写完文件"，残留句柄交给 taskkill。
      setTimeout(() => finish({
        code: -1, stdout, stderr: stderr + '\n[TIMEOUT]', timedOut: true,
      }), 1500);
    }, Math.max(3000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    child.stdout.on('data', (d) => { if (stdout.length < 4000) stdout += d.toString('utf8').slice(0, 4000 - stdout.length); });
    child.stderr.on('data', append);
    child.on('error', (e) => finish({ code: -1, stdout, stderr: String(e && e.message || e), timedOut: false }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

/* ------------------------------------------------------------------ */
/* PNG 检查：不靠第三方库，自己读 IHDR/IDAT 并解滤波                    */
/* ------------------------------------------------------------------ */

/**
 * 读 PNG 的尺寸、颜色种类和字节数。
 * 只支持"8 位、非隔行"的常见截图格式（Chrome/Edge 截图默认就是 8 位非隔行）；
 * 其它格式不硬解，只返回字节数——判定空白时还有"体积够大"这条兜底。
 */
function readPngStats(file) {
  const out = { file, bytes: 0, w: 0, h: 0, colors: -1, decoded: false, error: '' };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    out.error = String(err && err.message || err);
    return out;
  }
  out.bytes = buf.length;
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    out.error = 'NOT_PNG';
    return out;
  }

  let off = 8;
  let ihdr = null;
  let plte = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (end + 4 > buf.length) break; // 截断的块：后面的数据不可信
    if (type === 'IHDR') {
      if (len < 13) { out.error = 'BAD_IHDR'; return out; }
      ihdr = {
        w: buf.readUInt32BE(start),
        h: buf.readUInt32BE(start + 4),
        depth: buf[start + 8],
        color: buf[start + 9],
        interlace: buf[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'PLTE') {
      plte = buf.subarray(start, end);
    } else if (type === 'IEND') {
      break;
    }
    off = end + 4;
  }

  if (!ihdr) { out.error = 'NO_IHDR'; return out; }
  out.w = ihdr.w;
  out.h = ihdr.h;

  const bppMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = bppMap[ihdr.color];
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || !bpp || !idat.length) {
    out.error = 'UNSUPPORTED_PNG';
    return out;
  }
  if (ihdr.color === 3 && (!plte || plte.length < 3)) {
    out.error = 'NO_PALETTE';
    return out;
  }

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    out.error = String(err && err.message || err);
    return out;
  }

  const stride = ihdr.w * bpp;
  if (raw.length < ihdr.h * (stride + 1)) {
    out.error = 'SHORT_IMAGE_DATA';
    return out;
  }

  // PNG 每行开头一个滤波类型字节，像素是差分编码的，必须逐行反推才能拿到真实颜色。
  // 行内采样而不是整图解码：判定只需要"颜色是否超过 5 种"，采 160x120 网格足够，
  // 大图也能在几十毫秒内出结果。
  const colors = new Set();
  const sx = Math.max(1, Math.floor(ihdr.w / 160));
  const sy = Math.max(1, Math.floor(ihdr.h / 120));
  let prev = Buffer.alloc(stride);
  let pos = 0;

  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[pos++];
    const row = Buffer.allocUnsafe(stride);
    raw.copy(row, 0, pos, pos + stride);
    pos += stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) {
        v = (v + a) & 255;
      } else if (filter === 2) {
        v = (v + b) & 255;
      } else if (filter === 3) {
        v = (v + ((a + b) >> 1)) & 255;
      } else if (filter === 4) {
        // Paeth 预测：取 a/b/c 中与 p=a+b-c 最接近的那个
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      row[x] = v;
    }

    if (y % sy === 0) {
      for (let x = 0; x < ihdr.w; x += sx) {
        const i = x * bpp;
        let r;
        let g;
        let bl;
        if (ihdr.color === 6 || ihdr.color === 2) {
          r = row[i]; g = row[i + 1]; bl = row[i + 2];
        } else if (ihdr.color === 0 || ihdr.color === 4) {
          r = row[i]; g = row[i]; bl = row[i];
        } else {
          const idx = row[i];
          r = plte[idx * 3]; g = plte[idx * 3 + 1]; bl = plte[idx * 3 + 2];
        }
        colors.add((r << 16) | (g << 8) | bl);
        if (colors.size >= 4096) break;
      }
    }
    prev = row;
  }

  out.colors = colors.size;
  out.decoded = true;
  return out;
}

/**
 * 空白判定：颜色种类 > 5 或 字节数 > 20KB 才算"有内容"。
 * 两条用"或"是故意的：
 *   - 纯白/纯色图颜色只有 1 种、体积通常 < 10KB，两条都不过；
 *   - 大尺寸但色彩简单（比如只有背景+边框）的图体积仍可能 > 20KB，不能误杀；
 *   - 解码失败（罕见格式）时只能靠体积兜底，总比把可能的图直接扔掉好。
 * 反过来说，一张空模板图（深色底+边框+标题）颜色很多、体积也不小，这里会放行 ——
 * 这是"画面本身合法"而不是"浏览器失败"，不属于该判空白的场景。
 */
function isPngUsable(stats) {
  if (!stats || !stats.bytes) return false;
  if (stats.bytes > BLANK_MIN_BYTES) return true;
  if (stats.decoded && stats.colors >= BLANK_MIN_COLORS) return true;
  return false;
}

function statsText(stats) {
  if (!stats) return 'no-file';
  return `${stats.bytes}B ${stats.w || '?'}x${stats.h || '?'} colors=${stats.colors}${stats.error ? ' err=' + stats.error : ''}`;
}

/* ------------------------------------------------------------------ */
/* HTML 模板                                                           */
/* ------------------------------------------------------------------ */

/**
 * steps 数组 → 合法 class 名。
 * 非法名直接跳过（模型偶尔会写 "第1步" 这种不是 class 名的东西）；只有全都不合法时才报错，
 * 因为那说明调用方把参数传错了，渲染一张"没有分步"的图会掩盖问题。
 * 重名去重：同一个 class 的多个"步"没有意义，保留第一次出现的位置。
 */
function normalizeStepNames(steps) {
  if (steps == null) return { names: [] };
  if (!Array.isArray(steps)) return { error: 'STEPS_NOT_ARRAY: steps 必须是字符串数组' };
  const names = [];
  for (const raw of steps.slice(0, MAX_STEPS)) {
    const name = String(raw == null ? '' : raw).trim();
    // CSS class 选择器安全字符；首字符不能是数字
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  if (steps.length > 0 && names.length === 0) {
    return { error: 'STEPS_INVALID: steps 里没有合法的 class 名（只允许字母/数字/下划线/短横）' };
  }
  return { names };
}

/**
 * 分步规则。两层：
 *
 * 1) 通用 .step-N（N=1..9）：按约定预置，data-step < N 时透明。
 *    它不依赖 steps 数组，手写 class="step-1" 的 HTML 也能吃到这条规则。
 *
 * 2) steps 数组里的名字：数组顺序就是出现顺序，第 k 个（0 基）从第 k 张开始出现。
 *    这是给"渲染器知道有几张图"的场景用的 —— 例如 steps:['p1','p2','p3'] 渲 3 张，
 *    p1 在第 1 张就出现。规则写在通用规则之后，同名时以数组语义为准。
 *
 * 只改 opacity 不改 display：元素始终占位，分步切换时版式不跳，图/公式不会突然挪位置。
 */
function buildStepCss(names, count) {
  const rules = [];
  for (let n = 1; n <= 9; n++) {
    for (let i = 0; i < n; i++) {
      rules.push(`body[data-step="${i}"] .step-${n}{opacity:0}`);
    }
  }
  if (names.length) {
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < names.length; k++) {
        rules.push(`body[data-step="${i}"] .${names[k]}{opacity:${i >= k ? 1 : 0}}`);
      }
    }
  }
  return rules.join('\n');
}

/**
 * 把模型片段套进固定画布。
 * 所有颜色/字号/间距都走 CSS 变量：以后统一调风格只改 :root 一处，不用动模型 HTML。
 * 内容区默认 2px 描边 + 大内边距，保证文字/图不会贴边；overflow:hidden 在 html/body
 * 上禁止滚动，滚动条和"内容超出后可滚动"都会让截图尺寸/位置漂移。
 */
function buildHtmlDocument({ html, title, stepNames, stepIndex, w, h }) {
  const hasTitle = String(title || '').trim() !== '';
  const dataStep = stepNames.length ? String(stepIndex) : '9'; // 无 steps：单张全展示
  const css = buildStepCss(stepNames, stepNames.length || 1);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- 强制离线：模型手滑写了 CDN 时直接失败，而不是让截图等网络超时 -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:">
<title>${hasTitle ? escapeHtml(title) : '讲解画面'}</title>
<style>
:root{
  --bg:#0d1220;
  --bg-glow:#131c33;
  --fg:#eef4ff;
  --muted:#93a4c4;
  --accent:#5aa9ff;
  --accent-warm:#ffd166;
  --panel:rgba(255,255,255,.035);
  --panel-border:rgba(120,170,255,.22);
  --line:rgba(120,170,255,.38);
  --safe-inset:44px;
  --frame-border:2px;
  --frame-radius:22px;
  --frame-pad-y:30px;
  --frame-pad-x:60px;
  --title-size:40px;
  --title-gap:8px;
  --body-size:34px;
  --h1-size:56px;
  --formula-size:62px;
  --caption-size:26px;
  --gap:28px;
}
*{box-sizing:border-box}
html,body{
  margin:0;padding:0;
  width:${w}px;height:${h}px;
  overflow:hidden;                /* 禁止滚动：截图必须和画布严格对齐 */
  background:var(--bg);
  color:var(--fg);
  font-family:"Microsoft YaHei","微软雅黑","Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
body{position:relative}
.stage{
  position:absolute;inset:0;
  background:radial-gradient(1200px 800px at 50% 42%,var(--bg-glow) 0%,var(--bg) 72%);
}
.frame{
  position:absolute;inset:var(--safe-inset);
  border:var(--frame-border) solid var(--line);
  border-radius:var(--frame-radius);
  padding:var(--frame-pad-y) var(--frame-pad-x) calc(var(--frame-pad-y) + 8px);
  display:flex;flex-direction:column;
  overflow:hidden;
}
.title{
  flex:0 0 auto;
  display:flex;align-items:center;gap:16px;
  margin-bottom:var(--title-gap);
  font-size:var(--title-size);
  letter-spacing:.12em;
  color:var(--muted);
}
.title::before{
  content:"";
  width:10px;height:26px;border-radius:3px;
  background:var(--accent);
}
.content{
  flex:1;min-height:0;
  display:flex;align-items:center;justify-content:center;
  overflow:hidden;                /* 模型写超了宁裁不滚，滚动会让截图错位 */
}
/* 给模型的常用排版件：一边图一边字时用 .row + .col */
.row{display:flex;align-items:center;justify-content:center;gap:64px;width:100%}
.col{display:flex;flex-direction:column;justify-content:center;gap:var(--gap)}
.panel{background:var(--panel);border:1px solid var(--panel-border);border-radius:18px;padding:24px}
.h1{font-size:var(--h1-size);line-height:1.2;margin:0;font-weight:700}
.lead{font-size:var(--body-size);line-height:1.65;color:var(--fg);margin:0}
.caption{font-size:var(--caption-size);color:var(--muted);text-align:center;margin-top:12px}
.formula{font-size:var(--formula-size);line-height:1.35;color:var(--fg);letter-spacing:.02em;white-space:nowrap}
.formula em{font-style:italic;color:var(--accent)}
.k{color:var(--accent)}
.warm{color:var(--accent-warm)}
/* 公式上下标：微软雅黑自带的上下标容易贴字，这里手工抬/压一点 */
sup,sub{font-size:.62em;line-height:0;position:relative;vertical-align:baseline}
sup{top:-.52em}
sub{bottom:-.28em}
svg{display:block;max-width:100%;max-height:100%}
svg text{font-family:"Microsoft YaHei","微软雅黑","Segoe UI",sans-serif}
img,video{max-width:100%;max-height:100%}
table{border-collapse:collapse;font-size:var(--body-size)}
th,td{border:1px solid var(--panel-border);padding:10px 18px;text-align:center}
th{color:var(--accent)}
${css}
</style>
</head>
<body data-step="${dataStep}">
<div class="stage">
  <div class="frame">
    ${hasTitle ? `<div class="title">${escapeHtml(title)}</div>` : ''}
    <div class="content">
${html}
    </div>
  </div>
</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* 浏览器定位与截图                                                    */
/* ------------------------------------------------------------------ */

/** 找浏览器：显式 edgePath 优先；没给就按本机常见安装位置猜（Server 上就是 Edge） */
function resolveBrowser(edgePath) {
  const want = String(edgePath == null ? '' : edgePath).trim();
  if (want) {
    if (isFile(want)) return want;
    throw new Error(`BROWSER_NOT_FOUND: ${want}`);
  }
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    );
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe'));
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  } else {
    candidates.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  throw new Error(`BROWSER_NOT_FOUND: 没找到 Edge/Chrome，请显式传 edgePath；找过 ${candidates.join(' | ')}`);
}

/**
 * 截一张图。
 * 关键参数（复现用）：
 *   --headless=new --disable-gpu --hide-scrollbars
 *   --window-size=1920,1080 --force-device-scale-factor=1
 *   --virtual-time-budget=2000
 *   --run-all-compositor-stages-before-draw
 *   --screenshot=<绝对路径> --user-data-dir=<临时 profile>
 *   file:///C:/...（pathToFileURL，正斜杠且中文/空格都被百分号编码）
 *
 * 为什么要单独 user-data-dir：服务器上可能正开着 Edge 的普通窗口，复用默认 profile 会
 * 撞单例锁，headless 直接退出不截图。每次截图用一个独立临时 profile，截完就删。
 */
async function captureOnce({ browser, htmlFile, pngFile, profileDir, timeoutMs, budget, w, h }) {
  try { fs.rmSync(pngFile, { force: true }); } catch { /* 旧文件删不掉也继续，成功会被覆盖 */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* 上次残留 */ }
  fs.mkdirSync(profileDir, { recursive: true });

  const url = pathToFileURL(htmlFile).href;
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${w},${h}`,
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    '--disable-lcd-text',                 // 深色底上的彩色次像素边缘在视频里会像糊了一层
    `--virtual-time-budget=${budget}`,
    '--run-all-compositor-stages-before-draw',
    `--screenshot=${pngFile}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    `--crash-dumps-dir=${profileDir}`,
    url,
  ];

  const started = Date.now();
  const r = await run(browser, args, timeoutMs);
  const ms = Date.now() - started;
  const stats = readPngStats(pngFile);

  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* Edge 可能还没完全退出 */ }

  return {
    ok: isPngUsable(stats),
    ms,
    stats,
    code: r.code,
    timedOut: !!r.timedOut,
    stderr: String(r.stderr || '').slice(0, 1200),
  };
}

/* ------------------------------------------------------------------ */
/* 对外 API 1：HTML → PNG                                              */
/* ------------------------------------------------------------------ */

/**
 * 把 HTML 片段渲染成 1920x1080 的 PNG（有 steps 就按步渲染多张）。
 *
 * @param {object} opts
 *   edgePath  浏览器可执行文件；不传则自动找本机 Edge/Chrome
 *   work      临时目录（HTML、PNG、浏览器 profile 都放这里）
 *   index     场景序号，用于文件名 html-<index>.png / html-<index>-<i>.png
 *   html      模型给的 HTML 片段，会被套进固定模板
 *   title     可选，画面顶部小标题
 *   steps     可选 class 名数组；数组长度 = 渲染张数，第 k 个从第 k 张开始出现
 *   w,h       画布尺寸，默认 1920x1080
 *   timeoutMs 每次截图超时，默认 30000
 * @returns {{ok:boolean, pngs:string[], error:string, timings?:object[]}}
 *
 * 重试策略：同一张最多截两次。第一次预算 2s；失败（空白/文件没出来）再加到 5s 重截。
 * 重试只针对"浏览器已启动但图不对"的偶发情况；浏览器路径错这类硬错误第一次就返回。
 */
async function renderHtmlStills(opts = {}) {
  const started = Date.now();
  try {
    const { edgePath, work, index, html, title, steps } = opts;
    const w = intIn(opts.w, DEFAULT_W, 64, 7680);
    const h = intIn(opts.h, DEFAULT_H, 64, 4320);
    const timeoutMs = intIn(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 3000, 180000);
    const htmlText = String(html == null ? '' : html);
    const titleText = String(title == null ? '' : title).trim();

    if (!work) return { ok: false, pngs: [], error: 'NO_WORK_DIR: 缺少 work 临时目录' };
    if (!htmlText.trim() && !titleText) {
      return { ok: false, pngs: [], error: 'EMPTY_HTML: html 和 title 都为空，截图只会得到空画布' };
    }

    const norm = normalizeStepNames(steps);
    if (norm.error) return { ok: false, pngs: [], error: norm.error };
    const names = norm.names;

    let browser;
    try {
      browser = resolveBrowser(edgePath);
    } catch (err) {
      return { ok: false, pngs: [], error: String(err && err.message || err) };
    }

    const workDir = path.resolve(String(work));
    fs.mkdirSync(workDir, { recursive: true });
    const tag = tagOf(index);

    const count = names.length || 1;
    const pngs = [];
    const timings = [];

    for (let i = 0; i < count; i++) {
      const suffix = names.length ? `-${i}` : '';
      const htmlFile = path.join(workDir, `html-${tag}${suffix}.html`);
      const pngFile = path.join(workDir, `html-${tag}${suffix}.png`);

      fs.writeFileSync(htmlFile, buildHtmlDocument({
        html: htmlText,
        title: titleText,
        stepNames: names,
        stepIndex: i,
        w,
        h,
      }), 'utf8');

      let last = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const profileDir = path.join(workDir, `edge-prof-${process.pid}-${tag}-${i}-${attempt}`);
        const budget = attempt === 0 ? 2000 : 5000;
        const cap = await captureOnce({
          browser, htmlFile, pngFile, profileDir, timeoutMs, budget, w, h,
        });
        last = cap;
        timings.push({
          index: i,
          attempt: attempt + 1,
          budget,
          ms: cap.ms,
          ok: cap.ok,
          stats: cap.stats,
          code: cap.code,
          timedOut: cap.timedOut,
          stderr: cap.stderr,
        });
        if (cap.ok) break;
      }

      if (!last || !last.ok) {
        return {
          ok: false,
          pngs,
          error: `SCREENSHOT_BLANK#${i}: 截图为空或浏览器没有产出有效 PNG (${statsText(last && last.stats)}` +
            `${last && last.timedOut ? ' timeout' : ''}${last && last.stderr ? ' stderr=' + last.stderr.slice(0, 300) : ''})`,
          timings,
          browser,
        };
      }

      // 尺寸不对不判失败：合成端会 scale+pad 到目标尺寸。
      // 但把它记在 timings.stats 里，排查"为什么图边缘有黑边"时能一眼看到。
      pngs.push(pngFile);
    }

    return {
      ok: true,
      pngs,
      error: '',
      timings,
      browser,
      w,
      h,
      steps: names,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, pngs: [], error: String(err && err.stack || err) };
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API 2：多张 PNG → 片段                                         */
/* ------------------------------------------------------------------ */

/**
 * 把若干张 PNG 按总时长等分做成一个视频片段（硬切）。
 *
 * 为什么不用 concat demuxer 的 duration：
 *   图片 concat 的时长是浮点，按 30fps 取帧时容易多一帧/少一帧，几段拼起来就会和
 *   旁白错位。这里先把总时长换算成"总帧数"，再按帧数分给每张图（除不尽的余数给前几张），
 *   每段用 trim=end_frame 精确截帧，concat 后总帧数严格等于 round(seconds*fps)，
 *   帧率恒定、时长不漂。
 *
 * 为什么硬切不交叉淡化：
 *   本模块的分步画面本来就是"同一张版式逐步揭露"，硬切观感就是分步；交叉淡化会让
 *   总时长缩水，还要二次重编码，得不偿失。
 *
 * @param {object} opts
 *   ffmpeg  ffmpeg.exe 绝对路径
 *   work    输出目录
 *   index   场景序号，输出 slides-<index>.mp4
 *   pngs    静帧绝对路径数组（按顺序播放）
 *   seconds 片段总时长（最终会换算成 round(seconds*fps) 帧）
 *   fps     默认 30
 *   w,h     输出尺寸，默认 1920x1080
 * @returns {{ok:boolean, file:string, error:string, frames?:number, seconds?:number}}
 */
async function buildSlidesClip(opts = {}) {
  const started = Date.now();
  try {
    const { ffmpeg, work, index, pngs } = opts;
    const fps = intIn(opts.fps, 30, 1, 120);
    const seconds = Number(opts.seconds);
    const w = intIn(opts.w, DEFAULT_W, 16, 7680);
    const h = intIn(opts.h, DEFAULT_H, 16, 4320);
    // yuv420p 要求偶数尺寸；调用方给奇数就向下取偶，避免 ffmpeg 直接报错
    const W = w - (w % 2);
    const H = h - (h % 2);

    if (!ffmpeg || !isFile(ffmpeg)) {
      return { ok: false, file: '', error: `FFMPEG_NOT_FOUND: ${ffmpeg || '(空)'}` };
    }
    if (!Array.isArray(pngs) || pngs.length === 0) {
      return { ok: false, file: '', error: 'PNG_LIST_EMPTY: pngs 不能为空' };
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { ok: false, file: '', error: `INVALID_SECONDS: ${opts.seconds}` };
    }

    const files = [];
    for (let i = 0; i < pngs.length; i++) {
      const p = path.resolve(String(pngs[i] || ''));
      if (!isFile(p) || fileSize(p) === 0) {
        return { ok: false, file: '', error: `PNG_MISSING#${i}: ${p || '(空路径)'}` };
      }
      files.push(p);
    }

    const n = files.length;
    const totalFrames = Math.round(seconds * fps);
    if (totalFrames < n) {
      // 每张至少 1 帧，否则"等分"会把某些图直接丢掉，时长也会被悄悄改写
      return {
        ok: false,
        file: '',
        error: `SECONDS_TOO_SHORT: ${seconds}s@${fps}fps=${totalFrames} 帧，不够分给 ${n} 张图（每张至少 1 帧）`,
      };
    }

    const base = Math.floor(totalFrames / n);
    const rem = totalFrames % n;
    const frames = [];
    for (let i = 0; i < n; i++) frames.push(base + (i < rem ? 1 : 0));

    const workDir = path.resolve(String(work || '.'));
    fs.mkdirSync(workDir, { recursive: true });
    const file = path.join(workDir, `slides-${tagOf(index)}.mp4`);

    const inputs = [];
    const chains = [];
    const labels = [];
    for (let i = 0; i < n; i++) {
      // -loop 1：单张图持续供应帧；-framerate 必须显式给，否则 image demuxer 默认 25fps，
      // 后续 fps 滤镜会做一次多余的重采样
      inputs.push('-loop', '1', '-framerate', String(fps), '-i', files[i]);
      chains.push(
        `[${i}:v]fps=${fps},` +
        // 尺寸不一致时等比缩放后补深色边，保证 concat 的所有输入分辨率/像素格式一致
        `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0d1220,` +
        'setsar=1,format=yuv420p,' +
        `trim=end_frame=${frames[i]},setpts=PTS-STARTPTS[v${i}]`,
      );
      labels.push(`[v${i}]`);
    }
    chains.push(`${labels.join('')}concat=n=${n}:v=1:a=0[out]`);

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...inputs,
      '-filter_complex', chains.join(';'),
      '-map', '[out]',
      '-an',
      '-r', String(fps),
      // 用帧数而不是 -t 收尾：-t 是浮点秒，最后一帧有可能被舍掉，总帧数才是唯一可靠的时长
      '-frames:v', String(totalFrames),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p',
      file,
    ];

    const r = await run(ffmpeg, args, 300000);
    const ok = r.code === 0 && isFile(file) && fileSize(file) > 0;
    return {
      ok,
      file: ok ? file : '',
      error: ok ? '' : String(r.stderr || '').slice(0, 2000),
      frames: ok ? totalFrames : 0,
      seconds: ok ? Number((totalFrames / fps).toFixed(3)) : 0,
      perSlideSeconds: frames.map((f) => Number((f / fps).toFixed(3))),
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, file: '', error: String(err && err.stack || err) };
  }
}

module.exports = { renderHtmlStills, buildSlidesClip };
