'use strict';
/**
 * overlay.js -- 把 GIF 表情包（带透明通道）叠到视频上：播完一轮，然后**停在末帧**。
 *
 * 为什么单独一个文件、一个函数：表情叠加是"后期装饰"，不该和 render.js 的
 * "从分镜生成画面" 混在一起；调用方（server.js）可以在 concatClips 之后、
 * mixAudio 之前，按场景插一段 overlayStickers，不改任何现有渲染逻辑。
 *
 * 整体两步：
 *   1) GIF → 带 alpha 的 webm（或 PNG 序列），结果按 <id>-<像素高度> 缓存在 work/cache
 *   2) 一条 filter_complex 把 N 个表情链式 overlay 到视频上，-t 裁到视频原本的时长
 *
 * 播放策略（用户实测反馈：以前"只放一部分"很别扭）：
 *   表情从 at 开始**完整播一轮** GIF，播完用 tpad 克隆末帧一直停到本场结束，
 *   不再用 enable=between(at, at+duration) 把它截断，也不再淡出。多个表情各自从
 *   自己的 at 开始、各自停在自己的末帧，互不遮挡靠位置错开。
 *   实现就是 setpts 平移 PTS + tpad=stop_mode=clone:stop_duration=<剩余时长>，
 *   输入**不能**再 -stream_loop -1（那会一直循环，永远到不了"末帧"）。
 *
 * 两个踩过的坑，写在最前面免得后来人重踩：
 *   a) ffmpeg 默认的 vp9 解码器（native "vp9"）不认 webm 里的 alpha 层，
 *      必须用 `-c:v libvpx-vp9` 当输入解码器，否则透明区域会变成一块黑。
 *   b) GIF 的透明像素在解码后 RGB 往往是白色/绿色（调色板里随便填的），
 *      直接缩放会把这点颜色混进边缘，出现一圈白边/彩边；所以缩放前后
 *      要做 premultiply / unpremultiply。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * 缓存格式版本。转码流程一改就 +1：老缓存的文件名对不上，自然不会被复用，
 * 不需要让调用方手动清 work/cache。
 */
const CACHE_VERSION = 'v1';

/**
 * webm 的"太大/太慢"阈值：超过就退回 PNG 序列。
 * 表情本身只有几百 KB、几百毫秒，超过这两个数说明这条 webm 路走歪了
 * （比如源 GIF 帧数爆炸），没必要为了"优先 webm"硬扛。
 */
const WEBM_MAX_BYTES = 6 * 1024 * 1024;
const WEBM_MAX_MS = 15000;

/** 默认淡入秒数（API 文档写的是 0.25）。只在开头淡入；结尾不淡出（要停到本场结束） */
const DEFAULT_FADE = 0.25;
/** 默认大小：画面高度的 30%，即 1080p 下 324px（规划提示词给的是 0.25~0.38） */
const DEFAULT_SCALE = 0.3;
/**
 * 大小下限。规划提示词已经改成 0.25~0.38，但计划缓存有 30 天，
 * 老计划里写的 0.15~0.25 会比现在的期望小一大圈，所以统一抬到这个下限。
 */
const MIN_SCALE = 0.25;
/** 表情高度下限，太小的表情没有意义，也给 scale 表达式留余量 */
const MIN_STICKER_PX = 16;
/** 表情高度上限比例（相对画面高）。再大就糊了，也容易被写成离谱的值 */
const MAX_SCALE = 1.5;
/** 底部字幕带默认高度（1080p 下的像素）。表情不许压进去，调用方可以覆盖 */
const DEFAULT_BOTTOM_RESERVE_PX = 200;
/**
 * GIF 一轮比规划给的 duration 长时，最多提速到这个倍数（2 倍再看不懂就没意义了）。
 * 提速是为了兑现"最长 duration 秒内必须播完一轮"。
 */
const MAX_SPEED = 2;
/** 停末帧的最短时长：比这小就不加 tpad（少一个滤波器，也避免 0 值边界） */
const MIN_FREEZE_SEC = 0.04;
/** 纯色背景判定容差：四角 RGB 每个通道都在这个范围内就算"同色" */
const SAME_COLOR_TOL = 16;

