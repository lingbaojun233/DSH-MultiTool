'use strict';
/**
 * render.js -- 把「分镜 JSON」渲染成 mp4。全部用 ffmpeg 生成画面，模型不参与画像素。
 *
 * 三步：
 *   1) 每场按背景图/背景色 + 文字生成一张静帧（图片底，或原来的 gradients 渐变）
 *   2) 静帧做运镜（zoompan）成视频片段
 *   3) xfade 串起来，可选叠加旁白与 BGM
 *
 * 为什么分三步而不是一个 filter_complex 走到底：分步每一步都能单独跑、单独看，
 * 出错时知道是哪一层的参数问题；一条大 filter 出错只会给一句无用的报错。
 *
 * 图片底（scene.image）是后加的，没图的场次仍然走原来的渐变路径，一个参数都不变。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** 允许的运镜；写错的值不报错、退回默认，避免一个错字段让整片渲染失败 */
const MOTIONS = new Set(['zoom-in', 'zoom-out', 'pan-left', 'pan-right']);
const DEFAULT_MOTION = 'zoom-in';

/**
 * ffmpeg 编码线程数（显式传给每次编码）：
 *   0 = 让 ffmpeg 自己按核数决定（串行渲染时用，吃满 4 核）
 *   2 = 场级并行时每场只给 2 线程，剩下的核留给同时跑的 manim
 */
function threadArg(threads) {
  return String(Math.max(0, Math.floor(Number(threads) || 0)));
}

/**
 * 静帧超采样倍数。文字画在 2 倍画布上，再交给 zoompan 缩到 1080p：
 * 一是运镜裁切时文字边缘不会糊，二是 zoompan 的 x/y 只取整数像素，
 * 在 2 倍画布上算等于输出半个像素的步进，推拉时不会有明显的"一卡一卡"。
 */
const SUPERSAMPLE = 2;

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

/** 把任意字符串转成 `-vf` 里能安全使用的形式（只用于 drawtext 的 textfile，不直接拼文本） */
function safeText(t) {
  return String(t == null ? '' : t).replace(/\r/g, '').slice(0, 400);
}

/** 运镜名归一化：不认识的值当默认，别让一处手滑把整场渲染搞挂 */
function normalizeMotion(m) {
  const v = String(m == null ? '' : m).trim().toLowerCase();
  return MOTIONS.has(v) ? v : DEFAULT_MOTION;
}

/**
 * 找到 scene.image 指向的文件。
 * 绝对路径直接用；相对名只在调用方给的 imageDir 里找（没有 imageDir 就不支持相对名）。
 * 相对名限制在 imageDir 内，是为了不让分镜 JSON 里的 `..\..\` 变成读任意文件的入口。
 * 找不到返回 null，调用方退回渐变背景——缺一张图不该让整条片子渲染不出来。
 */
function resolveImage(image, imageDir) {
  const raw = String(image == null ? '' : image).trim();
  if (!raw) return null;

  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(raw);
  } else if (imageDir) {
    const dir = path.resolve(String(imageDir));
    const joined = path.resolve(dir, raw);
    if (joined === dir || joined.startsWith(dir + path.sep)) {
      candidates.push(joined);
      // 分镜里常只写 `sunset`，补常见扩展名比让用户记住后缀省事
      if (!path.extname(joined)) {
        for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.bmp']) candidates.push(joined + ext);
      }
    }
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* 权限之类的问题按"没这张图"处理，继续试下一个候选 */ }
  }
  return null;
}

/** sceneStill 产出静帧时留一份记录，sceneClip 靠它知道这场该不该运镜（server.js 的调用签名不能改） */
function metaFile(work, index) {
  return path.join(work, `still-${index}.meta.json`);
}

function writeStillMeta(work, index, meta) {
  try {
    fs.writeFileSync(metaFile(work, index), JSON.stringify(meta), 'utf8');
  } catch { /* 元数据只是内部约定，写不了就退化成原来的推镜，不影响出片 */ }
}

function readStillMeta(work, index) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(work, index), 'utf8'));
  } catch {
    return null;
  }
}

