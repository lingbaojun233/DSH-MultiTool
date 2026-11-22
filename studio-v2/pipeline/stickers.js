'use strict';
/**
 * stickers.js -- 表情包叠加。
 *
 * 播放策略（用户实测要求）：从 at 开始**循环播放到本场结束**，不停在末帧、不淡出。
 * 实现是输入加 -stream_loop -1（webm 循环）+ setpts 平移到 at + overlay enable='gte(t,at)'。
 * 每场最多 1 个表情；多余的在 schema 层就丢掉。
 *
 * stickerDuration 语义：一轮播放的时长参考（不是截断时长）。GIF 自然时长比它长时，
 * 在转码阶段加速到接近它；转码缓存键里带上 speed，改速度不会复用旧素材。
 *
 * 位置：x/y 是 0~1 相对坐标，按实际缩放后的尺寸夹取，保证不越界、不压进底部字幕带。
 * 默认 scale=0.3（1080p 下约 324px 高）；表情卡（stickercard）用 0.55 居中。
 */
const fs = require('node:fs');
const path = require('node:path');
const M = require('./manim');
const C = require('./cache');

const ID_RE = /^[0-9a-f]{6,40}$/i;
const MOOD_SPREAD = ['笑', '哭', '睡觉', '惊吓', '汗', '生气', '点赞', '加油', '停止工作', '问号'];

/** 取候选给模型挑：收藏优先，再按情绪各取一张。失败返回空数组，不阻塞出片。 */
async function fetchCandidates(cfg, limit = 8) {
  const grab = async (query) => {
    try {
      const res = await fetch(`${String(cfg.stickerUrl).replace(/\/+$/, '')}/v1/list?${query}`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => null);
      return data && data.ok && Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  };
  const out = [];
  const seen = new Set();
  const push = (it) => {
    if (out.length >= limit) return;
    const id = String((it && it.id) || '').toLowerCase();
    if (!ID_RE.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: String((it && (it.mood || it.name)) || id).slice(0, 16) });
  };
  for (const it of await grab(`favorite=1&limit=${limit}`)) push(it);
  if (out.length < limit) {
    const spread = await Promise.all(MOOD_SPREAD.map((m) => grab(`q=${encodeURIComponent(m)}&limit=1`)));
    for (const items of spread) for (const it of items) push(it);
  }
  if (out.length < limit) {
    for (const it of await grab(`limit=${Math.max(limit * 3, 30)}`)) push(it);
  }
  return out;
}

function resolveFile(id, cfg) {
  const clean = String(id || '').toLowerCase();
  if (!ID_RE.test(clean)) return null;
  const file = path.join(String(cfg.stickerDir || ''), `${clean}.gif`);
  try {
    if (fs.statSync(file).isFile() && fs.statSync(file).size > 100) return file;
  } catch { /* 不存在 */ }
  return null;
}

/**
 * GIF → 带 alpha 的 webm；按 id+mtime+speed 缓存，避免每场重转。
 * speed 烘进素材里（setpts 后再 fps=30 重采样），这样缓存键能反映调速结果。
 */
async function transcode(gif, cfg, cache, id, speed, log) {
  let stamp = 0;
  try { stamp = Math.round(fs.statSync(gif).mtimeMs); } catch { return { ok: false, error: 'STAT_FAILED' }; }
  const spd = Math.min(2, Math.max(1, Number(speed) || 1));
  const key = `gif-v3-${id}-${stamp}-s${spd.toFixed(2)}`;
  const out = cache.file('sticker', key, '.webm');
  if (fs.existsSync(out) && fs.statSync(out).size > 500) return { ok: true, file: out, cached: true };
  const tmp = `${out}.tmp-${process.pid}-${Date.now()}.webm`;

  // 纯色背景的 GIF（看着像透明，解码后是一整块实色）先抠色，否则叠上去是个方块
  const bg = await detectBackground(gif, cfg, path.dirname(out));
  const vf = [
    ...(bg ? [`colorkey=0x${bg}:0.12:0.02`] : []),
    // 先按 PTS 缩放，再 fps=30 重采样：循环素材的帧率固定，seek 也稳
    ...(spd > 1.0001 ? [`setpts=PTS/${spd.toFixed(4)}`] : []),
    'fps=30',
    'scale=trunc(iw/2)*2:-2:flags=lanczos',
    'format=yuva420p',
  ].join(',');

  const r = await M.run(cfg.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', gif,
    '-vf', vf,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    '-b:v', '0', '-crf', '32', '-an', tmp,
  ], 120000);
  if (r.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 500) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    if (log) log(`表情 ${id} 转码失败：${String(r.err || '').slice(-200)}`);
    return { ok: false, error: 'TRANSCODE_FAILED', detail: String(r.err || '').slice(-300) };
  }
  fs.renameSync(tmp, out);
  return { ok: true, file: out, cached: false };
}

