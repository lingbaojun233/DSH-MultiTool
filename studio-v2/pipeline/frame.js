'use strict';
/**
 * frame.js -- 克莱因蓝边框：#002FA7 14px 外框 + 2px 内线。
 *
 * 只加在 manim / 文字卡上：AI 画面（已关闭）和满幅参考图不加，避免变成"相框"。
 * 这里只产出 filter 片段，由 render.js 拼进同一条 ffmpeg 命令，
 * 不为一个装饰多编码一次。
 */
const crypto = require('node:crypto');

const DEFAULTS = {
  enabled: true,
  color: '#002FA7',
  accent: '#4A6BC4',
  width: 14,
  innerWidth: 2,
  skipEngines: ['aivideo'],
};
const HEX_RE = /^#[0-9a-f]{6}$/i;

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const int = (v, def, min, max) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  return {
    enabled: c.enabled === undefined ? DEFAULTS.enabled : Boolean(c.enabled),
    color: HEX_RE.test(String(c.color || '')) ? String(c.color).toLowerCase() : DEFAULTS.color.toLowerCase(),
    accent: HEX_RE.test(String(c.accent || '')) ? String(c.accent).toLowerCase() : DEFAULTS.accent.toLowerCase(),
    width: int(c.width, DEFAULTS.width, 0, 80),
    innerWidth: int(c.innerWidth, DEFAULTS.innerWidth, 0, 24),
    skipEngines: (Array.isArray(c.skipEngines) ? c.skipEngines : DEFAULTS.skipEngines)
      .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean),
  };
}

function signature(cfg) {
  const f = normalize(cfg);
  return crypto.createHash('sha1')
    .update(JSON.stringify([f.enabled, f.color, f.accent, f.width, f.innerWidth, f.skipEngines]))
    .digest('hex').slice(0, 12);
}

/** 这一场该不该加框；reason 进日志。 */
function decide(cfg, engine, scene) {
  const f = normalize(cfg);
  if (!f.enabled) return { on: false, reason: 'disabled' };
  if (f.width <= 0 && f.innerWidth <= 0) return { on: false, reason: 'zero-width' };
  if (scene && scene.image) return { on: false, reason: 'image' };
  const eng = String(engine || '').toLowerCase();
  if (eng && f.skipEngines.includes(eng)) return { on: false, reason: `engine=${eng}` };
  return { on: true, reason: `engine=${eng || 'unknown'}` };
}

function ffColor(hex) {
  return '0x' + String(hex).replace(/^#/, '').toUpperCase();
}

/** 返回 filter 链（逗号分隔），没有框就返回空串。 */
function filterChain(cfg, engine, scene) {
  const d = decide(cfg, engine, scene);
  if (!d.on) return '';
  const f = normalize(cfg);
  const parts = [];
  if (f.width > 0) {
    parts.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${ffColor(f.color)}@1:t=${f.width}:replace=1`);
  }
  if (f.innerWidth > 0) {
    const inset = f.width;
    parts.push(`drawbox=x=${inset}:y=${inset}:w=iw-${inset * 2}:h=ih-${inset * 2}:color=${ffColor(f.accent)}@1:t=${f.innerWidth}:replace=1`);
  }
  return parts.join(',');
}

module.exports = { normalize, signature, decide, filterChain, DEFAULTS };