/** 和 render.js 里同名helper一个行为：跑子进程、收 stderr、超时就 kill */
function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      // kill 之后 close 可能还要等一下；这里直接按超时收尾，别让调用方干等
      finish(-1);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      err += String((e && e.message) || e);
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/** 写进 ffmpeg 表达式里的数字：去掉浮点尾巴，避免命令行里出现 0.30000000000000004 */
function num(v) {
  return String(+Number(v).toFixed(4));
}

/** stderr 塞进返回值时截断：几百 KB 的报错原样回传没有意义，还会撑爆日志 */
function tail(s, n = 400) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(-n) : t;
}

/** ffmpeg -i 的 stderr 里抠时长；抠不到返回 null（调用方就不加 -t） */
function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return null;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/** 从 stderr 的流信息里抠 fps / 尺寸，GIF 和 mp4 的行格式不一样，用宽松正则 */
function parseVideoInfo(stderr) {
  const s = String(stderr || '');
  const info = { width: null, height: null, fps: null, hasAudio: false };
  const fps = /,\s*(\d+(?:\.\d+)?)\s+fps/.exec(s);
  if (fps) info.fps = Number(fps[1]) || null;
  const size = /Video:[\s\S]*?,\s*(\d{2,5})x(\d{2,5})(?=[,\s])/.exec(s);
  if (size) {
    info.width = Number(size[1]);
    info.height = Number(size[2]);
  }
  info.hasAudio = /Stream #\d+:\d+.*?: Audio:/.test(s);
  return info;
}

/**
 * 用 ffmpeg 把 GIF 第一帧 dump 成裸 RGBA，再看四个角。
 *
 * 为什么不用 js 解 PNG/GIF：不想引依赖，而 ffmpeg 本来就在手边。
 * 为什么看原始尺寸的像素、而不是先缩成 8x8 再看角：面积平均会把"边框 + 背景"
 * 糊成一个中间色，四角就变成了"看似同色"，抠色会抠到不该抠的颜色。
 * 这里读原帧，角上取 4x4 小块平均（避开最外圈 1px 的边缘杂色，又不至于把
 * 几十像素宽的区域平均进来），四角只要有一个通道差超过 SAME_COLOR_TOL 就不算同色。
 */