/** 原渐变路径，行为一个字节都没动（没图的场次必须和改动前一样） */
async function gradientStill({ ffmpeg, work, index, scene, w, h, font }) {
  const bg = scene.bg || {};
  const c0 = bg.c0 || '#101a33';
  const c1 = bg.c1 || '#3a2a5a';
  const png = path.join(work, `still-${index}.png`);
  const txt = path.join(work, `text-${index}.txt`);
  fs.writeFileSync(txt, safeText(scene.text || ''), 'utf8');

  const size = Math.max(24, Number(scene.textSize) || Math.round(h * 0.09));
  const color = scene.textColor || 'white';
  const textFileArg = txt.replace(/\\/g, '/').replace(/:/g, '\\:');
  const fontArg = font.replace(/\\/g, '/').replace(/:/g, '\\:');

  const vf = [
    `drawtext=fontfile='${fontArg}':textfile='${textFileArg}'`,
    `fontcolor=${color}`,
    `fontsize=${size}`,
    'line_spacing=12',
    'x=(w-text_w)/2',
    'y=(h-text_h)/2',
    // 注意：不能在这里做时间相关的淡入。静帧只渲染第 0 帧，t=0 时 alpha=0，字会整个消失。
    // 想要动效，应该在这一步之后对片段做叠加，而不是在静帧上。
    'alpha=1',
    'shadowcolor=black@0.35',
    'shadowx=3',
    'shadowy=3',
  ].join(':');

  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `gradients=s=${w}x${h}:c0=${c0}:c1=${c1}:d=1:speed=0.01`,
    '-vf', vf,
    '-frames:v', '1',
    png,
  ], 120000);
  return { ok: r.code === 0 && fs.existsSync(png), png, error: r.stderr };
}

/**
 * 图片底静帧：cover 铺满 → 文字区压暗 → 写字。
 *
 * 压暗用的是"模糊过的矩形蒙版"，不是整屏压黑：
 * 只在文字所在的一条横带上加 55% 黑，边缘用 gblur 糊开，看起来是渐变的暗带而不是色块。
 * 蒙版在 1/8 画布上画再放大，省一次 4K 的模糊运算，顺便让渐变更顺。
 * 蒙版高度按文字行数估出来——drawtext 不回报实际文本框，但暗带边缘是糊的，
 * 估偏十几像素看不出来，没必要为此多跑一次进程去量。
 */