/** 取 GIF 第一帧四角；四角不透明且同色 → 返回 RRGGBB（需要 colorkey）。 */
async function detectBackground(gif, cfg, dir) {
  const tmp = path.join(dir, `.detect-${process.pid}-${Date.now()}.rgba`);
  try {
    const info = await M.probeMedia(cfg.ffmpeg, gif);
    const r = await M.run(cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', gif,
      '-frames:v', '1', '-vf', 'format=rgba', '-f', 'rawvideo', '-pix_fmt', 'rgba', tmp,
    ], 60000);
    if (r.code !== 0 || !fs.existsSync(tmp)) return null;
    const w = info && info.width;
    const h = info && info.height;
    if (!w || !h || w < 8 || h < 8) return null;
    const buf = fs.readFileSync(tmp);
    if (buf.length < w * h * 4) return null;
    const block = (bx, by) => {
      let rr = 0; let gg = 0; let bb = 0; let aa = 0; let n = 0;
      for (let y = by; y < by + 4; y++) {
        for (let x = bx; x < bx + 4; x++) {
          const o = (y * w + x) * 4;
          rr += buf[o]; gg += buf[o + 1]; bb += buf[o + 2]; aa += buf[o + 3]; n++;
        }
      }
      return { r: rr / n, g: gg / n, b: bb / n, a: aa / n };
    };
    const cs = [block(1, 1), block(w - 5, 1), block(1, h - 5), block(w - 5, h - 5)];
    if (!cs.every((c) => c.a >= 250)) return null;
    const same = cs.every((c) => Math.abs(c.r - cs[0].r) <= 16
      && Math.abs(c.g - cs[0].g) <= 16
      && Math.abs(c.b - cs[0].b) <= 16);
    if (!same) return null;
    return [cs[0].r, cs[0].g, cs[0].b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(v)));
}

/**
 * 准备叠加：转码 + 算位置 + 生成 filter。
 * 返回 { inputs, filters, applied, skipped }；inputs 是 [{ file, loop }]，
 * loop=true 时 render 里加 -stream_loop -1（循环到本场结束）。
 * baseLabel 是当前视频标签（如 'vbase'），完成后标签是 'vout'。
 */