async function probeSticker({ ffmpeg, gif, id, cacheDir, timeoutMs }) {
  const stamp = statStamp(gif);
  const cacheFile = path.join(cacheDir, `${CACHE_VERSION}-${id}.detect.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    // durationSec 是"播放策略"改版后才探的：老缓存没有它，必须重测一次（多跑一个 ffmpeg，~0.1s）
    if (cached && cached.stamp === stamp && cached.mode && Number(cached.durationSec) > 0) return cached;
  } catch { /* 没有/坏了就重测 */ }

  const tmp = path.join(cacheDir, `.detect-${id}-${process.pid}-${Date.now()}.rgba`);
  const args = [
    '-hide_banner', '-loglevel', 'info', '-y',
    '-i', gif,
    '-frames:v', '1',
    '-vf', 'format=rgba',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', tmp,
  ];
  const r = await run(ffmpeg, args, Math.min(timeoutMs, 60000));
  const info = parseVideoInfo(r.stderr);
  let mode = 'unknown';
  let key = null;
  try {
    const buf = fs.readFileSync(tmp);
    const iw = info.width;
    const ih = info.height;
    // 宽高至少 8px 才够取四个角的 4x4 小块，否则下面的下标会越界
    if (iw >= 8 && ih >= 8 && buf.length >= iw * ih * 4) {
      // 取四角的 4x4 小块（内缩 1px）做平均：单像素太容易被边缘杂色带偏
      const block = (bx, by) => {
        let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
        for (let y = by; y < by + 4; y++) {
          for (let x = bx; x < bx + 4; x++) {
            const o = (y * iw + x) * 4;
            r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
            n += 1;
          }
        }
        return { r: r / n, g: g / n, b: b / n, a: a / n };
      };
      const corners = [
        block(1, 1),
        block(iw - 5, 1),
        block(1, ih - 5),
        block(iw - 5, ih - 5),
      ];
      const opaque = corners.every((c) => c.a >= 250);
      const same = corners.every((c) => Math.abs(c.r - corners[0].r) <= SAME_COLOR_TOL
        && Math.abs(c.g - corners[0].g) <= SAME_COLOR_TOL
        && Math.abs(c.b - corners[0].b) <= SAME_COLOR_TOL);

      if (opaque && same) {
        // 四角不透明且同色 => 这是"纯色背景"的表情，不是真透明。
        // 纯色背景的 GIF 在播放器里看着像透明，但解码出来是一整块实色，
        // 直接 overlay 会在画面上糊一个方块，所以必须把这块颜色抠掉。
        mode = 'colorkey';
        key = `0x${[corners[0].r, corners[0].g, corners[0].b]
          .map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      } else if (corners.some((c) => c.a < 16)) {
        // 至少一个角是全透明的 => 这是真带 alpha 的表情（GIF 的透明索引），直接用 alpha
        mode = 'alpha';
      } else {
        // 四角不透明但颜色不同：内容本身铺到角上了（比如照片底），抠不掉也不该抠，
        // 按原样叠；调用方会看到一块不透明方块，这属于素材问题，报告里说清楚。
        mode = 'opaque';
      }
    }
  } catch { /* 读不到就按 unknown 处理 */ }
  try { fs.rmSync(tmp, { force: true }); } catch { /* 删不掉无所谓，下次会被覆盖 */ }

  const result = {
    stamp,
    width: info.width || 0,
    height: info.height || 0,
    fps: info.fps || 15,
    // GIF 一轮的时长：决定"播完一轮"在哪里结束，也是停末帧的起算点。
    // 探不到就当 0，调用方退回按 duration 估。
    durationSec: parseDuration(r.stderr) || 0,
    mode,
    key,
  };
  // 检测结果按 id 缓存。生产里同一个 id 只会指向同一份素材（文件名就是内容 id），
  // 所以不需要再按目录区分；换了素材时 stamp 对不上会自动重测。
  try { fs.writeFileSync(cacheFile, JSON.stringify(result), 'utf8'); } catch { /* 缓存写不了不影响出片 */ }
  return result;
}

function statStamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch {
    return '0-0';
  }
}

/** 转码时统一的前缀：把"抠色/预乘"这些和素材相关的处理放前面，scale 放最后 */
function stickerVf({ mode, key, height, forPng }) {
  const vf = ['format=rgba'];
  if (mode === 'colorkey' && key) {
    // colorkey 抠掉纯色背景。similarity 给 0.12：GIF 是调色板色，背景通常完全一致，
    // 但素材被重新压缩过时会有 ±几个色阶的抖动；太大又会把内容里的同色像素一起抠掉。
    // blend 0.06 让边缘像素半透明而不是硬切，缩小后锯齿会轻一些。
    vf.push(`colorkey=${key}:similarity=0.12:blend=0.06`);
  }
  if (!forPng) {
    // 预乘：透明像素的 RGB 是白的/绿的，不预乘的话缩放会把这点颜色混到边缘，
    // 深色画面上就是一圈白边。PNG 序列存的是直通 alpha，不能预乘，所以跳过。
    vf.push('premultiply=inplace=1');
  }
  vf.push(`scale=-2:${height}:flags=lanczos`);
  if (!forPng) {
    vf.push('unpremultiply=inplace=1');
    vf.push('format=yuva420p');
  } else {
    vf.push('format=rgba');
  }
  return vf.join(',');
}

function cacheBase(cacheDir, id, height, mode, key) {
  // 用像素高度而不是 scale 小数做 key：0.2 和 0.2000000001 会变成两个文件名，
  // 缓存等于白做；像素高度是最终真正用到的值，同样的高度就是同一份产物。
  const tag = mode === 'colorkey' && key ? `ck${String(key).replace(/^0x/, '')}` : mode;
  return path.join(cacheDir, `${CACHE_VERSION}-${id}-h${height}-${tag}`);
}