async function imageStill({ ffmpeg, work, index, scene, w, h, font, image }) {
  const png = path.join(work, `still-${index}.png`);
  const txt = path.join(work, `text-${index}.txt`);
  const text = safeText(scene.text || '');
  fs.writeFileSync(txt, text, 'utf8');

  const W = w * SUPERSAMPLE;
  const H = h * SUPERSAMPLE;
  const size = Math.max(24, Number(scene.textSize) || Math.round(h * 0.09)) * SUPERSAMPLE;
  const lineSpacing = 12 * SUPERSAMPLE;
  const color = scene.textColor || 'white';
  const textFileArg = txt.replace(/\\/g, '/').replace(/:/g, '\\:');
  const fontArg = font.replace(/\\/g, '/').replace(/:/g, '\\:');

  const parts = [];
  // cover：等比放大到能盖住画布再多裁，宁裁不缩，避免变形
  parts.push(
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${W}:${H},setsar=1,format=rgba[src]`
  );
  // 先垫一层黑：带透明通道的 png 不至于变成一片色值垃圾
  parts.push(`color=c=black:s=${W}x${H}:d=1,format=rgba[bgc]`);
  parts.push('[bgc][src]overlay=0:0[bg]');

  if (text) {
    // 行高按字号 1.32 倍估（微软雅黑中文行框的经验值），空行也算一行
    const lineCount = Math.max(1, text.split('\n').length);
    const textH = lineCount * size * 1.32 + (lineCount - 1) * lineSpacing;
    const pad = Math.max(size * 0.8, Math.round(H * 0.03));
    const bandH = Math.min(Math.round(H * 0.9), Math.round(textH + pad * 2));
    const bandY = Math.round((H - bandH) / 2);

    const maskDiv = 8;
    const mw = Math.max(2, Math.round(W / maskDiv));
    const mh = Math.max(2, Math.round(H / maskDiv));
    const mby = Math.round(bandY / maskDiv);
    const mbh = Math.max(1, Math.round(bandH / maskDiv));
    // sigma 取带高的 1/10：模糊后中间能到满黑度，两侧各留约 30% 带高做过渡
    const sigmaFull = Math.max(6, Math.min(240, bandH / 10));
    const sigmaMask = Math.max(0.5, sigmaFull / maskDiv);

    parts.push(
      `color=c=black:s=${mw}x${mh}:d=1,format=gray,` +
      `drawbox=x=0:y=${mby}:w=${mw}:h=${mbh}:color=white:t=fill,` +
      `gblur=sigma=${sigmaMask.toFixed(2)}:steps=2,scale=${W}:${H}:flags=bilinear[mask]`
    );
    parts.push(`color=c=black:s=${W}x${H}:d=1,format=rgba,colorchannelmixer=aa=0.55[blk]`);
    parts.push('[blk][mask]alphamerge[scrim]');
    parts.push('[bg][scrim]overlay=0:0[dim]');

    parts.push(
      `[dim]drawtext=fontfile='${fontArg}':textfile='${textFileArg}'` +
      `:fontcolor=${color}` +
      `:fontsize=${size}` +
      `:line_spacing=${lineSpacing}` +
      `:x=(w-text_w)/2` +
      `:y=(h-text_h)/2` +
      `:alpha=1` +
      `:shadowcolor=black@0.35` +
      `:shadowx=${3 * SUPERSAMPLE}` +
      `:shadowy=${3 * SUPERSAMPLE}` +
      `,format=rgb24[out]`
    );
  } else {
    parts.push('[bg]format=rgb24[out]');
  }

  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', image,
    '-filter_complex', parts.join(';'),
    '-map', '[out]',
    '-frames:v', '1',
    png,
  ], 120000);
  return { ok: r.code === 0 && fs.existsSync(png), png, error: r.stderr };
}

/**
 * 一场的静帧。
 *
 * 新参数（都可选，老调用方不传就完全按老行为走）：
 *   imageDir -- 相对图片名（scene.image）的查找目录，默认 null 表示不支持相对名
 *   image / motion -- 顶层兜底：调用方如果习惯把这两个塞在参数里而不是 scene 里，也认
 *                     （scene.image / scene.motion 优先）
 * 返回仍是 { ok, png, error }，多给的 image 字段只是给调用方排查用。
 */
async function sceneStill({ ffmpeg, work, index, scene, w, h, font, imageDir = null, image = null, motion = null }) {
  const s = scene || {};
  // 空串当作没写：分镜 JSON 里常见 "image": "" 这种占位
  const wantImage = s.image != null && s.image !== '' ? s.image : image;
  const wantMotion = s.motion != null && s.motion !== '' ? s.motion : motion;
  const imagePath = resolveImage(wantImage, imageDir);
  const hasImage = !!imagePath;

  // 记下这场有没有底图、用什么运镜，sceneClip 后面只拿到 stillPng，靠这份记录接上
  writeStillMeta(work, index, {
    hasImage,
    motion: hasImage ? normalizeMotion(wantMotion) : null,
    image: imagePath || null,
    imageMissing: !!wantImage && !hasImage,
  });

  if (!hasImage) return gradientStill({ ffmpeg, work, index, scene: s, w, h, font });
  return imageStill({ ffmpeg, work, index, scene: s, w, h, font, image: imagePath });
}

/**
 * 静帧运镜模式。这直接决定画面会不会"呼吸"。
 *
 *   'none'        不加任何运动：一张静帧铺满整场，逐帧内容完全一致（像素差 0）
 *   'supersample' 先放大到 2 倍再 zoompan，最后缩回 1080p：靠重采样抹掉亚像素取整
 *   'zoompan'     老行为（1.0→1.12 直接 zoompan）：抖动明显，只留作对照/回退
 *
 * 默认 'none'：实测 2 倍法能把抖动压到很小但压不到 0，而"静帧就该纹丝不动"
 * 这件事上 0 比"小"重要得多 —— 观众看到的是整幅画面在发颤，不是幅度大小。
 * 想要运镜的场次应该交给 manim（真动画），而不是让一张图假动。
 */
const STILL_MODES = new Set(['none', 'supersample', 'zoompan']);
let stillMode = 'none';

/** 改静帧模式（server.js 读 config.json 后调一次）；不认识的值当 'none' */
function setStillMotion(mode) {
  const v = String(mode == null ? '' : mode).trim().toLowerCase();
  stillMode = STILL_MODES.has(v) ? v : 'none';
  return stillMode;
}

function getStillMotion() {
  return stillMode;
}

/**
 * 零运动片段：静帧 → 定长视频。
 *
 * 这里刻意**什么都不做**（除了缩放和编码）。zoompan 的抖动来自它每帧都要
 * 按浮点 zoom 算裁切窗口，再把 x/y 取整到像素；同一个源图在 1080p 下逐帧的
 * 取整结果会在两个像素之间跳，解码出来就是整幅画在轻微抖动。
 * 不加 zoom 就没有裁切窗口，也就没有取整，帧帧完全一致。
 */
async function staticClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, edgeFade = 0, edgeLead = 0, edgeColor = null, threads = 0 }) {
  const out = path.join(work, `clip-${index}.mp4`);
  const frames = Math.max(1, Math.round(seconds * fps));
  // 静帧可能来自 2 倍超采样画布（imageStill）或原始分辨率（gradientStill），统一缩到项目规格
  let vf = `scale=${w}:${h}:flags=lanczos,setsar=1,format=yuv420p`;
  // 文字卡的入场/出场淡化。为什么必须在这里做：文字是"烤"进静帧的，
  // 两张文字卡在 xfade 的 0.4 秒重叠期里会同时全亮 —— 两个标题就叠在一起了。
  //
  // 只加"头尾各 0.15 秒"其实不够：xfade 的权重在窗口里从 1→0 / 0→1，
  // 但只要两张卡都还是不透明，中点就一定是 50/50 的重影。要让标题真的不叠，
  // 得让 A 的标题在窗口**中点之前**淡完、B 的标题在中点之后才淡出来：
  //   fade-in  延后 edgeLead/2（0.2 秒）开始，时长 edgeFade（0.15）
  //   fade-out 提前 edgeLead/2 结束，时长 edgeFade
  // 于是窗口里 A 在 [start, mid] 淡出、B 在 [mid, end] 淡入，交集为空。
  // edgeLead=0（单场、没有转场）时自然退化成"片头片尾各 0.15 秒"。
  //
  // 淡到**风格底色**而不是黑色：淡到黑会在浅色风格（白板）上变成一下黑屏闪烁，
  // 淡到底色则只是背景抹平一下，标题照样消失。edgeColor 由调用方按风格传进来。
  const d = Math.min(Math.max(0, Number(edgeFade) || 0), Math.max(0, seconds / 2 - 0.01));
  if (d > 0.01) {
    const lead = Math.max(0, Number(edgeLead) || 0);
    const half = lead / 2;
    const inStart = Math.max(0, Math.min(half, seconds - 2 * d - 0.05));
    const outStart = Math.min(Math.max(inStart + d + 0.05, seconds - half - d), Math.max(0, seconds - d));
    const color = /^#[0-9a-f]{6}$/i.test(String(edgeColor || '')) ? `:color=0x${String(edgeColor).slice(1)}` : '';
    vf += `,fade=t=in:st=${inStart.toFixed(3)}:d=${d.toFixed(3)}${color},fade=t=out:st=${outStart.toFixed(3)}:d=${d.toFixed(3)}${color}`;
  }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-i', stillPng,
    '-vf', vf,
    '-t', String(seconds),
    '-r', String(fps),
    '-frames:v', String(frames),
    '-threads', threadArg(threads),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    out,
  ];
  const r = await run(ffmpeg, args, 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/** 原慢推路径（老行为，只作对照）：没图的场次也照这个推 */
async function legacyClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, threads = 0 }) {
  const out = path.join(work, `clip-${index}.mp4`);
  const frames = Math.max(1, Math.round(seconds * fps));
  // zoompan 的 d 是"每帧持续多少帧"，配合 zoom 表达式做缓慢放大
  const vf = [
    `zoompan=z='min(1.0+0.0009*on,1.12)'`,
    `d=${frames}:s=${w}x${h}:fps=${fps}`,
    'x=(iw-iw/zoom)/2',
    'y=(ih-ih/zoom)/2',
  ].join(':');
  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-i', stillPng,
    '-vf', vf,
    '-t', String(seconds),
    '-r', String(fps),
    '-threads', threadArg(threads),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    out,
  ], 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/**
 * 运镜表达式：推近 / 拉远 / 左右平移。
 * 返回 { z, x, y } 三个 ffmpeg 表达式片段，两倍法与原速法共用同一套算法。
 */
function motionExprs(motion, frames, maxZoom) {
  const last = Math.max(1, frames - 1);
  const zoomRange = +(maxZoom - 1).toFixed(4);
  const y = '(ih-ih/zoom)/2';
  switch (normalizeMotion(motion)) {
    case 'zoom-out':
      return { z: `${maxZoom}-${zoomRange}*on/${last}`, x: '(iw-iw/zoom)/2', y };
    case 'pan-left':
      // 镜头向左看：先看画面右侧，再一路移到左侧
      return { z: String(maxZoom), x: `(iw-iw/zoom)*(1-on/${last})`, y };
    case 'pan-right':
      return { z: String(maxZoom), x: `(iw-iw/zoom)*(on/${last})`, y };
    case 'zoom-in':
    default:
      return { z: `1+${zoomRange}*on/${last}`, x: '(iw-iw/zoom)/2', y };
  }
}

/**
 * 图片底 + 运镜。
 *
 * zoompan 的几个参数是踩过的坑，这里说明白：
 *   d=N       一张输入图扩成 N 帧（静帧是单帧 png，所以不再用 -loop 1，
 *             否则输入无限循环、'on' 也会一直涨，取不到"本场进度"）
 *   s=WxH     输出尺寸固定，不跟 zoom 变
 *   fps       必须显式给，否则 zoompan 按 25 的时间基算，输出会莫名丢帧/加速
 *   on        输出帧号，0..N-1；用 on/(N-1) 得到本场 0→1 的进度，推拉平移都靠它
 * x/y 用 (iw-iw/zoom) 这类表达式：zoompan 的坐标是"裁切窗口左上角"，
 * 除以 2 就是居中；平移时让它从 0 线性走到 (iw-iw/zoom)。
 */
async function imageClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, motion, threads = 0 }) {
  const out = path.join(work, `clip-${index}.mp4`);
  const frames = Math.max(1, Math.round(seconds * fps));
  const maxZoom = 1.12;
  const e = motionExprs(motion, frames, maxZoom);
  // clip 夹在 1~1.12：万一 seconds*fps 让最后一帧的 on 略微越界，也不会越推越糊
  const vf = [
    `zoompan=z='clip(${e.z},1,${maxZoom})'`,
    `d=${frames}:s=${w}x${h}:fps=${fps}`,
    `x='${e.x}'`,
    `y='${e.y}'`,
  ].join(':');

  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', stillPng,
    '-vf', vf,
    '-frames:v', String(frames),
    '-r', String(fps),
    '-threads', threadArg(threads),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    out,
  ], 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/**
 * 2 倍超采样运镜：放大 → zoompan → 缩回。
 *
 * 原理：zoompan 的裁切窗口算出来是小数，取整发生在它内部。在 3840x2160 上
 * 取整，误差相对输出只有半个 1080p 像素；再缩回 1920x1080 时每个输出像素由
 * 4 个输入像素平均得到，那半个像素的跳变被重采样抹平，看起来就不抖了。
 * 代价是一次 4K 编码，比原速法慢约 1 倍。
 */
async function supersampleClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, motion, threads = 0 }) {
  const out = path.join(work, `clip-${index}.mp4`);
  const frames = Math.max(1, Math.round(seconds * fps));
  const W = w * SUPERSAMPLE;
  const H = h * SUPERSAMPLE;
  const maxZoom = 1.12;
  const e = motionExprs(motion, frames, maxZoom);
  // 注意：zoompan 自己的参数之间必须是 ':'，只有"链上的下一个滤镜"才用 ','。
  // 两者混用 ffmpeg 会把 d=90 当成一个新滤镜名，报 "No option name near '90:...'"。
  const zoompan = [
    `zoompan=z='clip(${e.z},1,${maxZoom})'`,
    `d=${frames}:s=${W}x${H}:fps=${fps}`,
    `x='${e.x}'`,
    `y='${e.y}'`,
  ].join(':');
  const vf = [
    `scale=${W}:${H}:flags=lanczos`,
    zoompan,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');
  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', stillPng,
    '-vf', vf,
    '-frames:v', String(frames),
    '-r', String(fps),
    '-threads', threadArg(threads),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    out,
  ], 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/**
 * 静帧 → 视频片段。
 *
 * 按 stillMode 分派：
 *   none         → staticClip（默认；抖动为 0，画面完全静止）
 *   supersample  → supersampleClip（保留轻微运镜，抖动被 2 倍重采样压掉）
 *   zoompan      → 老行为，有底图走 imageClip、没底图走 legacyClip
 * 老调用方签名不变：motion 仍可显式覆盖 meta 里记的运镜。
 * edgeFade：文字卡的入场/出场淡化秒数（只在 static 分支生效，见 staticClip）。
 * edgeLead：转场重叠时长（xfade 的 fade）；淡化会跨过它的中点，避免两个标题重影。
 * edgeColor：淡化到哪种颜色（默认黑；文字卡传风格底色，浅色风格才不会闪黑）。
 */
async function sceneClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, motion = null, edgeFade = 0, edgeLead = 0, edgeColor = null, threads = 0 }) {
  if (stillMode === 'none') {
    return staticClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, edgeFade, edgeLead, edgeColor, threads });
  }

  const meta = readStillMeta(work, index);
  const hasImage = !!(meta && meta.hasImage);
  const m = motion || (meta && meta.motion) || DEFAULT_MOTION;

  if (stillMode === 'supersample') {
    return supersampleClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, motion: m, threads });
  }
  if (!hasImage) {
    return legacyClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, threads });
  }
  return imageClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, motion: m, threads });
}

/** 多个片段 xfade 串联。ffmpeg 的 xfade 只能两两接，所以要链式叠。 */
async function concatClips({ ffmpeg, clips, durations, out, fade = 0.4, threads = 0 }) {
  if (clips.length === 1) {
    fs.copyFileSync(clips[0], out);
    return { ok: true, file: out };
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const c of clips) args.push('-i', c);

  const parts = [];
  let acc = '[0:v]';
  let offset = 0;
  for (let i = 1; i < clips.length; i++) {
    offset += durations[i - 1] - fade;
    const label = i === clips.length - 1 ? '[vout]' : `[v${i}]`;
    parts.push(`${acc}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${label}`);
    acc = label;
  }
  args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
  // 拼接是全场一次：串行阶段，显式 -threads 0 让 ffmpeg 按核数吃满
  args.push('-threads', threadArg(threads));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out);
  const r = await run(ffmpeg, args, 600000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/**
 * 配音 + BGM 混进去。
 * narrations: [{ file, at }]（at = 该句在成片里的起始秒）
 * bgm: 可选音频文件，循环并压到很低。
 */
async function mixAudio({ ffmpeg, videoIn, narrations, bgm, totalSeconds, out, threads = 0 }) {
  const inputs = ['-i', videoIn];
  const filters = [];
  const mixLabels = [];

  let idx = 1;
  for (const n of narrations) {
    if (!n.file || !fs.existsSync(n.file)) continue;
    inputs.push('-i', n.file);
    const delayMs = Math.max(0, Math.round((n.at || 0) * 1000));
    filters.push(`[${idx}:a]adelay=${delayMs}|${delayMs},volume=1.0[n${idx}]`);
    mixLabels.push(`[n${idx}]`);
    idx += 1;
  }

  let bgmIdx = -1;
  if (bgm && fs.existsSync(bgm)) {
    inputs.push('-stream_loop', '-1', '-i', bgm);
    bgmIdx = idx;
    filters.push(`[${bgmIdx}:a]volume=0.12,atrim=0:${totalSeconds},asetpts=N/SR/TB[b0]`);
    mixLabels.push('[b0]');
    idx += 1;
  }

  if (!mixLabels.length) {
    // 没声音：照样统一编码一遍，保证输出格式一致
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
      '-threads', threadArg(threads), '-c:v', 'copy', '-t', String(totalSeconds), out], 300000);
    return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
  }

  // apad 是必须的：旁白念完得早时，音轨会比画面短，
  // 不加 apad 的话配合 -shortest 会把成片直接剪到最后一句念完的位置（画面后半段消失）。
  // normalize=0 是关键：amix 默认会把结果除以输入轨数，而我们有「每场一条轨」
  // —— 8 场的片子人声会被压掉约 18dB，听起来就是"说话不清楚"。
  // 同一时刻实际只有一条旁白在响，所以不做归一化才对；峰值交给 alimiter 兜。
  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,apad[aout]`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-threads', threadArg(threads),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    // 不用 -shortest：音轨已经 apad 到片尾，再用 -shortest 只会让"音轨短"变成"成片短"。
    // 时长统一由 -t 控制。
    '-t', String(totalSeconds), out];
  const r = await run(ffmpeg, args, 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

module.exports = {
  run, sceneStill, sceneClip, concatClips, mixAudio, resolveImage, normalizeMotion, MOTIONS,
  setStillMotion, getStillMotion,
};
