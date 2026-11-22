'use strict';
/**
 * stickercard.js -- 表情卡：不画图、不调 manim，只给一段风格底，表情居中循环。
 *
 * 分工：
 *   本文件只产出"纯色/淡渐变底"的视频片段（自然时长 = 场景计划秒数）；
 *   大表情由 render.js 的 composeScene 走 stickers.js 叠加：
 *   at=0、x=y=0.5、scale=0.55（占屏约一半）、从 0 循环到本场结束、只淡入不淡出。
 *
 * 这样表情卡和普通场共用同一套循环播放/字幕/边框/混音链路，不会出现两套表情实现。
 */
const fs = require('node:fs');
const path = require('node:path');
const M = require('./manim');
const T = require('./textcard');
const St = require('./stickers');

/** 表情卡的表情占屏比例：0.55 屏高，居中。 */
const STICKER_CARD_SCALE = 0.55;

/** 风格背景色 → 0xRRGGBB（ffmpeg 认的写法）。 */
function ffColor(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const v = m ? m[1] : fallback;
  return `0x${v.toUpperCase()}`;
}

/**
 * 渲一段表情卡底片：淡渐变底视频，自然时长 = 计划秒数。
 * 返回 { ok, file, naturalSeconds, engine:'sticker' }。
 */
async function renderStickerCard({ scene, style, cfg, work, index, log }) {
  const started = Date.now();
  const list = Array.isArray(scene.stickers) ? scene.stickers.slice(0, 1) : [];
  const st = list[0];
  if (!st || !st.id) {
    return { ok: false, error: 'STICKER_CARD_NO_STICKER', ms: Date.now() - started };
  }
  // 文件不在就别启动 ffmpeg：直接返回错误，让 renderOne 降级文字卡
  if (!St.resolveFile(st.id, cfg)) {
    return { ok: false, error: `STICKER_CARD_FILE_MISSING(${st.id})`, ms: Date.now() - started };
  }

  const W = Number(cfg.width) || 1920;
  const H = Number(cfg.height) || 1080;
  const fps = Number(cfg.fps) || 30;
  const seconds = Math.max(1, Number(scene.seconds) || 4);
  const out = path.join(work, `stickercard-${index}.mp4`);

  // 底色：风格背景 → 强调色 35%（和文字卡同一套渐变终点，整集看起来是一家人）
  const c0 = ffColor(style && style.bg, '101A33');
  const c1 = ffColor(T.gradientEnd(style), '2A5CB3');

  const src = `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:d=${seconds.toFixed(3)}:speed=0.01`;
  const r = await M.run(cfg.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', src,
    '-t', seconds.toFixed(3),
    '-vf', `scale=${W}:${H}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an', out,
  ], 180000);

  const ms = Date.now() - started;
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 500) {
    return { ok: false, error: `STICKER_CARD_RENDER_FAILED: ${String(r.err || '').slice(-300)}`, ms };
  }
  if (log) {
    log(`表情卡底片完成 ${seconds}s（渐变 ${c0}→${c1}，表情 ${st.id} 将由合成阶段按 ${STICKER_CARD_SCALE} 居中循环）`);
  }
  return { ok: true, file: out, naturalSeconds: seconds, engine: 'sticker', ms, stickerId: st.id };
}

module.exports = { renderStickerCard, STICKER_CARD_SCALE };