function isUsableFile(p) {
  try {
    return fs.statSync(p).isFile() && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** 缓存是否比源文件新：素材被换过就要重转，否则会一直吃旧缓存 */
function cacheFresh(target, gif) {
  try {
    return fs.statSync(target).mtimeMs >= fs.statSync(gif).mtimeMs;
  } catch {
    return false;
  }
}

/**
 * 转一个表情。
 * 优先 webm（带 alpha 的 vp9），失败或太大/太慢就退 PNG 序列。
 * 返回 { ok, kind:'webm'|'png', path, bytes, ms, cached, error }
 */
async function transcodeSticker({ ffmpeg, gif, id, height, cacheDir, probe, prefer, timeoutMs }) {
  const base = cacheBase(cacheDir, id, height, probe.mode, probe.key);
  const webm = `${base}.webm`;
  const pngPattern = path.join(`${base}-png`, 'f-%03d.png');
  const pngDir = path.dirname(pngPattern);

  // 1) 命中缓存
  if (prefer !== 'png' && isUsableFile(webm) && cacheFresh(webm, gif)) {
    return { ok: true, kind: 'webm', path: webm, bytes: fs.statSync(webm).size, ms: 0, cached: true };
  }
  if (isUsableFile(pngPattern.replace('%03d', '000')) && cacheFresh(pngPattern.replace('%03d', '000'), gif)) {
    return { ok: true, kind: 'png', path: pngPattern, bytes: dirBytes(pngDir), ms: 0, cached: true };
  }

  const maxMs = Math.min(Math.max(5000, timeoutMs), 120000);
  let webmError = null;
  let webmMs = 0;
  let webmBytes = 0;

  // 2) webm
  if (prefer !== 'png') {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = `${base}.${process.pid}.${Date.now()}.tmp.webm`;
    const started = Date.now();
    const r = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', gif,
      '-an',
      // 关键：-pix_fmt yuva420p + libvpx-vp9 把 alpha 单独存成一条 vp9 alpha 层
      '-vf', stickerVf({ mode: probe.mode, key: probe.key, height, forPng: false }),
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
      // -b:v 0 是 vp9 走纯质量模式的开关，配 crf 才是"恒定质量"
      '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '2',
      '-row-mt', '1',
      tmp,
    ], maxMs);
    webmMs = Date.now() - started;
    if (r.code === 0 && isUsableFile(tmp)) {
      webmBytes = fs.statSync(tmp).size;
      try {
        fs.renameSync(tmp, webm);
        // 太大的/太慢的就别用 webm 了，改走 PNG 序列（下面继续）
        if (webmBytes <= WEBM_MAX_BYTES && webmMs <= WEBM_MAX_MS) {
          return { ok: true, kind: 'webm', path: webm, bytes: webmBytes, ms: webmMs, cached: false };
        }
      } catch (e) {
        webmError = `落盘失败: ${tail((e && e.message) || e)}`;
        try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响后续 */ }
      }
    } else {
      webmError = `${r.code === -1 ? '超时' : `exit ${r.code}`}: ${tail(r.stderr)}`.slice(0, 600);
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响后续 */ }
    }
  }

  // 3) PNG 序列兜底
  try {
    fs.rmSync(pngDir, { recursive: true, force: true });
  } catch { /* 旧目录删不掉就重建 */ }
  fs.mkdirSync(pngDir, { recursive: true });
  const pngStarted = Date.now();
  const r2 = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', gif,
    '-an',
    '-vf', stickerVf({ mode: probe.mode, key: probe.key, height, forPng: true }),
    '-start_number', '0',
    pngPattern,
  ], maxMs);
  const pngMs = Date.now() - pngStarted;
  const first = pngPattern.replace('%03d', '000');
  if (r2.code === 0 && isUsableFile(first)) {
    // webm 明明能用却因为太大/太慢被放弃时，把它删掉：
    // 留着的话下一次调用会先命中 webm 缓存，策略就自相矛盾了。
    if (isUsableFile(webm)) {
      try { fs.rmSync(webm, { force: true }); } catch { /* 删不掉就下次再说 */ }
    }
    return { ok: true, kind: 'png', path: pngPattern, bytes: dirBytes(pngDir), ms: webmMs + pngMs, cached: false };
  }
  const pngError = `${r2.code === -1 ? '超时' : `exit ${r2.code}`}: ${tail(r2.stderr)}`.slice(0, 600);

  // 4) 两条都不行：如果 webm 其实成功过（只是太大/太慢），还是能用就用
  if (isUsableFile(webm) && cacheFresh(webm, gif)) {
    return { ok: true, kind: 'webm', path: webm, bytes: fs.statSync(webm).size, ms: webmMs, cached: false };
  }
  return {
    ok: false,
    kind: null,
    path: null,
    bytes: 0,
    ms: webmMs,
    cached: false,
    error: `webm: ${webmError || '未尝试'}; png: ${pngError}`,
  };
}

