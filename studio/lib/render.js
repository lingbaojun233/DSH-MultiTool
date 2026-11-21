'use strict';
/**
 * render.js -- 把「分镜 JSON」渲染成 mp4。全部用 ffmpeg 生成画面，模型不参与画像素。
 *
 * 三步：
 *   1) 每场按背景色/文字生成一张 1920x1080 的静帧（gradients + drawtext）
 *   2) 静帧做慢推（zoompan）成视频片段
 *   3) xfade 串起来，可选叠加旁白与 BGM
 *
 * 为什么分三步而不是一个 filter_complex 走到底：分步每一步都能单独跑、单独看，
 * 出错时知道是哪一层的参数问题；一条大 filter 出错只会给一句无用的报错。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

/**
 * 一场的静帧。背景用 lavfi 的 gradients（两色线性渐变），文字用 textfile 传，
 * 避免中文/引号/冒号在命令行里被转义炸掉。
 */
async function sceneStill({ ffmpeg, work, index, scene, w, h, font }) {
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

/** 静帧 → 视频片段（慢推，营造"动的画面"） */
async function sceneClip({ ffmpeg, work, index, stillPng, seconds, w, h, fps }) {
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

  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95[aout]`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-t', String(totalSeconds), '-shortest', out];
  const r = await run(ffmpeg, args, 300000);
  return { ok: r.code === 0 && fs.existsSync(out), file: out, error: r.stderr };
}

module.exports = { run, sceneStill, sceneClip, concatClips, mixAudio };