async function prepare({ stickers, sceneSeconds, cfg, cache, work, index, baseLabel = 'vbase', inputStart = 2, log }) {
  // 每场最多 1 个（schema 已裁过，这里再兜一层）
  const list = (Array.isArray(stickers) ? stickers : []).slice(0, 1);
  const inputs = [];
  const filters = [];
  const applied = [];
  const skipped = [];
  const H = Number(cfg.height) || 1080;
  const W = Number(cfg.width) || 1920;
  const reserve = Math.max(0, Number(cfg.stickers && cfg.stickers.bottomReservePx)
    || Number(cfg.subtitles && cfg.subtitles.reservedPx) || 200);

  let label = baseLabel;
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    const gif = resolveFile(st.id, cfg);
    if (!gif) { skipped.push({ id: st.id, reason: '文件不存在' }); continue; }
    const gifInfo = await M.probeMedia(cfg.ffmpeg, gif);
    if (!gifInfo || !gifInfo.width || !gifInfo.height) {
      skipped.push({ id: st.id, reason: '无法读取表情尺寸' });
      continue;
    }
    const at = clamp(st.at, 0, Math.max(0, sceneSeconds - 0.25));
    if (sceneSeconds - at < 0.3) { skipped.push({ id: st.id, reason: 'at 太靠后' }); continue; }

    // 一轮 GIF 的时长参考；场景显式给了 duration 就以场景为准，否则用全局 stickerDuration。
    // 只用来调速，不用来截断：表情从 at 开始一直循环到本场结束。
    const wantDuration = Number(st.duration) > 0
      ? Number(st.duration)
      : (Number(cfg.stickerDuration) > 0 ? Number(cfg.stickerDuration) : 2);
    let speed = 1;
    if (gifInfo.duration > wantDuration) speed = Math.min(2, gifInfo.duration / wantDuration);
    speed = Math.round(speed * 100) / 100;

    const tr = await transcode(gif, cfg, cache, st.id, speed, log);
    if (!tr.ok) { skipped.push({ id: st.id, reason: tr.error }); continue; }
    // 转码后的 webm 才是真正要循环的素材：以它的时长/尺寸为准
    const info = await M.probeMedia(cfg.ffmpeg, tr.file);
    if (!info || !(info.duration > 0) || !info.width || !info.height) {
      skipped.push({ id: st.id, reason: '无法读取表情尺寸/时长' });
      continue;
    }
    const loopSec = info.duration;
    const natural = Math.round(loopSec * speed * 100) / 100;

    const scale = clamp(st.scale || (cfg.stickers && cfg.stickers.defaultScale) || 0.3, 0.05, 1);
    let th = Math.max(64, Math.round(H * scale));
    let tw = Math.max(16, Math.round(th * (info.width / info.height)));
    if (tw > W * 0.92) { tw = Math.round(W * 0.92); th = Math.round(tw * (info.height / info.width)); }
    if (th > H * 0.85) { th = Math.round(H * 0.85); tw = Math.round(th * (info.width / info.height)); }

    if (log) {
      log(`表情 ${st.id} 从 ${at.toFixed(2)}s 起循环播放（一轮 ${loopSec.toFixed(2)}s，自然 ${natural.toFixed(2)}s，`
        + `目标 ${wantDuration.toFixed(2)}s，${speed.toFixed(2)}×，直到本场结束）`);
    }

    const x = Math.round(clamp(st.x * (W - tw), 0, Math.max(0, W - tw)));
    const maxY = Math.max(0, H - th - reserve);
    const y = Math.round(clamp(st.y * (H - th), 0, maxY));

    const idx = inputStart + inputs.length;
    inputs.push({ file: tr.file, loop: true });
    const chain = [
      `[${idx}:v]setpts=PTS-STARTPTS`,
      'fps=30',
      `scale=${tw}:${th}:flags=lanczos`,
      `setpts=PTS+${at.toFixed(3)}/TB`,
      'format=yuva420p',
      // 只淡入，不淡出：循环中的每一轮都保持可见
      `fade=t=in:st=${at.toFixed(3)}:d=0.25:alpha=1`,
    ];
    const sLabel = `st${i}`;
    filters.push(`${chain.join(',')}[${sLabel}]`);
    const outLabel = `vst${i}`;
    filters.push(`[${label}][${sLabel}]overlay=x=${x}:y=${y}:enable='gte(t,${at.toFixed(3)})':eof_action=pass[${outLabel}]`);
    label = outLabel;
    applied.push({
      id: st.id, at, scale, x, y, w: tw, h: th, loopSec: Math.round(loopSec * 100) / 100,
      naturalSec: Math.round(natural * 100) / 100,
      wantDuration: Math.round(wantDuration * 100) / 100,
      speed, speedKey: `s${speed.toFixed(2)}`, cached: tr.cached,
    });
  }
  return { inputs, filters, applied, skipped, outLabel: label, changed: applied.length > 0 };
}

module.exports = { fetchCandidates, resolveFile, transcode, prepare };