function dirBytes(dir) {
  let sum = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { sum += fs.statSync(path.join(dir, f)).size; } catch { /* 单个文件读不到就跳过 */ }
    }
  } catch { /* 目录不在 */ }
  return sum;
}

/**
 * 把若干表情叠到视频上：各自从 at 开始**完整播一轮**，播完停在末帧，一直留到本场结束。
 *
 * stickers: [{ id, at, duration, x, y, scale, fade }]
 *   id       12 位 hex，对应 <stickerDir>/<id>.gif
 *   at       相对本片段的起始秒
 *   duration 不再是"显示多久"，而是"最晚什么时候必须播完一轮"：
 *            播完就定格到本场结束。GIF 一轮比它长时会提速（最多 MAX_SPEED 倍）。
 *   x, y     0~1 相对位置。注意：x 是"表情左上角在剩余空间里的比例"（overlay 的 (W-w)*x），
 *            y 同理 (H-h)*y；所以 0=最左/最上、1=最右/最下，天然不会出画。
 *   scale    相对画面高度的比例（0.3 = 1080p 下高 324px），默认 0.3，下限 0.25
 *   fade     淡入秒数，默认 0.25；没有淡出
 *
 * 返回：
 *   { ok, file, applied, skipped, error, warning?, details? }
 *   applied  成功叠上去的个数
 *   skipped  [{ id, at, reason }]，缺文件/转码失败/时间越界都会进这里
 *   warning  只有"给了表情但一个都没叠上"时才有值（此时 ok 仍是 true、输出是原视频的拷贝）
 *   details  每个真的叠上去的表情：转码方式、耗时、体积、播完时刻、停末帧时长、像素矩形
 *
 * extra（可选，都有默认值）：
 *   bottomReserve  底部字幕带高度（像素），表情会被夹到这条带之上，默认 1080p 下 200
 *   transcode      'auto' | 'webm' | 'png'  仅用于测试/排障：强制走某条转码路
 *   fps            默认 30，只影响 PNG 序列那条路的输入帧率
 */
