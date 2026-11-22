'use strict';
/**
 * stickers.js -- 表情包叠加。
 *
 * 播放策略（用户实测要求）：从 at 开始完整播一轮 GIF，播完**停在末帧直到本场结束**，
 * 不截断、不淡出。实现是 setpts 平移 + tpad=stop_mode=clone + enable='gte(t,at)'。
 *
 * 位置：x/y 是 0~1 相对坐标，按实际缩放后的尺寸夹取，保证不越界、不压进底部字幕带。
 * 默认 scale=0.3（1080p 下约 324px 高）。
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

/** GIF → 带 alpha 的 webm；按 id+mtime 缓存，避免每场重转。 */
async function transcode(gif, cfg, cache, id, log) {
  let stamp = 0;
  try { stamp = Math.round(fs.statSync(gif).mtimeMs); } catch { return { ok: false, error: 'STAT_FAILED' }; }
  const key = `gif-v2-${id}-${stamp}`;
  const out = cache.file('sticker', key, '.webm');
  if (fs.existsSync(out) && fs.statSync(out).size > 500) return { ok: true, file: out, cached: true };
  const tmp = `${out}.tmp-${process.pid}-${Date.now()}.webm`;

  // 纯色背景的 GIF（看着像透明，解码后是一整块实色）先抠色，否则叠上去是个方块
  const bg = await detectBackground(gif, cfg, path.dirname(out));
  const vf = [
    ...(bg ? [`colorkey=0x${bg}:0.12:0.02`] : []),
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
 * 返回 { inputs, filters, applied, skipped }；inputs 要接在 audio 之后。
 * baseLabel 是当前视频标签（如 'v1'），完成后标签是 'vout'。
 */
async function prepare({ stickers, sceneSeconds, cfg, cache, work, index, baseLabel = 'vbase', inputStart = 2, log }) {
  const list = (Array.isArray(stickers) ? stickers : []).slice(0, 3);
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
    const tr = await transcode(gif, cfg, cache, st.id, log);
    if (!tr.ok) { skipped.push({ id: st.id, reason: tr.error }); continue; }
    const info = await M.probeMedia(cfg.ffmpeg, tr.file);
    if (!info || !(info.duration > 0) || !info.width || !info.height) {
      skipped.push({ id: st.id, reason: '无法读取表情尺寸/时长' });
      continue;
    }
    const at = clamp(st.at, 0, Math.max(0, sceneSeconds - 0.25));
    if (sceneSeconds - at < 0.3) { skipped.push({ id: st.id, reason: 'at 太靠后' }); continue; }

    const scale = clamp(st.scale || (cfg.stickers && cfg.stickers.defaultScale) || 0.3, 0.05, 1);
    let th = Math.max(64, Math.round(H * scale));
    let tw = Math.max(16, Math.round(th * (info.width / info.height)));
    if (tw > W * 0.92) { tw = Math.round(W * 0.92); th = Math.round(tw * (info.height / info.width)); }
    if (th > H * 0.85) { th = Math.round(H * 0.85); tw = Math.round(th * (info.width / info.height)); }

    // 一轮 GIF 的时长；要求"在 duration 内播完一轮"，最多提速 2 倍
    const natural = info.duration;
    let speed = 1;
    if (Number(st.duration) > 0 && natural > Number(st.duration)) {
      speed = Math.min(2, natural / Number(st.duration));
    }
    const playSec = natural / speed;
    const freeze = Math.max(0, sceneSeconds - at - playSec);

    const x = Math.round(clamp(st.x * (W - tw), 0, Math.max(0, W - tw)));
    const maxY = Math.max(0, H - th - reserve);
    const y = Math.round(clamp(st.y * (H - th), 0, maxY));

    const idx = inputStart + inputs.length;
    inputs.push(tr.file);
    const chain = [
      `[${idx}:v]setpts=PTS-STARTPTS`,
      'fps=30',
      `scale=${tw}:${th}:flags=lanczos`,
      `setpts=PTS/${speed}+${at.toFixed(3)}/TB`,
      'format=yuva420p',
    ];
    if (freeze > 0.04) chain.push(`tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)}`);
    const sLabel = `st${i}`;
    filters.push(`${chain.join(',')}[${sLabel}]`);
    const outLabel = `vst${i}`;
    filters.push(`[${label}][${sLabel}]overlay=x=${x}:y=${y}:enable='gte(t,${at.toFixed(3)})':eof_action=pass[${outLabel}]`);
    label = outLabel;
    applied.push({
      id: st.id, at, scale, x, y, w: tw, h: th,
      playSec: Math.round(playSec * 100) / 100,
      freezeSec: Math.round(freeze * 100) / 100,
      speed, cached: tr.cached,
    });
  }
  return { inputs, filters, applied, skipped, outLabel: label, changed: applied.length > 0 };
}

module.exports = { fetchCandidates, resolveFile, prepare, transcode };
