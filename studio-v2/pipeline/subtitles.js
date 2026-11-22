'use strict';
/**
 * subtitles.js -- 字幕：按标点断句、单条 ≤20 字、最短 0.8s，生成 srt 并烧进画面。
 *
 * 时间轴不用逐词时间戳：speak 返回的是整句音频，v2 按"字重"把整句时长分给每条字幕。
 * 这样字幕不会跨场，也不需要额外的对账接口；实测中文语速下误差在可接受范围内。
 */
const fs = require('node:fs');
const path = require('node:path');
const M = require('./manim');

const PUNCT = /([，。！？、；：,.!?;:\n]+)/;

function charWeight(ch) {
  if (/[\u3400-\u9fff]/.test(ch)) return 1;
  if (/[a-zA-Z0-9]/.test(ch)) return 0.55;
  if (/\s/.test(ch)) return 0.2;
  return 0.35;
}

function textWeight(s) {
  let n = 0;
  for (const ch of String(s || '')) n += charWeight(ch);
  return Math.max(0.5, n);
}

/** 先按标点切，再把过长的子句按字数硬切，最后贪心合并到 maxChars。 */
function splitPieces(text, maxChars) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const parts = raw.split(PUNCT).filter((p) => p != null && p !== '');
  const merged = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (PUNCT.test(p)) {
      if (merged.length) merged[merged.length - 1] += p;
      else merged.push(p);
    } else {
      let rest = p;
      while (rest.length > maxChars) {
        merged.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      if (rest) merged.push(rest);
    }
  }
  const out = [];
  let cur = '';
  for (const p of merged) {
    const piece = p.trim();
    if (!piece) continue;
    if (!cur) cur = piece;
    else if ((cur + piece).length <= maxChars) cur += piece;
    else { out.push(cur); cur = piece; }
  }
  if (cur) out.push(cur);
  // 去掉开头是标点的条（断句残留），并压到 20 字以内
  return out
    .map((s) => s.replace(/^[，。！？、；：,.!?;:]+/, '').trim())
    .filter(Boolean)
    .map((s) => (s.length > maxChars ? s.slice(0, maxChars) : s));
}

/**
 * 生成这一场的相对字幕条：start/end 都从 0 开始，单位秒。
 * 返回 [{ text, start, end }]。
 */
function buildSceneCues(narration, durationSec, cfg) {
  const sub = (cfg && cfg.subtitles) || {};
  const maxChars = Math.max(6, Number(sub.maxCharsPerCue) || 20);
  const minCue = Math.max(0.2, Number(sub.minCueSec) || 0.8);
  const D = Math.max(0.3, Number(durationSec) || 0);
  let pieces = splitPieces(narration, maxChars);
  if (!pieces.length) return [];

  // 时长不够让每条都显示 minCue 时，合并最短的相邻两条，直到放得下
  while (pieces.length > 1 && D / pieces.length < minCue) {
    let best = 0;
    let bestLen = Infinity;
    for (let i = 0; i < pieces.length - 1; i++) {
      const len = pieces[i].length + pieces[i + 1].length;
      if (len < bestLen) { bestLen = len; best = i; }
    }
    pieces = [
      ...pieces.slice(0, best),
      pieces[best] + pieces[best + 1],
      ...pieces.slice(best + 2),
    ];
  }
  // 合并后可能超上限：超了就硬切一次，但保持条数不增加太多
  const capped = [];
  for (const p of pieces) {
    if (p.length <= maxChars) { capped.push(p); continue; }
    for (let i = 0; i < p.length; i += maxChars) capped.push(p.slice(i, i + maxChars));
  }
  pieces = capped;

  const minTotal = pieces.length * minCue;
  const extra = Math.max(0, D - minTotal);
  const weights = pieces.map(textWeight);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const cues = [];
  let at = 0;
  for (let i = 0; i < pieces.length; i++) {
    const span = minCue + (extra * weights[i]) / sum;
    const last = i === pieces.length - 1;
    const end = last ? D : Math.min(D, at + span);
    cues.push({ text: pieces[i], start: round3(Math.min(at, Math.max(0, D - 0.1))), end: round3(Math.max(at + 0.1, end)) });
    at = end;
  }
  return cues;
}

function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

function fmtSrtTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** cues 的 start/end 可以已经是全局时间；offset 再加一层。 */
function toSrt(cues, offset = 0) {
  const lines = [];
  (cues || []).forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${fmtSrtTime(Number(c.start) + offset)} --> ${fmtSrtTime(Number(c.end) + offset)}`);
    lines.push(String(c.text || '').replace(/\r/g, ''));
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * 整集 srt：每场 cues 是相对时间，按前几场最终时长累加成全局时间。
 * entries: [{ seconds, cues }]
 */
function globalSrt(entries) {
  let offset = 0;
  const all = [];
  for (const e of entries || []) {
    for (const c of (e.cues || [])) {
      all.push({ text: c.text, start: Number(c.start) + offset, end: Number(c.end) + offset });
    }
    offset += Number(e.seconds) || 0;
  }
  return { text: toSrt(all), cues: all, total: offset };
}

function assColor(hex, alpha01) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const rgb = m ? m[1] : 'ffffff';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const a = Math.round(Math.min(1, Math.max(0, alpha01 == null ? 0 : alpha01)) * 255);
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

/** 生成 force_style。字号/边距按 ASS 的 288 高坐标系换算。 */
function forceStyle(sub, videoH) {
  const H = Math.max(120, Number(videoH) || 1080);
  const k = 288 / H;
  const fontPx = Math.max(10, Number(sub.fontSizePx) || 64);
  const assFont = Math.max(6, Math.round(fontPx * k));
  const marginV = Math.max(2, Math.round((Number(sub.marginBottomPx) || 120) * k));
  const marginH = Math.max(2, Math.round((Number(sub.marginSidePx) || 96) * k));
  const outline = Math.max(0, (Number(sub.outlinePx) || 2) * k);
  return [
    `FontName=${sub.fontName || 'Microsoft YaHei'}`,
    `FontSize=${assFont}`,
    `PrimaryColour=${assColor(sub.color || '#FFFFFF', 0)}`,
    `OutlineColour=${assColor(sub.outlineColor || '#000000', 0)}`,
    `BackColour=${assColor(sub.backColor || '#000000', 1 - (Number(sub.backAlpha) || 0.72))}`,
    'BorderStyle=3',
    `Outline=${outline.toFixed(1)}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${marginV}`,
    `MarginL=${marginH}`,
    `MarginR=${marginH}`,
  ].join(',');
}

/** 独立烧字幕（render 里通常直接把 filter 拼进一条命令，这个函数留给重烧/调试）。 */
async function burn({ videoIn, out, cues, cfg, cwd, log }) {
  const work = cwd || path.dirname(out);
  const srt = path.join(work, 'subs.srt');
  fs.writeFileSync(srt, toSrt(cues, 0), 'utf8');
  const vf = `subtitles=subs.srt:force_style='${forceStyle(cfg.subtitles, cfg.height)}'`;
  const r = await M.run(cfg.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', videoIn,
    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-an', out,
  ], 600000, { cwd: work });
  if (log) log(`字幕烧制 ${r.code === 0 ? '完成' : '失败'}`);
  return { ok: r.code === 0, error: r.code === 0 ? null : String(r.err || '').slice(-300) };
}

module.exports = { buildSceneCues, splitPieces, toSrt, globalSrt, forceStyle, burn, fmtSrtTime };