async function overlayStickers({
  ffmpeg,
  stickerDir,
  work,
  index,
  videoIn,
  out,
  w,
  h,
  stickers,
  bottomReserve = 0,
  timeoutMs = 300000,
  transcode = 'auto',
  fps = 30,
  threads = 0,
}) {
  const res = { ok: false, file: null, applied: 0, skipped: [], error: null };

  if (!ffmpeg) return { ...res, error: 'ffmpeg 路径为空' };
  if (!videoIn || !isUsableFile(videoIn)) return { ...res, error: `videoIn 不存在: ${videoIn}` };
  if (!out) return { ...res, error: 'out 为空' };
  if (!work) return { ...res, error: 'work 为空' };
  // 同一个路径会让 ffmpeg 一边读一边写同一个文件，必坏；宁可报错也别毁掉输入
  if (path.resolve(out) === path.resolve(videoIn)) {
    return { ...res, error: 'out 与 videoIn 是同一个文件' };
  }

  const W = Number(w) > 0 ? Number(w) : 1920;
  const H = Number(h) > 0 ? Number(h) : 1080;
  // 字幕带：调用方（server.js）按字幕样式算好传进来；没传就按 1080p 的默认值等比换算
  const reservePx = Math.max(0, Math.round(
    Number(bottomReserve) > 0 ? Number(bottomReserve) : (DEFAULT_BOTTOM_RESERVE_PX * H) / 1080,
  ));
  const list = Array.isArray(stickers) ? stickers : [];
  // 每场一个转码缓存目录：场级并行时两场同时转同一个 GIF 不会抢同一个临时文件/PNG 目录
  const cacheDir = path.join(work, 'cache', `scene-${Number(index) || 0}`);
  const baseDir = stickerDir ? path.resolve(String(stickerDir)) : null;
  // 探测也要写临时文件到 cache，先建好目录；建不出来后面会以"无法解码"的形式体现
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* 后面自然会失败 */ }

  // 视频总时长：-t 用，也是"停末帧停到哪"的终点。探不到就不加 -t（输出长度跟着主输入走）
  let total = null;
  {
    const p = await run(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-i', videoIn], Math.min(timeoutMs, 60000));
    total = parseDuration(p.stderr);
  }

  const jobs = [];
  for (const raw of list) {
    const s = raw || {};
    const id = String(s.id == null ? '' : s.id).trim();
    const at = clampNum(s.at, 0, 1e6, 0);
    // id 只允许字母数字下划线横线：既挡住 `..\` 这类路径穿越，也覆盖 12 位 hex 的约定
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      res.skipped.push({ id, at, reason: 'id 非法（只允许字母/数字/_/-）' });
      continue;
    }
    const gif = path.join(baseDir || '', `${id}.gif`);
    if (!baseDir || !isUsableFile(gif)) {
      res.skipped.push({ id, at, reason: '文件不存在' });
      continue;
    }
    if (total != null && at >= total - 0.02) {
      res.skipped.push({ id, at, reason: `at=${at}s 超出视频时长 ${total.toFixed(2)}s` });
      continue;
    }
    // duration 只是"最晚播完"的预算，不再裁短可见区间；超出视频剩余时长的部分没意义
    let duration = clampNum(s.duration, 0.05, 1e6, 2);
    if (total != null) duration = Math.min(duration, total - at);
    const scale = clampNum(s.scale, MIN_SCALE, MAX_SCALE, DEFAULT_SCALE);
    let height = Math.max(MIN_STICKER_PX, Math.round((H * scale) / 2) * 2); // 取偶数，yuv420 要求
    // 放大后的硬上限：整个表情必须落在字幕带上沿之上（留 8px 余量），否则宁可缩小
    const maxHeight = Math.max(MIN_STICKER_PX, H - reservePx - 8);
    if (height > maxHeight) height = Math.round(maxHeight / 2) * 2;
    jobs.push({
      id,
      gif,
      at,
      duration,
      xRaw: clampNum(s.x, 0, 1, 0.5),
      yRaw: clampNum(s.y, 0, 1, 0.5),
      scale,
      fadeRaw: clampNum(s.fade, 0, 1e6, DEFAULT_FADE),
      height,
    });
  }

  /** 没有可叠的表情：直接拷一份，保证 out 一定存在 */
  const passthrough = (warning) => {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    try {
      if (path.resolve(out) !== path.resolve(videoIn)) fs.copyFileSync(videoIn, out);
      res.ok = true;
      res.file = out;
      res.applied = 0;
      if (warning) res.warning = warning;
      return res;
    } catch (e) {
      res.error = `拷贝失败: ${tail((e && e.message) || e)}`;
      return res;
    }
  };

  if (!jobs.length) {
    return passthrough(list.length ? '所有表情都被跳过，输出为原视频拷贝' : null);
  }

  // 同一个 GIF 在一个片段里可能出现多次；检测结果只跟源文件有关，缓存住省几次进程
  const probes = new Map();
  const filterParts = [];
  const inputs = [];
  const details = [];
  const used = [];

  for (const job of jobs) {
    let probe = probes.get(job.gif);
    if (!probe) {
      probe = await probeSticker({ ffmpeg, gif: job.gif, id: job.id, cacheDir, timeoutMs });
      // 连一张可读的帧都拿不到，说明这个 GIF 根本没解出来，转码也白搭
      if (!probe.mode || probe.mode === 'unknown') {
        res.skipped.push({ id: job.id, at: job.at, reason: 'GIF 无法解码/尺寸未知' });
        probes.set(job.gif, probe);
        continue;
      }
      probes.set(job.gif, probe);
    }
    const tc = await transcodeSticker({
      ffmpeg, gif: job.gif, id: job.id, height: job.height,
      cacheDir, probe, prefer: transcode === 'png' ? 'png' : 'auto', timeoutMs,
    });
    if (!tc.ok) {
      res.skipped.push({ id: job.id, at: job.at, reason: `转码失败: ${tail(tc.error, 200)}` });
      continue;
    }
    job.kind = tc.kind;
    job.path = tc.path;
    job.cached = tc.cached;
    job.bytes = tc.bytes;
    job.ms = tc.ms;
    job.mode = probe.mode;
    job.fps = probe.fps;
    job.probeW = probe.width;
    job.probeH = probe.height;
    job.probeDurationSec = probe.durationSec;
    used.push(job);
  }

  if (!used.length) {
    return passthrough('所有表情都转码失败，输出为原视频拷贝');
  }

  // 输入 0 是视频，之后每个表情一个输入。几何与时间轴先在这一圈里算清楚
  // （像素宽高、播完时刻、停末帧时长、夹取后的 x/y），下面的滤波器链只拼数字。
  for (let i = 0; i < used.length; i++) {
    const job = used[i];
    const srcW = Number(job.probeW) || 0;
    const srcH = Number(job.probeH) || 0;
    // 转码时只指定了高度（scale=-2:h），宽度按原始宽高比推，取偶数（和 ffmpeg 的 -2 一致）
    job.width = srcH > 0 && srcW > 0
      ? Math.max(2, Math.round((job.height * srcW) / srcH / 2) * 2)
      : job.height;
    // GIF 一轮多长：探不到就按 duration 估（宁可少停一会儿，也不要凭空多停）
    job.loopSec = Number(job.probeDurationSec) > 0.05
      ? Number(job.probeDurationSec)
      : Math.max(0.2, Math.min(job.duration, 2));
    // 一轮比 duration 长就提速，兑现"最晚 duration 秒播完一轮"；最多 2 倍，再快就看不懂了
    job.speed = job.loopSec > job.duration + 0.05 ? Math.min(MAX_SPEED, job.loopSec / job.duration) : 1;
    job.playSec = job.loopSec / job.speed;
    // 停末帧停到本场结束（视频总时长）；探不到总时长就按 duration/一轮里大的那个收尾
    const sceneEnd = total != null ? total : job.at + Math.max(job.duration, job.playSec);
    job.freeze = Math.max(0, sceneEnd - job.at - job.playSec);
    job.fade = Math.min(job.fadeRaw, Math.max(0.05, job.playSec));
    job.x = job.xRaw;
    // y 的夹取要算实际尺寸：表情底边不能落进字幕带（H-reservePx 之上），超出就往内推。
    // (H-h)*y 是左上角的像素位置，所以底边 = (H-h)*y + h，解出 y 的上限就是这个式子。
    const yMax = H > job.height ? (H - reservePx - job.height) / (H - job.height) : 0;
    job.y = Math.max(0, Math.min(job.yRaw, Math.min(1, yMax)));
    job.yClamped = job.y < job.yRaw - 1e-6;

    if (job.kind === 'webm') {
      // 不再 -stream_loop -1：要的是"播一轮就停在末帧"，循环输入永远到不了末帧。
      // -c:v libvpx-vp9：必须显式指定解码器，native vp9 解码器会丢掉 alpha（变黑块）
      inputs.push('-c:v', 'libvpx-vp9', '-i', job.path);
    } else {
      // PNG 序列：-framerate 给原本的 GIF 帧率（可能是 16.67 这种小数），
      // 不然默认 25fps 会让表情快放/慢放。
      const rate = Math.min(60, Math.max(1, Number(job.fps) || Number(fps) || 25));
      inputs.push('-framerate', num(rate), '-i', job.path);
    }
  }

  let prev = '[0:v]';
  for (let i = 0; i < used.length; i++) {
    const job = used[i];
    const idx = i + 1;
    const chain = [job.kind === 'png' ? 'format=rgba' : 'format=yuva420p'];

    // 把表情自己的 PTS 平移到 at：之后 fade 的 st 和 overlay 的 t 都按"视频时间轴"走，
    // 不用再靠 enable 凑时间（以前就是那么凑的，顺手把表情截断了）。
    chain.push(job.speed > 1.001
      ? `setpts=(PTS-STARTPTS)*${num(1 / job.speed)}+${num(job.at)}/TB`
      : `setpts=PTS-STARTPTS+${num(job.at)}/TB`);
    // 播完一轮后用 tpad 克隆末帧补足到本场结束 —— 这就是"停在最后一帧，等其它表情也播完"。
    if (job.freeze > MIN_FREEZE_SEC) chain.push(`tpad=stop_mode=clone:stop_duration=${num(job.freeze)}`);
    // 只有淡入：结尾不再淡出（淡出等于"只放一部分"，用户实测反馈过）。
    if (job.fade > 0.001) chain.push(`fade=t=in:st=${num(job.at)}:d=${num(job.fade)}:alpha=1`);
    const sLabel = `[s${i}]`;
    filterParts.push(`[${idx}:v]${chain.join(',')}${sLabel}`);

    // 位置：x/y 是"左上角在剩余空间里的比例"，overlay 用 (W-w)*x / (H-h)*y ——
    // W/w 是主画面/表情的宽，所以 x=0 贴左、x=1 贴右，实际尺寸变了也不会出画。
    // enable 只从 at 开始（之前原样透传），一直到本场结束都不再关掉：表情要留到最后。
    const label = i === used.length - 1 ? '[vout]' : `[v${i}]`;
    filterParts.push(
      `${prev}${sLabel}overlay=` +
      `x=(W-w)*${num(job.x)}:y=(H-h)*${num(job.y)}:` +
      // eof_action=repeat：万一 tpad 的时长取整短了一帧，末帧也不会提前消失
      `eof_action=repeat:enable='gte(t,${num(job.at)})':format=auto${label}`
    );
    prev = label;

    details.push({
      id: job.id,
      at: job.at,
      duration: job.duration,
      x: job.x,
      y: job.y,
      yClamped: job.yClamped,
      width: job.width,
      height: job.height,
      scale: job.scale,
      // 表情在画面上的像素矩形（左上角 + 宽高），抽帧核对大小/避让时直接对这几个数。
      // 左上角用 floor：overlay 的 x/y 表达式求值后是截断取整，四舍五入会和实际差 1px。
      rect: {
        x: Math.floor((W - job.width) * job.x),
        y: Math.floor((H - job.height) * job.y),
        w: job.width,
        h: job.height,
      },
      loopSec: Number(job.loopSec.toFixed(3)),
      speed: Number(job.speed.toFixed(3)),
      playSec: Number(job.playSec.toFixed(3)),
      freezeSec: Number(job.freeze.toFixed(3)),
      endSec: total != null ? total : Number((job.at + job.playSec + job.freeze).toFixed(3)),
      fade: job.fade,
      mode: job.mode,
      kind: job.kind,
      cached: job.cached,
      transcodeMs: job.ms,
      bytes: job.bytes,
    });
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoIn, ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    // 原视频要是有音轨就原样带过去。这条函数预期跑在 mixAudio 之前（那时其实还没音轨），
    // 带上只是防止调用顺序变了把声音弄丢；copy 不重编码，没有质量损失。
    '-map', '0:a?',
    '-c:a', 'copy',
  ];
  // 按主视频时长裁：表情比视频长也不会把成片拉长（这正是 -t 存在的意义）
  if (total != null) args.push('-t', num(total));
  // 表情叠加也是一次 libx264 编码：并行时 -threads 2 给 manim 留核，串行时 0=吃满
  args.push('-threads', String(Math.max(0, Math.floor(Number(threads) || 0))));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out);

  const r = await run(ffmpeg, args, timeoutMs);
  if (r.code !== 0 || !isUsableFile(out)) {
    // 失败的输出可能是个只有头部的半成品，留着比没有更危险
    try { fs.rmSync(out, { force: true }); } catch { /* 删不掉也没关系 */ }
    res.ok = false;
    res.file = null;
    res.error = `叠加失败（index=${index}，exit ${r.code}）: ${tail(r.stderr, 600)}`;
    res.skipped = res.skipped.concat(used.map((j) => ({ id: j.id, at: j.at, reason: '整条 filter 执行失败' })));
    return res;
  }

  res.ok = true;
  res.file = out;
  res.applied = used.length;
  res.details = details;
  return res;
}

module.exports = {
  overlayStickers,
  // 下面几个导出只是为了测试/排障，正常调用只用 overlayStickers
  probeSticker,
  transcodeSticker,
};
