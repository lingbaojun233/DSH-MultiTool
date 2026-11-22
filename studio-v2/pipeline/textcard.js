'use strict';
/**
 * textcard.js -- 文字卡：ffmpeg 渐变底 + 居中大字。
 *
 * 只负责"一张静帧 + 一段静视频"；配音、字幕、边框由 render.js 统一加，
 * 这样 manim 和文字卡走同一条后期链路，不会出现"文字卡没字幕/没框"。
 */
const fs = require('node:fs');
const path = require('node:path');
const M = require('./manim');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}

function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** 背景渐变的第二色：背景色向强调色靠 35%，保证同风格但看得出层次。 */
function gradientEnd(style) {
  const a = hexToRgb(style && style.bg);
  const b = hexToRgb(style && (style.accent || style.fg));
  return rgbToHex(a.map((v, i) => v * 0.65 + b[i] * 0.35));
}

function ffPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** 按字数折行；已有的 \n 保留。 */
function wrapText(text, per) {
  const n = Math.max(4, Number(per) || 12);
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    for (let i = 0; i < line.length; i += n) out.push(line.slice(i, i + n));
  }
  return out.join('\n');
}

/** 只在 uploads 根目录里按文件名找，拒绝 .. / 绝对路径越界。 */
function resolveImage(ref, cfg) {
  const s = String(ref || '').trim();
  if (!s) return null;
  const base = path.basename(s.replace(/^\/api\/upload\//, ''));
  const ext = path.extname(base).toLowerCase();
  if (ext && !IMAGE_EXTS.includes(ext)) return null;
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (const root of (Array.isArray(cfg.uploadDirs) ? cfg.uploadDirs : [])) {
    const dir = path.resolve(root);
    const cands = ext ? [base] : IMAGE_EXTS.map((e) => `${stem}${e}`);
    for (const name of cands) {
      const file = path.join(dir, path.basename(name));
      if (!file.startsWith(dir + path.sep)) continue;
      try {
        if (fs.statSync(file).isFile() && fs.statSync(file).size > 100) return file;
      } catch { /* 继续找 */ }
    }
  }
  return null;
}

/** 生成文字卡静帧：有图用图（压暗），没图用风格渐变。 */
async function makeStill({ scene, style, cfg, work, index, log }) {
  const W = Number(cfg.width) || 1920;
  const H = Number(cfg.height) || 1080;
  const png = path.join(work, `textcard-${index}.png`);
  const txt = path.join(work, `textcard-${index}.txt`);
  const text = wrapText(scene.text || scene.narration || '', Number(cfg.textCard && cfg.textCard.lineChars) || 12);
  fs.writeFileSync(txt, text, 'utf8');

  const fontPx = Math.max(48, Math.round(H * (Number(cfg.textCard && cfg.textCard.fontSizeRatio) || 0.085)));
  const font = String(cfg.font || 'C:\\Windows\\Fonts\\msyh.ttc');
  const color = (style && (style.fg || style.accent)) || '#FFFFFF';
  const draw = [
    `drawtext=fontfile='${ffPath(font)}':textfile='${ffPath(txt)}'`,
    `fontcolor=${color.replace(/^#/, '0x')}`,
    `fontsize=${fontPx}`,
    'line_spacing=18',
    'x=(w-text_w)/2',
    'y=(h-text_h)/2',
    'shadowcolor=black@0.35',
    'shadowx=4',
    'shadowy=4',
  ].join(':');

  const img = resolveImage(scene.image, cfg);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  let vf;
  if (img) {
    args.push('-i', img);
    vf = [
      `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${W}:${H}`,
      'setsar=1',
      'eq=brightness=-0.22:saturation=0.9',
      draw,
    ].join(',');
  } else {
    const end = gradientEnd(style);
    const c0 = String((style && style.bg) || '#101a33').replace(/^#/, '0x');
    const c1 = String(end).replace(/^#/, '0x');
    args.push('-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:d=1:speed=0.01`);
    vf = draw;
  }
  args.push('-vf', vf, '-frames:v', '1', png);

  const r = await M.run(cfg.ffmpeg, args, 120000);
  if (r.code !== 0 || !fs.existsSync(png)) {
    return { ok: false, error: `TEXTCARD_STILL_FAILED: ${String(r.err || '').slice(-300)}` };
  }
  if (log) log(`文字卡静帧完成${img ? `（底图 ${path.basename(img)}）` : '（渐变底）'}`);
  return { ok: true, png, image: img };
}

/**
 * 渲一段文字卡视频（自然时长 = 计划秒数）。
 * 返回 { ok, file, naturalSeconds, engine:'text' }。
 */
async function renderTextCard({ scene, style, cfg, work, index, log }) {
  const started = Date.now();
  const still = await makeStill({ scene, style, cfg, work, index, log });
  if (!still.ok) return { ok: false, error: still.error, ms: Date.now() - started };

  const seconds = Math.max(1, Number(scene.seconds) || 4);
  const out = path.join(work, `textcard-${index}.mp4`);
  const W = Number(cfg.width) || 1920;
  const H = Number(cfg.height) || 1080;
  const fps = Number(cfg.fps) || 30;
  const r = await M.run(cfg.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-i', still.png,
    '-t', String(seconds),
    '-vf', `scale=${W}:${H}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an', out,
  ], 180000);
  const ms = Date.now() - started;
  if (r.code !== 0 || !fs.existsSync(out)) {
    return { ok: false, error: `TEXTCARD_RENDER_FAILED: ${String(r.err || '').slice(-300)}`, ms };
  }
  return { ok: true, file: out, naturalSeconds: seconds, engine: 'text', ms, image: still.image };
}

module.exports = { renderTextCard, makeStill, resolveImage, wrapText, gradientEnd };
