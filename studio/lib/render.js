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

/** 原慢推路径：没图的场次照旧走这里 */
async function legacyClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps }) {
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
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    out,
  ], 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/**
 * 图片底 + 运镜。
 *
 * zoompan 的几个参数是踩过的坑，这里说明白：
 *   d=N       一张输入图扩成 N 帧（静帧是单帧 png，所以不再用 -loop 1，
 *             否则输入无限循环、'on' 也会一直涨，取不到"本场进度"）
 *   s=WxH     输出尺寸固定 1920x1080，不跟 zoom 变
 *   fps       必须显式给 30，否则 zoompan 按 25 的时间基算，输出会莫名丢帧/加速
 *   on        输出帧号，0..N-1；用 on/(N-1) 得到本场 0→1 的进度，推拉平移都靠它
 * x/y 用 (iw-iw/zoom) 这类表达式：zoompan 的坐标是"裁切窗口左上角"，
 * 除以 2 就是居中；平移时让它从 0 线性走到 (iw-iw/zoom)。
 */
async function imageClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, motion }) {
  const out = path.join(work, `clip-${index}.mp4`);
  const frames = Math.max(1, Math.round(seconds * fps));
  const last = Math.max(1, frames - 1);
  const m = normalizeMotion(motion);
  const maxZoom = 1.12;
  // 1.12-1 = 0.1200000000000001，浮点尾巴会原样进命令行，取整一下看着干净
  const zoomRange = +(maxZoom - 1).toFixed(4);

  let z;
  let x;
  const y = '(ih-ih/zoom)/2';
  switch (m) {
    case 'zoom-out':
      z = `${maxZoom}-${zoomRange}*on/${last}`;
      x = '(iw-iw/zoom)/2';
      break;
    case 'pan-left':
      // 镜头向左看：先看画面右侧，再一路移到左侧
      z = String(maxZoom);
      x = `(iw-iw/zoom)*(1-on/${last})`;
      break;
    case 'pan-right':
      z = String(maxZoom);
      x = `(iw-iw/zoom)*(on/${last})`;
      break;
    case 'zoom-in':
    default:
      z = `1+${zoomRange}*on/${last}`;
      x = '(iw-iw/zoom)/2';
      break;
  }

  // clip 夹在 1~1.12：万一 seconds*fps 让最后一帧的 on 略微越界，也不会越推越糊
  const zExpr = `clip(${z},1,${maxZoom})`;
  const vf = [
    `zoompan=z='${zExpr}'`,
    `d=${frames}:s=${w}x${h}:fps=${fps}`,
    `x='${x}'`,
    `y='${y}'`,
  ].join(':');

  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', stillPng,
    '-vf', vf,
    '-frames:v', String(frames),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    out,
  ], 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/**
 * 静帧 → 视频片段。
 *
 * 有底图的场次走运镜（scene.motion，默认 zoom-in），没图的场次仍然走原来的慢推。
 * 判断依据是 sceneStill 写在 work 里的 still-<index>.meta.json；
 * 也可以显式传 motion 覆盖（比如自己造了张图当静帧，不走 sceneStill）。
 */
async function sceneClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps, motion = null }) {
  const meta = readStillMeta(work, index);
  if (!meta || !meta.hasImage) {
    return legacyClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps });
  }
  return imageClip({
    ffmpeg, work, index, stillPng, seconds, w, h, fps,
    motion: motion || meta.motion,
  });
}

/** 多个片段 xfade 串联。ffmpeg 的 xfade 只能两两接，所以要链式叠。 */
async function concatClips({ ffmpeg, clips, durations, out, fade = 0.4 }) {
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
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out);
  const r = await run(ffmpeg, args, 600000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

/**
 * 配音 + BGM 混进去。
 * narrations: [{ file, at }]（at = 该句在成片里的起始秒）
 * bgm: 可选音频文件，循环并压到很低。
 */
async function mixAudio({ ffmpeg, videoIn, narrations, bgm, totalSeconds, out }) {
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
      '-c:v', 'copy', '-t', String(totalSeconds), out], 300000);
    return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
  }

  // apad 是必须的：旁白念完得早时，音轨会比画面短，
  // 不加 apad 的话配合 -shortest 会把成片直接剪到最后一句念完的位置（画面后半段消失）。
  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95,apad[aout]`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    // 不用 -shortest：音轨已经 apad 到片尾，再用 -shortest 只会让"音轨短"变成"成片短"。
    // 时长统一由 -t 控制。
    '-t', String(totalSeconds), out];
  const r = await run(ffmpeg, args, 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

module.exports = { run, sceneStill, sceneClip, concatClips, mixAudio, resolveImage, normalizeMotion, MOTIONS };
